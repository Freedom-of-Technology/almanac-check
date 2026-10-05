// Reads a records file: the almanac's own files, Cloudflare's export, or GoDaddy's export.
//
// The result is plain data the page can show: the domain, what the file says about its name
// servers and DNSSEC, and one entry per name and type with every value the file gives it.
// Nothing here touches the network.

// Splits a line into its data and its comment, ignoring ";" inside quotes (DMARC has them).
function splitComment(line) {
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\') i++;
    else if (c === '"') quoted = !quoted;
    else if (c === ';' && !quoted) return [line.slice(0, i), line.slice(i + 1)];
  }
  return [line, ''];
}

function tokenize(data) {
  return data.match(/"(?:[^"\\]|\\.)*"|[^\s()]+/g) ?? [];
}

export function absolute(name, origin) {
  if (name === '@') return origin;
  if (name.endsWith('.')) return name.slice(0, -1).toLowerCase();
  if (!origin) throw new ZoneError(`the name "${name}" comes before the file says which domain it's for`);
  return `${name}.${origin}`.toLowerCase();
}

const unquote = (t) => t.replace(/^"|"$/g, '').replace(/\\(.)/g, '$1');

export class ZoneError extends Error {
  name = 'ZoneError';
}

// Every value is written the way the live lookup writes it, so the two compare as plain text.
const NORMALIZE = {
  A: (r) => r[0].toLowerCase(),
  AAAA: (r) => r[0].toLowerCase(),
  CNAME: (r, origin) => absolute(r[0], origin),
  NS: (r, origin) => absolute(r[0], origin),
  MX: (r, origin) => `${Number(r[0])} ${absolute(r[1], origin)}`,
  TXT: (r) => r.map(unquote).join(''),
  CAA: (r) => `${Number(r[0])} ${r[1].toLowerCase()} ${unquote(r[2])}`,
  SRV: (r, origin) => `${r.slice(0, 3).map(Number).join(' ')} ${absolute(r[3], origin)}`,
};
export const SUPPORTED_TYPES = Object.keys(NORMALIZE);

const CLASSES = new Set(['IN', 'CH', 'HS']);

export function parseZone(text) {
  const zone = { origin: null, nameservers: [], dnssec: null, records: new Map() };
  const lines = text.split(/\r?\n/);
  let last = null; // the name a line starting with a space belongs to
  let paste = null; // a "; paste:" note waiting for its record
  let note = []; // the notes above the current group of records
  let noteDone = false; // a record has been seen since the notes started

  for (let n = 0; n < lines.length; n++) {
    let [data, comment] = splitComment(lines[n]);

    // The file's own header says which name servers and DNSSEC setting the domain should have.
    const servers = comment.match(/^\s*nameservers:\s*(.+)$/i);
    if (servers) zone.nameservers = servers[1].trim().toLowerCase().split(/\s+/).map((s) => s.replace(/\.$/, ''));
    const dnssec = comment.match(/^\s*DNSSEC:\s*(on|off)\b/i);
    if (dnssec) zone.dnssec = dnssec[1].toLowerCase() === 'on';
    // Cloudflare's export names the domain in a note instead of an $ORIGIN line.
    const domain = !data.trim() && comment.match(/^;?\s*Domain:\s*([A-Za-z0-9.-]+?)\.?\s*$/);
    if (domain && !zone.origin) zone.originFromNote = domain[1].toLowerCase();

    if (!data.trim()) {
      if (!lines[n].trim()) {
        // A blank line ends a group of records and its notes.
        note = [];
        noteDone = false;
        continue;
      }
      // "; paste: <value>" is a long value written out in one piece for copying. It belongs to
      // the record right after it, and must say exactly what that record says.
      const pasteLine = comment.match(/^\s*paste:\s?(.*)$/i);
      if (pasteLine) {
        paste = { value: pasteLine[1].trimEnd(), line: n + 1 };
      } else if (!/^[;\s-]*$/.test(comment) && !/^\s*-{3,}/.test(comment) && !/^\s*[A-Z]+ Records?\s*$/i.test(comment)) {
        // A note about the records below, not a "---- Section ----" line or an export's "; MX Record" heading.
        if (noteDone) {
          note = [];
          noteDone = false;
        }
        note.push(comment.trim());
      }
      continue;
    }

    // A record in parentheses carries on over the following lines.
    while (data.includes('(') && !data.includes(')') && n + 1 < lines.length) {
      const [more, moreComment] = splitComment(lines[++n]);
      data += ` ${more}`;
      comment += ` ${moreComment}`;
    }

    const tokens = tokenize(data);
    if (tokens[0] === '$ORIGIN') {
      zone.origin = absolute(tokens[1], '');
      continue;
    }
    if (tokens[0].startsWith('$')) continue; // $TTL and the like: how long answers are kept isn't compared

    // A line starting with a space belongs to the name above it.
    const startsBlank = /^\s/.test(data);
    const owner = startsBlank ? null : tokens.shift();
    // TTL and class can come in either order, and either can be left out.
    while (/^\d+$/.test(tokens[0]) || CLASSES.has(tokens[0]?.toUpperCase())) tokens.shift();
    const type = tokens.shift()?.toUpperCase();
    if (!type) throw new ZoneError(`line ${n + 1} has a name but no record type`);

    // An export with no $ORIGIN line takes the domain from its SOA record or its "Domain:" note.
    if (!zone.origin && type === 'SOA' && owner?.endsWith('.')) zone.origin = absolute(owner, '');
    if (!zone.origin && zone.originFromNote) zone.origin = zone.originFromNote;
    const name = startsBlank ? last : absolute(owner, zone.origin);
    if (!name) throw new ZoneError(`line ${n + 1} starts with a space but has no name above it`);
    last = name;
    noteDone = true;

    if (type === 'SOA') continue; // the DNS company's own settings record; never restored by hand

    // The domain's own NS records name its DNS company. That's checked against the registry,
    // not as an ordinary record. GoDaddy's export lists them; the almanac files use a header.
    if (type === 'NS' && name === zone.origin) {
      zone.nsRecords ??= [];
      zone.nsRecords.push(absolute(tokens[0], zone.origin));
      continue;
    }

    const key = `${name} ${type}`;
    const entry = zone.records.get(key) ?? {
      name,
      type,
      values: [],
      proxied: false,
      godaddySite: false,
      godaddyExtra: false,
      supported: type in NORMALIZE,
      line: n + 1,
      note: note.join(' '),
      badPaste: [],
    };
    if (/GODADDY EXTRA/.test(entry.note)) entry.godaddyExtra = true;

    // GoDaddy's export (and its records page) writes its website builder's addresses as
    // "WebsiteBuilder Site" instead of numbers.
    if ((type === 'A' || type === 'AAAA') && tokens.join(' ').toLowerCase() === 'websitebuilder site') {
      entry.godaddySite = true;
    } else if (entry.supported) {
      const value = NORMALIZE[type](tokens, zone.origin);
      if (!entry.values.includes(value)) entry.values.push(value);
      if (paste && paste.value !== value) entry.badPaste.push(paste.line);
    } else {
      entry.values.push(tokens.map(unquote).join(' '));
    }
    entry.proxied ||= /cf-proxied:true/.test(comment);
    paste = null;
    zone.records.set(key, entry);
  }

  if (!zone.origin) throw new ZoneError("the file doesn't say which domain it's for (no $ORIGIN line)");
  if (!zone.nameservers.length && zone.nsRecords) zone.nameservers = [...zone.nsRecords].sort();
  delete zone.originFromNote;
  return zone;
}

// ---- Secrets never belong in a records file ----------------------------------------------------

// Things that grant access look like one of these. They go in the password manager instead.
const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{36}|github_pat_\w{50,})/, 'a GitHub token'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'an AWS key'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/, 'a Slack token'],
  [/\b[rs]k_live_[A-Za-z0-9]{16,}/, 'a Stripe key'],
  [/\b(?:password|passwd|pwd|api[ _-]?key|api[ _-]?token|secret|auth(?:orization)?[ _-]?code|recovery[ _-]?code)\s*[:=]\s*\S/i,
    'a password, key or code written out'],
];

export function findSecrets(text) {
  const found = [];
  text.split(/\r?\n/).forEach((line, i) => {
    for (const [pattern, what] of SECRET_PATTERNS) {
      if (pattern.test(line)) found.push({ line: i + 1, what });
    }
  });
  return found;
}

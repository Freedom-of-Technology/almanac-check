// Compares a records file with what's live, and says what needs a look.
//
// The result is plain data: one row per record in the file, plus the domain's name servers
// and DNSSEC. The page turns it into words; nothing here writes to the screen.

import { findSecrets, parseZone } from './zone.js';

// Each row's status. Only the ones in NEEDS_A_LOOK count as problems.
export const STATUS = {
  ok: 'ok', // live matches the file
  different: 'different', // live has other values
  missing: 'missing', // nothing live
  proxied: 'proxied', // Cloudflare answers for it (orange cloud); the name answering is all that can be seen
  godaddySite: 'godaddy-site', // GoDaddy's website builder answers for it
  paste: 'paste', // the file's copy-ready "paste:" note disagrees with its record
  unsupported: 'unsupported', // a record type this page doesn't check yet
  failed: 'failed', // the lookup itself didn't work
};
export const NEEDS_A_LOOK = new Set([STATUS.different, STATUS.missing, STATUS.paste, STATUS.failed]);

const same = (a, b) => a.length === b.length && a.every((v) => b.includes(v));

// Runs `work` over `items` a few at a time, so a long file doesn't fire every question at once.
async function inBatches(items, size, work) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await work(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

async function checkRecord(entry, lookup) {
  const row = {
    name: entry.name,
    type: entry.type,
    line: entry.line,
    note: entry.note,
    godaddyExtra: entry.godaddyExtra,
    file: entry.values,
    live: [],
    ttl: null,
  };
  if (entry.badPaste.length) return { ...row, status: STATUS.paste, pasteLines: entry.badPaste };
  if (!entry.supported) return { ...row, status: STATUS.unsupported };
  try {
    if (entry.proxied || entry.godaddySite) {
      const answers = await lookup.answers(entry.name);
      if (!answers) return { ...row, status: STATUS.missing };
      return { ...row, status: entry.proxied ? STATUS.proxied : STATUS.godaddySite };
    }
    const { values, ttl } = await lookup.records(entry.name, entry.type);
    const status = same(entry.values, values) ? STATUS.ok : values.length ? STATUS.different : STATUS.missing;
    return { ...row, status, live: values, ttl };
  } catch (err) {
    return { ...row, status: STATUS.failed, reason: err.message };
  }
}

async function checkRegistry(zone, lookup) {
  try {
    const live = await lookup.registry(zone.origin);
    const fileServers = [...zone.nameservers].sort();
    return {
      nameservers: {
        file: fileServers,
        live: live.nameservers,
        // A file that doesn't name its name servers has nothing to disagree with.
        status: !fileServers.length || same(fileServers, live.nameservers) ? STATUS.ok : STATUS.different,
      },
      dnssec: {
        file: zone.dnssec,
        live: live.dnssec,
        status: zone.dnssec === null || zone.dnssec === live.dnssec ? STATUS.ok : STATUS.different,
      },
    };
  } catch (err) {
    const failed = { status: STATUS.failed, reason: err.message };
    return {
      nameservers: { ...failed, file: zone.nameservers, live: [] },
      dnssec: { ...failed, file: zone.dnssec, live: null },
    };
  }
}

// `lookup` is what live.js's createLookup() returns.
export async function checkFile(text, lookup) {
  // Refuse a file that may hold a secret before asking anything about it.
  const secrets = findSecrets(text);
  if (secrets.length) return { refused: secrets };

  const zone = parseZone(text);
  const [registry, rows] = await Promise.all([
    checkRegistry(zone, lookup),
    inBatches([...zone.records.values()], 6, (entry) => checkRecord(entry, lookup)),
  ]);
  const problems =
    rows.filter((r) => NEEDS_A_LOOK.has(r.status)).length +
    [registry.nameservers, registry.dnssec].filter((r) => NEEDS_A_LOOK.has(r.status)).length;
  return { domain: zone.origin, ...registry, rows, problems };
}

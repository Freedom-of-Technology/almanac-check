// The page: takes a records file, runs the check, and says what it found in plain words.
// Every bit of text from the file goes in with textContent, never as HTML.

import { checkFile, NEEDS_A_LOOK, STATUS } from './check/compare.js';
import { createLookup } from './check/live.js';
import { ZoneError } from './check/zone.js';

const lookup = createLookup();
const results = document.getElementById('results');

// ---- Building the page's pieces ---------------------------------------------------------------

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === false || value == null) continue;
    if (key === 'class') el.className = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

const LABELS = {
  [STATUS.ok]: 'Matches',
  [STATUS.different]: 'Different',
  [STATUS.missing]: 'Missing',
  [STATUS.proxied]: 'Cloudflare answers',
  [STATUS.godaddySite]: 'GoDaddy website',
  [STATUS.paste]: 'Copy line differs',
  [STATUS.unsupported]: 'Not checked',
  [STATUS.failed]: "Couldn't check",
};

const GUIDE_CHANGED = 'A record was changed or deleted';
const GUIDE_RESTORE = 'Putting everything back';

function badge(status) {
  return h('span', { class: `badge badge-${status}` }, LABELS[status]);
}

function valueList(values, empty = 'Nothing') {
  if (!values.length) return h('p', { class: 'value-none' }, empty);
  return h('ul', { class: 'values' }, values.map((v) => h('li', {}, h('code', {}, v))));
}

function minutes(seconds) {
  const m = Math.max(1, Math.round(seconds / 60));
  return m === 1 ? '1 minute' : `${m} minutes`;
}

// ---- What each problem means, in words ----------------------------------------------------------

function explainRecord(row) {
  const parts = [];
  if (row.note) parts.push(h('p', { class: 'note' }, h('span', { class: 'fo-label' }, 'Note in your file:'), ' ', row.note));
  switch (row.status) {
    case STATUS.different:
      parts.push(
        h('p', {}, `What's live is different from your file. If nobody changed it on purpose, follow your almanac's guide "${GUIDE_CHANGED}" to put it back.`),
        h('div', { class: 'compare' },
          h('div', {}, h('p', { class: 'fo-label' }, 'Your file says'), valueList(row.file)),
          h('div', {}, h('p', { class: 'fo-label' }, 'Live right now'), valueList(row.live))),
      );
      break;
    case STATUS.missing:
      parts.push(
        h('p', {}, `Nothing is live for this record. If nobody removed it on purpose, follow your almanac's guide "${GUIDE_CHANGED}" to put it back.`),
        row.file.length ? h('div', {}, h('p', { class: 'fo-label' }, 'Your file says'), valueList(row.file)) : null,
      );
      break;
    case STATUS.paste:
      parts.push(h('p', {}, `The copy-ready line in your file (line ${row.pasteLines.join(' and ')}, starting "paste:") doesn't say the same as the record under it. Check which one is right with your DNS company, then fix the file so both say the same thing. This record wasn't checked against live yet.`));
      break;
    case STATUS.failed:
      parts.push(h('p', {}, `The lookup didn't work: ${row.reason}. Try again in a minute.`));
      break;
  }
  if ((row.status === STATUS.different || row.status === STATUS.missing) && [...row.file, row.name].some((v) => v.includes('._spfm'))) {
    parts.push(h('p', { class: 'hint' }, 'GoDaddy writes this email record as two: one for your domain, and one whose name ends in "._spfm". ' +
      "That's normal at GoDaddy. If your domain has moved to another DNS company, it has one record there instead, and your file needs updating to match."));
  }
  if (row.status === STATUS.different && row.ttl) {
    parts.push(h('p', { class: 'hint' }, `Just changed it? Lookups can show the old answer for up to ${minutes(row.ttl)}. Check again after that.`));
  }
  if (row.status === STATUS.missing) {
    parts.push(h('p', { class: 'hint' }, 'Just changed it? Lookups can take up to an hour to see a new record. Check again after that.'));
  }
  return parts;
}

function explainNameservers(ns) {
  if (ns.status === STATUS.failed) return [h('p', {}, `The registry lookup didn't work: ${ns.reason}. Try again in a minute.`)];
  return [
    h('p', {}, 'The registry says a different DNS company runs your domain than your file does. ' +
      "If you moved your DNS to another company on purpose, update the name servers line at the top of your file. " +
      `If you didn't, someone may have changed your domain: follow your almanac's guide "${GUIDE_RESTORE}", and get help.`),
    h('div', { class: 'compare' },
      h('div', {}, h('p', { class: 'fo-label' }, 'Your file says'), valueList(ns.file)),
      h('div', {}, h('p', { class: 'fo-label' }, 'The registry says'), valueList(ns.live))),
  ];
}

function explainDnssec(d) {
  if (d.status === STATUS.failed) return [h('p', {}, `The registry lookup didn't work: ${d.reason}. Try again in a minute.`)];
  const word = (on) => (on ? 'on' : 'off');
  return [h('p', {}, `Your file says DNSSEC (a lock on your records that some companies turn on) is ${word(d.file)}, but the registry says it's ${word(d.live)}. ` +
    `If nobody changed it on purpose, follow your almanac's guide "${GUIDE_RESTORE}", and get help.`)];
}

// ---- One file's results -------------------------------------------------------------------------

function problemCard(title, status, body) {
  return h('article', { class: 'problem' },
    h('div', { class: 'problem-head' }, badge(status), h('h4', { class: 'problem-title' }, title)),
    body);
}

function renderResult(fileName, report, again) {
  const section = h('section', { class: 'result', 'aria-label': `Results for ${report.domain}` });
  const time = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const summary = report.problems
    ? `${report.problems} ${report.problems === 1 ? 'thing needs' : 'things need'} a look.`
    : 'Everything in your file matches what is live.';

  section.append(
    h('div', { class: 'result-head' },
      h('div', {},
        h('p', { class: 'fo-label' }, fileName),
        h('h2', { class: 'fo-h2' }, report.domain),
        h('p', { class: `summary${report.problems ? ' summary-problems' : ''}` }, summary),
        h('p', { class: 'hint' }, `Checked at ${time}.`)),
      h('button', { type: 'button', class: 'fo-btn fo-btn-outline' }, 'Check again')),
  );
  section.querySelector('button').addEventListener('click', again);

  // Problems first, each with what to do.
  const problems = [];
  if (NEEDS_A_LOOK.has(report.nameservers.status)) problems.push(problemCard('Which DNS company runs your domain', report.nameservers.status, explainNameservers(report.nameservers)));
  if (NEEDS_A_LOOK.has(report.dnssec.status)) problems.push(problemCard('DNSSEC', report.dnssec.status, explainDnssec(report.dnssec)));
  for (const row of report.rows.filter((r) => NEEDS_A_LOOK.has(r.status))) {
    problems.push(problemCard(`${row.type} record for ${row.name}`, row.status, explainRecord(row)));
  }
  if (problems.length) section.append(h('h3', { class: 'fo-h3' }, 'Needs a look'), h('div', { class: 'problems' }, problems));

  // Then every record, so the owner can see each one was looked at.
  const nsRow = h('tr', {},
    h('td', { 'data-label': 'Status' }, badge(report.nameservers.status)),
    h('td', { 'data-label': 'Name' }, report.domain),
    h('td', { 'data-label': 'Type' }, 'Name servers'),
    h('td', { 'data-label': 'Value' }, report.nameservers.file.length ? report.nameservers.file.join(', ') : h('span', { class: 'value-none' }, '(not in your file)')));
  const rows = report.rows.map((row) => h('tr', {},
    h('td', { 'data-label': 'Status' }, badge(row.status)),
    h('td', { 'data-label': 'Name' }, row.name, row.godaddyExtra ? h('span', { class: 'tag' }, 'GoDaddy added this') : null),
    h('td', { 'data-label': 'Type' }, row.type),
    h('td', { 'data-label': 'Value' }, row.file.length ? row.file.map((v) => h('code', {}, v)) : h('span', { class: 'value-none' }, '(GoDaddy website)'))));
  section.append(
    h('h3', { class: 'fo-h3' }, 'Every record in your file'),
    h('table', { class: 'records' },
      h('thead', {}, h('tr', {}, ['Status', 'Name', 'Type', 'Value in your file'].map((t) => h('th', { scope: 'col' }, t)))),
      h('tbody', {}, nsRow, rows)),
    h('div', { class: 'key' },
      h('p', {}, h('strong', {}, 'Cloudflare answers: '), "the record has Cloudflare's orange cloud on, so Cloudflare answers with its own addresses and where it really points can't be seen from outside. It's there and working."),
      h('p', {}, h('strong', {}, 'GoDaddy website: '), "GoDaddy's website builder answers for it. It's there and working."),
      h('p', {}, h('strong', {}, 'Not checked: '), "names that are live but aren't in your file. Your DNS company's export lists every live record, if you want to compare.")),
  );
  return section;
}

function renderMessage(fileName, title, ...body) {
  return h('section', { class: 'result result-message', role: 'alert' },
    h('p', { class: 'fo-label' }, fileName),
    h('h2', { class: 'fo-h3' }, title),
    body.map((p) => h('p', { class: 'fo-p' }, p)));
}

// ---- Running a check ----------------------------------------------------------------------------

async function check(fileName, text) {
  const slot = h('div', {}, h('p', { class: 'checking' }, `Checking ${fileName}…`));
  const run = async () => {
    let section;
    try {
      const report = await checkFile(text, lookup);
      if (report.refused) {
        const lines = report.refused.map((s) => `line ${s.line} (${s.what})`).join(', ');
        section = renderMessage(fileName, 'This file looks like it holds a secret',
          `Nothing was checked. It looks like there's a secret on ${lines}.`,
          'Passwords, keys and codes belong in your password manager, never in your records file. Move it there, take it out of the file, and contact FreeOT: once a secret has been in the file, it has to be replaced with a new one.');
      } else {
        section = renderResult(fileName, report, () => {
          slot.replaceChildren(h('p', { class: 'checking' }, `Checking ${fileName} again…`));
          run();
        });
      }
    } catch (err) {
      section = err instanceof ZoneError
        ? renderMessage(fileName, "This doesn't look like a records file", `It couldn't be read: ${err.message}.`, 'Choose the file from the dns folder of your almanac, or a file saved from your DNS company.')
        : renderMessage(fileName, 'Something went wrong', `${err.message}. Try again in a minute.`);
    }
    slot.replaceChildren(section);
  };
  results.append(slot);
  await run();
}

async function checkFiles(files) {
  results.replaceChildren();
  for (const file of files) await check(file.name, await file.text());
  results.querySelector('.result')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---- Getting the file in ------------------------------------------------------------------------

const drop = document.getElementById('drop');
const input = document.getElementById('file');
input.addEventListener('change', () => input.files.length && checkFiles([...input.files]));

for (const type of ['dragenter', 'dragover']) {
  drop.addEventListener(type, (e) => {
    e.preventDefault();
    drop.classList.add('dragging');
  });
}
for (const type of ['dragleave', 'drop']) {
  drop.addEventListener(type, (e) => {
    if (type === 'dragleave' && drop.contains(e.relatedTarget)) return;
    drop.classList.remove('dragging');
  });
}
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  const files = [...(e.dataTransfer?.files ?? [])];
  if (files.length) checkFiles(files);
});

const pasteOpen = document.getElementById('paste-open');
const pasteBox = document.getElementById('paste-box');
const paste = document.getElementById('paste');
pasteOpen.addEventListener('click', () => {
  pasteBox.hidden = !pasteBox.hidden;
  pasteOpen.setAttribute('aria-expanded', String(!pasteBox.hidden));
  if (!pasteBox.hidden) paste.focus();
});
document.getElementById('paste-check').addEventListener('click', () => {
  if (!paste.value.trim()) return paste.focus();
  results.replaceChildren();
  check('Pasted text', paste.value).then(() => results.querySelector('.result')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
});

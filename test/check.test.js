// Runs the page's own checking code (site/check/) on records files, against a stand-in for the
// network (fake-internet.js). Nothing here re-creates the code under test.
//
//   node --test

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { checkFile } from '../site/check/compare.js';
import { createLookup } from '../site/check/live.js';
import { fakeInternet } from './fake-internet.js';

const BAKERY = readFileSync(new URL('files/maple-street-bakery.com.zone', import.meta.url), 'utf8');
const GODADDY = readFileSync(new URL('files/godaddy-export.txt', import.meta.url), 'utf8');

const DKIM = 'v=DKIM1; k=rsa; p=MAPLE' + 'a'.repeat(60) + 'BREAD' + 'b'.repeat(150) + 'SCONE' + 'c'.repeat(60);

// What's live for the bakery when nothing has gone wrong.
const bakeryLive = () => ({
  records: {
    'maple-street-bakery.com A': ['104.21.0.10', '172.67.0.10'], // Cloudflare's addresses
    'www.maple-street-bakery.com A': ['104.21.0.10', '172.67.0.10'],
    'maple-street-bakery.com MX': ['5 alt1.aspmx.l.google.com.', '1 aspmx.l.google.com.'],
    'maple-street-bakery.com TXT': ['v=spf1 include:_spf.google.com ~all'],
    'google._domainkey.maple-street-bakery.com TXT': [DKIM],
    '_dmarc.maple-street-bakery.com TXT': ['v=DMARC1; p=none; rua=mailto:owner@maple-street-bakery.com'],
  },
  registry: { 'maple-street-bakery.com': { nameservers: ['ada.ns.cloudflare.com', 'bob.ns.cloudflare.com'] } },
});

async function check(text, internet) {
  const net = fakeInternet(internet);
  const report = await checkFile(text, createLookup({ fetch: net.fetch }));
  return { report, net };
}

const statuses = (report) => Object.fromEntries(report.rows.map((r) => [`${r.name} ${r.type}`, r.status]));
const row = (report, name, type) => report.rows.find((r) => r.name === name && r.type === type);

test('a file that matches what is live shows every record as fine, so an owner is not sent chasing a problem that is not there', async () => {
  const { report } = await check(BAKERY, bakeryLive());
  assert.equal(report.domain, 'maple-street-bakery.com');
  assert.equal(report.problems, 0);
  assert.equal(report.nameservers.status, 'ok');
  assert.equal(report.dnssec.status, 'ok');
  assert.deepEqual(statuses(report), {
    'maple-street-bakery.com A': 'proxied',
    'www.maple-street-bakery.com CNAME': 'proxied',
    'maple-street-bakery.com MX': 'ok',
    'maple-street-bakery.com TXT': 'ok',
    'google._domainkey.maple-street-bakery.com TXT': 'ok', // split into pieces in the file, one value live
    '_dmarc.maple-street-bakery.com TXT': 'ok',
  });
});

test('a record someone changed is reported as different, showing what the file says and what is live', async () => {
  const live = bakeryLive();
  live.records['maple-street-bakery.com TXT'] = ['v=spf1 include:mailer.example -all'];
  const { report } = await check(BAKERY, live);
  const spf = row(report, 'maple-street-bakery.com', 'TXT');
  assert.equal(spf.status, 'different');
  assert.deepEqual(spf.file, ['v=spf1 include:_spf.google.com ~all']);
  assert.deepEqual(spf.live, ['v=spf1 include:mailer.example -all']);
  assert.equal(report.problems, 1);
});

test('one of several email servers going missing is reported, not hidden by the others still being there', async () => {
  const live = bakeryLive();
  live.records['maple-street-bakery.com MX'] = ['1 aspmx.l.google.com.'];
  const { report } = await check(BAKERY, live);
  assert.equal(row(report, 'maple-street-bakery.com', 'MX').status, 'different');
});

test('a record that was deleted is reported missing', async () => {
  const live = bakeryLive();
  delete live.records['_dmarc.maple-street-bakery.com TXT'];
  const { report } = await check(BAKERY, live);
  assert.equal(row(report, '_dmarc.maple-street-bakery.com', 'TXT').status, 'missing');
});

test('a website behind Cloudflare that stops answering is reported missing, even though its real target cannot be seen', async () => {
  const live = bakeryLive();
  delete live.records['www.maple-street-bakery.com A'];
  const { report } = await check(BAKERY, live);
  assert.equal(row(report, 'www.maple-street-bakery.com', 'CNAME').status, 'missing');
});

test('a record replaced by a pointer to another name is reported as different, saying where it now points', async () => {
  const live = bakeryLive();
  delete live.records['google._domainkey.maple-street-bakery.com TXT'];
  live.records['google._domainkey.maple-street-bakery.com CNAME'] = ['dkim.mailer.example.'];
  live.records['dkim.mailer.example TXT'] = ['v=DKIM1; k=rsa; p=SOMEONEELSE'];
  const { report } = await check(BAKERY, live);
  const dkim = row(report, 'google._domainkey.maple-street-bakery.com', 'TXT');
  assert.equal(dkim.status, 'different');
  assert.deepEqual(dkim.live, ['CNAME dkim.mailer.example']);
});

test('a lookup that fails is reported as not checked, never as a missing record the owner would rush to re-add', async () => {
  const { report } = await check(BAKERY, { ...bakeryLive(), broken: new Set(['_dmarc.maple-street-bakery.com TXT']) });
  const dmarc = row(report, '_dmarc.maple-street-bakery.com', 'TXT');
  assert.equal(dmarc.status, 'failed');
  assert.match(dmarc.reason, /couldn't look up _dmarc\.maple-street-bakery\.com/);
});

test("a copy-ready paste: line that no longer matches its record is flagged, so an owner doesn't paste a wrong value", async () => {
  const edited = BAKERY.replace('; paste: v=DKIM1; k=rsa; p=MAPLE', '; paste: v=DKIM1; k=rsa; p=MAPLX');
  const { report } = await check(edited, bakeryLive());
  const dkim = row(report, 'google._domainkey.maple-street-bakery.com', 'TXT');
  assert.equal(dkim.status, 'paste');
  assert.deepEqual(dkim.pasteLines, [23]);
});

test('a file holding a private key is refused before anything about it is sent anywhere', async () => {
  const leaked = BAKERY.replace("; Google's signature on our email.", "; Google's signature on our email.\n; -----BEGIN PRIVATE KEY----- MIIEvQIBADANBgkqhkiG9w0BAQEFAASC");
  const { report, net } = await check(leaked, bakeryLive());
  assert.deepEqual(report.refused, [{ line: 23, what: 'a private key' }]);
  assert.deepEqual(net.asked, []);
});

test('a password written into a note is refused too', async () => {
  const leaked = BAKERY.replace('; Where incoming email goes.', '; Where incoming email goes. Cloudflare password: Rolling-Pin-42');
  const { report } = await check(leaked, bakeryLive());
  assert.deepEqual(report.refused, [{ line: 15, what: 'a password, key or code written out' }]);
});

test('name servers come from the registry, so a lookup service still holding the old ones after a move does not raise a false alarm', async () => {
  const live = bakeryLive();
  live.records['maple-street-bakery.com NS'] = ['ns11.domaincontrol.com.', 'ns12.domaincontrol.com.']; // stale
  const { report, net } = await check(BAKERY, live);
  assert.equal(report.nameservers.status, 'ok');
  assert.ok(net.asked.includes('https://rdap.example-com-registry.test/com/v1/domain/maple-street-bakery.com'));
  assert.ok(!net.asked.some((url) => url.includes('type=NS')));
});

test('name servers at the registry that differ from the file are flagged, since that is how a hijacked domain shows up', async () => {
  const live = bakeryLive();
  live.registry['maple-street-bakery.com'].nameservers = ['ns1.someone-else.example', 'ns2.someone-else.example'];
  const { report } = await check(BAKERY, live);
  assert.equal(report.nameservers.status, 'different');
  assert.deepEqual(report.nameservers.live, ['ns1.someone-else.example', 'ns2.someone-else.example']);
});

test('DNSSEC turned on at the registry when the file says off is flagged', async () => {
  const live = bakeryLive();
  live.registry['maple-street-bakery.com'].dnssec = true;
  const { report } = await check(BAKERY, live);
  assert.equal(report.dnssec.status, 'different');
});

test("GoDaddy's export is read as it comes: its website line, its www line, its own name servers and its split email record", async () => {
  const { report } = await check(GODADDY, {
    records: {
      'harbor-light-cafe.com A': ['76.223.105.230'], // GoDaddy's website builder
      'www.harbor-light-cafe.com CNAME': ['harbor-light-cafe.com.'],
      '_domainconnect.harbor-light-cafe.com CNAME': ['_domainconnect.gd.domaincontrol.com.'],
      'harbor-light-cafe.com MX': ['10 mx1.harbor-light-cafe-mail.example.', '20 mx2.harbor-light-cafe-mail.example.'],
      'harbor-light-cafe.com TXT': ['v=spf1 include:dc-1a2b3c4d5e._spfm.harbor-light-cafe.com ~all'],
      'dc-1a2b3c4d5e._spfm.harbor-light-cafe.com TXT': ['v=spf1 include:harbor-light-cafe-mail.example ~all'],
    },
    registry: { 'harbor-light-cafe.com': { nameservers: ['ns11.domaincontrol.com', 'ns12.domaincontrol.com'] } },
  });
  assert.equal(report.domain, 'harbor-light-cafe.com');
  assert.equal(report.problems, 0);
  assert.deepEqual(report.nameservers.file, ['ns11.domaincontrol.com', 'ns12.domaincontrol.com']);
  assert.equal(report.nameservers.status, 'ok');
  assert.deepEqual(statuses(report), {
    'harbor-light-cafe.com A': 'godaddy-site',
    'www.harbor-light-cafe.com CNAME': 'ok',
    '_domainconnect.harbor-light-cafe.com CNAME': 'ok',
    'harbor-light-cafe.com MX': 'ok',
    'harbor-light-cafe.com TXT': 'ok',
    'dc-1a2b3c4d5e._spfm.harbor-light-cafe.com TXT': 'ok',
  });
  // GoDaddy's "; CNAME Record" headings are not shown to the owner as notes about a record.
  assert.equal(row(report, 'www.harbor-light-cafe.com', 'CNAME').note, '');
});

test("an owner's own note about a record travels with it, so a problem says what the record is for", async () => {
  const live = bakeryLive();
  delete live.records['_dmarc.maple-street-bakery.com TXT'];
  const { report } = await check(BAKERY, live);
  assert.equal(row(report, '_dmarc.maple-street-bakery.com', 'TXT').note, 'What to do with fake email pretending to be from us.');
});

test('a file that is not a records file is turned away with the reason', async () => {
  await assert.rejects(check('Dear Sam, here are the photos from Saturday.\n', bakeryLive()), {
    name: 'ZoneError',
  });
});

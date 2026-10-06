// Runs the command line (cli/check.mjs) the way GitHub's check on an almanac runs it, against a
// stand-in for the network (fake-internet.js, and FakeResolver below for asking a named server).

import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { main } from '../cli/check.mjs';
import { fakeInternet } from './fake-internet.js';

const BAKERY = fileURLToPath(new URL('files/maple-street-bakery.com.zone', import.meta.url));
const BAKERY_TEXT = await readFile(BAKERY, 'utf8');
const DKIM = 'v=DKIM1; k=rsa; p=MAPLE' + 'a'.repeat(60) + 'BREAD' + 'b'.repeat(150) + 'SCONE' + 'c'.repeat(60);

const bakeryLive = () => ({
  records: {
    'maple-street-bakery.com A': ['104.21.0.10', '172.67.0.10'],
    'www.maple-street-bakery.com A': ['104.21.0.10', '172.67.0.10'],
    'maple-street-bakery.com MX': ['5 alt1.aspmx.l.google.com.', '1 aspmx.l.google.com.'],
    'maple-street-bakery.com TXT': ['v=spf1 include:_spf.google.com ~all'],
    'google._domainkey.maple-street-bakery.com TXT': [DKIM],
    '_dmarc.maple-street-bakery.com TXT': ['v=DMARC1; p=none; rua=mailto:owner@maple-street-bakery.com'],
  },
  registry: { 'maple-street-bakery.com': { nameservers: ['ada.ns.cloudflare.com', 'bob.ns.cloudflare.com'] } },
});

async function run(args, internet, options = {}) {
  const net = fakeInternet(internet);
  const out = [];
  const code = await main(args, { fetch: net.fetch, log: (line) => out.push(line), ...options });
  return { code, output: out.join('\n'), net };
}

async function folderWith(files) {
  const dir = await mkdtemp(join(tmpdir(), 'almanac-check-'));
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
  return dir;
}

for (const [name, change, expected] of [
  ['passes when every record matches', () => {}, 0],
  ['fails when someone changed a record', (live) => { live.records['maple-street-bakery.com TXT'] = ['v=spf1 include:mailer.example -all']; }, 1],
]) {
  test(`GitHub's check on an almanac ${name}, so a failed run (and its email) means something really needs a look`, async () => {
    const live = bakeryLive();
    change(live);
    const { code } = await run([BAKERY], live);
    assert.equal(code, expected);
  });
}

test("a records file holding a secret fails GitHub's check", async () => {
  const dir = await folderWith({ 'maple-street-bakery.com.zone': BAKERY_TEXT.replace('; Our website', '; api key: sk9-maple-4471\n; Our website') });
  const { code, output, net } = await run([dir], bakeryLive());
  assert.equal(code, 1);
  assert.match(output, /line \d+ looks like a password, key or code written out/);
  assert.deepEqual(net.asked, []);
});

test("a folder checks every records file in it, so a domain added to an almanac is checked without changing GitHub's check", async () => {
  const cafe = '; nameservers: ada.ns.cloudflare.com bob.ns.cloudflare.com\n$ORIGIN corner-cafe.org.\n@ 300 IN TXT "v=spf1 -all"\n';
  const dir = await folderWith({ 'maple-street-bakery.com.zone': BAKERY_TEXT, 'corner-cafe.org.zone': cafe, 'notes.txt': 'not a records file' });
  const live = bakeryLive();
  live.records['corner-cafe.org TXT'] = ['v=spf1 include:mailer.example -all'];
  live.registry['corner-cafe.org'] = { nameservers: ['ada.ns.cloudflare.com', 'bob.ns.cloudflare.com'] };
  const { code, output } = await run([dir], live);
  assert.equal(code, 1);
  assert.match(output, /^corner-cafe\.org /m);
  assert.match(output, /^maple-street-bakery\.com /m);
  assert.match(output, /DIFFERENT +TXT +@\n +only in file: v=spf1 -all/);
  assert.doesNotMatch(output, /notes\.txt/);
});

// Stands in for node:dns's Resolver: answers only when pointed at a server it knows.
class FakeResolver {
  static servers = {};
  static pointedAt = [];
  setServers([ip]) {
    this.ip = ip;
    FakeResolver.pointedAt.push(ip);
  }
  answer(name, type) {
    const values = FakeResolver.servers[this.ip]?.[`${name} ${type}`];
    if (!values) throw Object.assign(new Error('no data'), { code: 'ENODATA' });
    return values;
  }
  async resolve4(name) { return this.answer(name, 'A'); }
  async resolveMx(name) { return this.answer(name, 'MX'); }
  async resolveTxt(name) { return this.answer(name, 'TXT'); }
}

test("--ns checks a new DNS company's copy before the switch: it asks that server, flags what the copy is missing, and leaves the registry out", async () => {
  const live = bakeryLive();
  live.records['new.ns.example-dns.test A'] = ['198.51.100.53'];
  FakeResolver.pointedAt = [];
  FakeResolver.servers = {
    '198.51.100.53': {
      'maple-street-bakery.com A': ['198.51.100.80'],
      'www.maple-street-bakery.com A': ['198.51.100.80'],
      'maple-street-bakery.com MX': [{ priority: 5, exchange: 'alt1.aspmx.l.google.com' }, { priority: 1, exchange: 'ASPMX.L.GOOGLE.COM' }],
      'maple-street-bakery.com TXT': [['v=spf1 include:_spf.google.com ~all']],
      'google._domainkey.maple-street-bakery.com TXT': [[DKIM.slice(0, 255), DKIM.slice(255)]],
      // No DMARC record: it wasn't copied over.
    },
  };
  const { code, output, net } = await run([BAKERY, '--ns', 'new.ns.example-dns.test'], live, { Resolver: FakeResolver });
  assert.equal(code, 1);
  assert.deepEqual([...new Set(FakeResolver.pointedAt)], ['198.51.100.53']);
  const flagged = output.split('\n').filter((l) => /^ {2}[A-Z]{3,}/.test(l));
  assert.deepEqual(flagged.map((l) => l.trim().split(/\s+/).slice(0, 3).join(' ')), ['MISSING TXT _dmarc']);
  assert.equal(net.asked.some((url) => url.includes('rdap')), false);
});

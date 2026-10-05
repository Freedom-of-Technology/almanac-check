// A stand-in for the network: Google Public DNS over HTTPS, IANA's list of registries, and a
// registry's RDAP service. Each answers in the shape the real service uses (captured from live
// answers), so the page's own code reads them exactly as it reads the real thing.
//
//   const net = fakeInternet({ records: { 'example.com TXT': ['v=spf1 ...'] }, registry: {...} })
//   createLookup({ fetch: net.fetch })
//
// `net.asked` lists every address asked, so a test can check what was (or wasn't) asked.

const TYPE_NUMBERS = { A: 1, NS: 2, CNAME: 5, SOA: 6, MX: 15, TXT: 16, AAAA: 28, SRV: 33, CAA: 257 };

const IANA = {
  services: [
    [['org'], ['https://rdap.example-org-registry.test/rdap/']],
    [['com', 'net'], ['https://rdap.example-com-registry.test/com/v1/']],
  ],
};

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

export function fakeInternet({ records = {}, registry = {}, broken = new Set() } = {}) {
  const asked = [];

  async function fetch(url) {
    asked.push(url);
    const u = new URL(url);

    if (u.hostname === 'dns.google') {
      const name = u.searchParams.get('name').toLowerCase();
      const type = u.searchParams.get('type');
      if (broken.has(`${name} ${type}`)) return json(200, { Status: 2, Question: [{ name: `${name}.`, type: TYPE_NUMBERS[type] }] });
      // A name that points elsewhere (CNAME) answers with the pointer, then the other name's records.
      const pointer = type !== 'CNAME' && records[`${name} CNAME`]?.[0];
      if (pointer) {
        const target = pointer.replace(/\.$/, '');
        return json(200, {
          Status: 0,
          Question: [{ name: `${name}.`, type: TYPE_NUMBERS[type] }],
          Answer: [
            { name: `${name}.`, type: TYPE_NUMBERS.CNAME, TTL: 300, data: pointer },
            ...(records[`${target} ${type}`] ?? []).map((data) => ({ name: `${target}.`, type: TYPE_NUMBERS[type], TTL: 300, data })),
          ],
        });
      }
      const values = records[`${name} ${type}`];
      const known = Object.keys(records).some((k) => k.startsWith(`${name} `));
      if (!values?.length) {
        // No record of this type: Google answers with the zone's settings record under Authority.
        return json(200, {
          Status: known ? 0 : 3,
          Question: [{ name: `${name}.`, type: TYPE_NUMBERS[type] }],
          Authority: [{ name: 'zone.', type: 6, TTL: 1800, data: 'ns.example. dns.example. 1 10000 2400 604800 1800' }],
        });
      }
      return json(200, {
        Status: 0,
        Question: [{ name: `${name}.`, type: TYPE_NUMBERS[type] }],
        Answer: values.map((data) => ({ name: `${name}.`, type: TYPE_NUMBERS[type], TTL: 300, data })),
      });
    }

    if (u.href === 'https://data.iana.org/rdap/dns.json') return json(200, IANA);

    if (u.hostname.startsWith('rdap.')) {
      const domain = decodeURIComponent(u.pathname.split('/domain/')[1]);
      const entry = registry[domain];
      if (!entry) return json(404, { errorCode: 404 });
      return json(200, {
        objectClassName: 'domain',
        ldhName: domain.toUpperCase(),
        nameservers: entry.nameservers.map((ns) => ({ objectClassName: 'nameserver', ldhName: ns.toUpperCase() })),
        secureDNS: { delegationSigned: entry.dnssec ?? false },
      });
    }

    throw new TypeError(`fake internet: nothing at ${url}`);
  }

  return { fetch, asked };
}

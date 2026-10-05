// Asks the internet what's live, the same public questions any browser or mail server asks.
//
// Records come from Google Public DNS over HTTPS. Name servers and DNSSEC come from the
// registry that runs the domain's ending (.com, .org...), through its public RDAP service, found
// from IANA's list:
// the registry is where a name server change actually happens, while an ordinary lookup service
// can keep showing the old name servers for up to two days after a switch.
//
// `fetch` is passed in so tests can stand in for the network.

const TYPE_NUMBERS = { A: 1, NS: 2, CNAME: 5, MX: 15, TXT: 16, AAAA: 28, SRV: 33, CAA: 257 };

const bare = (host) => host.replace(/\.$/, '').toLowerCase();
const unquote = (t) => t.replace(/^"|"$/g, '');

// Writes a live value the way zone.js writes the file's value.
const NORMALIZE = {
  A: (d) => d.toLowerCase(),
  AAAA: (d) => d.toLowerCase(),
  CNAME: bare,
  NS: bare,
  MX: (d) => {
    const [priority, host] = d.split(/\s+/);
    return `${Number(priority)} ${bare(host)}`;
  },
  TXT: (d) => d,
  CAA: (d) => {
    const [flags, tag, ...value] = d.split(/\s+/);
    return `${Number(flags)} ${tag.toLowerCase()} ${unquote(value.join(' '))}`;
  },
  SRV: (d) => {
    const [priority, weight, port, host] = d.split(/\s+/);
    return `${Number(priority)} ${Number(weight)} ${Number(port)} ${bare(host)}`;
  },
};

export class LookupError extends Error {}

export function createLookup({ fetch = globalThis.fetch.bind(globalThis) } = {}) {
  async function getJson(url, what) {
    let response;
    try {
      response = await fetch(url, { headers: { accept: 'application/dns-json, application/rdap+json, application/json' } });
    } catch {
      throw new LookupError(`couldn't reach ${what}`);
    }
    if (response.status === 404) return null;
    if (!response.ok) throw new LookupError(`${what} answered with an error (${response.status})`);
    return response.json();
  }

  // Every value live for one name and type, and how many seconds the answer may be out of date.
  async function records(name, type) {
    const number = TYPE_NUMBERS[type];
    // edns_client_subnet=0.0.0.0/0 keeps Google from passing on which area the question came from.
    const url = `https://dns.google/resolve?name=${encodeURIComponent(name)}&type=${type}&edns_client_subnet=0.0.0.0/0`;
    const answer = await getJson(url, 'Google Public DNS');
    // Status 3 means the name doesn't exist at all; 0 with no matching answers means it has no
    // record of this type. Anything else is the lookup failing, not the record missing.
    if (answer.Status !== 0 && answer.Status !== 3) throw new LookupError(`Google Public DNS couldn't look up ${name} (status ${answer.Status})`);
    const matching = (answer.Answer ?? []).filter((a) => a.type === number && bare(a.name) === bare(name));
    // The name may now point somewhere else instead (a CNAME), in which case the answers belong
    // to that other name. Say where it points, so it shows as different rather than missing.
    const pointer = (answer.Answer ?? []).find((a) => a.type === TYPE_NUMBERS.CNAME && bare(a.name) === bare(name));
    if (!matching.length && pointer && type !== 'CNAME') {
      return { values: [`CNAME ${bare(pointer.data)}`], ttl: pointer.TTL };
    }
    return {
      values: [...new Set(matching.map((a) => NORMALIZE[type](a.data)))],
      ttl: matching.length ? Math.max(...matching.map((a) => a.TTL)) : null,
    };
  }

  // Whether a name answers at all: what a proxied (orange cloud) record or a GoDaddy website
  // record can be checked for, since their real targets are hidden behind the company's addresses.
  async function answers(name) {
    const url = `https://dns.google/resolve?name=${encodeURIComponent(name)}&type=A&edns_client_subnet=0.0.0.0/0`;
    const answer = await getJson(url, 'Google Public DNS');
    if (answer.Status !== 0 && answer.Status !== 3) throw new LookupError(`Google Public DNS couldn't look up ${name} (status ${answer.Status})`);
    return (answer.Answer ?? []).some((a) => a.type === TYPE_NUMBERS.A);
  }

  // IANA's list of which registry runs each domain ending, fetched once per page.
  let registries;
  async function registryFor(domain) {
    registries ??= getJson('https://data.iana.org/rdap/dns.json', "IANA's list of registries").catch((err) => {
      registries = undefined; // try again next time rather than keep the failure
      throw err;
    });
    const { services } = await registries;
    // The longest ending that matches wins (a list could hold both "uk" and "co.uk").
    const labels = domain.split('.');
    for (let i = 1; i < labels.length; i++) {
      const ending = labels.slice(i).join('.');
      const service = services.find(([endings]) => endings.includes(ending));
      if (service) return service[1].find((url) => url.startsWith('https://')) ?? service[1][0];
    }
    throw new LookupError(`no registry for ${domain} is listed by IANA`);
  }

  // The domain's name servers and DNSSEC setting, straight from its registry.
  async function registry(domain) {
    const base = await registryFor(domain);
    const data = await getJson(`${base.replace(/\/?$/, '/')}domain/${encodeURIComponent(domain)}`, 'the registry');
    if (!data) throw new LookupError(`the registry has no record of ${domain}`);
    return {
      nameservers: (data.nameservers ?? []).map((ns) => bare(ns.ldhName)).sort(),
      dnssec: Boolean(data.secureDNS?.delegationSigned),
    };
  }

  return { records, answers, registry };
}

# Almanac Check

A free web page from [FreeOT](https://freedomoftechnology.com) that checks a domain's records
file against what's live on the internet. Business owners drop in the records file from their
almanac (or a file saved from GoDaddy or Cloudflare), and the page says, record by record, whether
it still matches, and what to do when it doesn't.

It lives at **check.freeot.com**.

## Your file stays on your computer

The page runs entirely in the browser. The file is read there and never uploaded. To check it, the
page asks public services the same questions any browser or email server asks:

- **Google Public DNS** (`dns.google`), for each name and record type in the file. It asks Google
  not to pass on which area the question came from.
- **IANA's list of registries** (`data.iana.org`), to find who runs the domain's ending (.com, .org...).
- **That registry's public RDAP service**, for the domain's name servers and DNSSEC setting. The
  registry is where a name server change actually happens; ordinary lookups can show the old ones
  for up to two days after a move.

There's no tracking, no cookies and nothing stored. Before anything is asked, a file that looks like
it holds a secret (a private key, a known token format, or a line like `password: ...`) is refused.

## What it checks

- Every record in the file against live DNS: matches, different (with both values), or missing.
- Records behind Cloudflare's orange cloud, and GoDaddy's "WebsiteBuilder Site" records: these hide
  their real target, so the page checks that the name answers.
- The name servers and DNSSEC setting in the file's header, against the registry.
- Each `; paste:` note (a long value written out in one piece for copying) says exactly what the
  record under it says.

It can't see names that are live but missing from the file. DNS doesn't list a domain's names; the
DNS company's export does.

It reads the almanac's own files, Cloudflare's export, and GoDaddy's export as they come, including
GoDaddy's quirks: `A WebsiteBuilder Site`, `CNAME @`, its SOA and NS lines, and its email record
split into two (`._spfm`).

## Layout

| Path | What it is |
|---|---|
| `site/` | The whole website. Cloudflare Pages serves this folder as it is; there's no build step. |
| `site/check/` | The checking code: `zone.js` reads a records file, `live.js` asks the internet, `compare.js` compares the two. No dependencies. |
| `site/app.js` | The page: getting the file in, and saying what was found in plain words. |
| `site/brand/` | FreeOT's color and font settings, fonts and logos, copied from FreeOT's brand kit. Update them by copying again. |
| `site/_headers` | Security headers Cloudflare Pages adds to every page. |
| `test/` | Tests. They run the code in `site/check/` on made-up records files, with a stand-in for the network. |

## Working on it

Tests need Node 22 or later and nothing else:

    npm test

To try the page, serve `site/` from any local web server, for example:

    python -m http.server 8787 --directory site

GitHub runs the tests on every change (`.github/workflows/test.yml`).

## Publishing

Cloudflare Pages project `almanac-check`, connected to this repo: no build command, output folder
`site`, production branch `main`. Every merge to `main` goes live. The address `check.freeot.com`
is a custom domain on that project; its DNS record is written down in FreeOT's almanac
(`dns/freeot.com.zone`).

Merges reach Cloudflare through its GitHub app, which sees only the repos picked for it: GitHub
organization settings › GitHub Apps › Cloudflare Workers and Pages › Configure › Repository access
must list `almanac-check`. If it doesn't, the Pages project says "This project is disconnected from
your Git account" and merges stop going live, while the build settings still look connected.

## License

The code is under the MIT license (`LICENSE`). The fonts in `site/brand/fonts/` are under the SIL
Open Font License (`OFL.txt` beside each). The FreeOT name and logo belong to FreeOT and aren't
covered by the MIT license.

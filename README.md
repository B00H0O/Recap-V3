# Recap-V3

reCAPTCHA v3 and v3 Enterprise token minter in Node. Real Google Chrome driven over raw CDP;
each mint navigates to the target, the document request is intercepted in the browser, and
`grecaptcha.execute` returns the token.

Runs as a 2captcha-style HTTP pool: send any sitekey + target, get back JSON -
`{success, elapsed, token}`, a 0.9-score token for v3 and v3 Enterprise. Not an offline
engine - every fleet needs a real Chrome.

## Mint a token

```
$ curl "http://localhost:4100/token?sitekey=6L...&target=https://site.com/login&action=verify"
{"success":true,"elapsed":307,"token":"0cAFcWeA7Hcdbe3v9rqX9CaSgAX8..."}

PS> curl.exe "http://localhost:4100/token?sitekey=6L...&target=https://site.com/login&action=verify"
```

## Run

1. Install real Google Chrome (auto-detected, or set `CHROME_BIN`) and Node (only dep: `ws`).
2. `npm install`
3. Create a `.env` (vars in Settings below).
4. `run.bat` - or `node pool-server.mjs`.

API on `http://localhost:4100`; set `PORT` / `HOST` in `.env`. On Linux, each browser is
auto-wrapped in `xvfb-run` (a virtual display) when not headless, with `--no-sandbox` /
`--enable-unsafe-swiftshader` added for root/GPU-less boxes.

## API

### GET /token

Mint. Params in the query string; a POST JSON body and `x-sitekey` / `x-target` / `x-action` /
`x-enterprise` headers also work.

| Field | Required | Description |
|-------|----------|-------------|
| sitekey | yes | reCAPTCHA sitekey |
| target | yes | target page URL - the origin the sitekey is registered to (aliases: `url`, `targetUrl`) |
| action | no | action string for `grecaptcha.execute` (default `verify`) |
| enterprise | no | `1` = enterprise flow |

Errors: 400 missing sitekey or target, 500 mint failed - both as `{"success":false,"error":"..."}`.

### GET /health

`globalBrowsers` = live Chromes; `fleets` = browser and tab counts per (sitekey, target).

### GET /stats

Requests / ok / fail, retries, recycles, watchdog kills, buffer hits, `avgMs`, uptime - plus
per-browser health (uses, tabs, busy tabs, ready, alive, proxy).

### Proxy

`USE_PROXIES=on` (values `on`/`1`/`true`/`yes`; old name `PROXY_MODE`) gives each browser a
proxy via `--proxy-server`. The list comes from `PROXIES` (comma/newline separated) or
`PROXIES_FILE` (default `proxies.txt`); entry forms: `host:port`, `user:pass@host:port`,
`scheme://user:pass@host:port`, `host:port:user:pass`. Round-robin per launch, so a recycled
browser rotates to a fresh exit. The score rides the egress IP's reputation: residential or
mobile exits mint 0.9.

## How it works

For each mint, a tab navigates to the target, but the document request is intercepted
(CDP `Fetch.enable`) and answered with a 1-line page that only loads `api.js?render=SITEKEY`:
the origin is the target's, so the token is valid for it, but the target server is never
contacted. Each browser runs a fresh temp profile - warmed with one discarded priming mint, it
serves its ~0.9 window, then is killed, wiped and relaunched fresh.
`grecaptcha.execute(sitekey, {action})` hands back the token; dwell and mouse movement are not
needed for the score. `enterprise=1` swaps the loader to Google's remote `enterprise.js` and
runs `grecaptcha.enterprise.execute`.

## Settings

All optional; defaults work out of the box. Set via environment or a `.env` file (real env
vars take precedence).

| Var | Default | Description |
|-----|---------|-------------|
| PORT | 4100 | HTTP API port |
| BROWSERS_PER_FLEET | 4 | browsers per (sitekey, target) (alias: BROWSERS); 1 for serial 0.9 on one clean IP |
| TABS_PER_BROWSER | 1 | mint pages per browser (alias: TABS); keep 1 for 0.9 |
| MAX_BROWSERS | 16 | global Chrome ceiling |
| USE_PROXIES | off | on/1/true/yes enables proxy rotation (alias: PROXY_MODE) |
| PROXIES | unset | comma/newline list: host:port \| user:pass@host:port \| scheme://user:pass@host:port \| host:port:user:pass; unset = read PROXIES_FILE (default proxies.txt) |
| RECYCLE_AFTER_MINTS | 9 with USE_PROXIES=on, else 18 | fresh profile (+ proxy exit rotation) after N mints (alias: MINTS_PER_BROWSER) |
| HEADLESS | 0 | 1 = true headless + built-in stealth patch (same score, lighter); 0 = visible window |
| DEBUG | 0 | 1 = full per-request pipeline log (RECV->ACQUIRE->MINT->TOKEN->SEND) |
| ENTERPRISE | 0 | 1 = enterprise flow |

Every other knob has a sane default - see the top of `pool-server.mjs`.

## Scaling

All numbers owner-measured, Aug-Sep 2026.

| Rig | Load | Avg | Result |
|-----|------|-----|--------|
| one box | serial | 307 ms | warm re-execute ~0.3 s |
| one box | 8 parallel | - | 363/min, 0% fail |
| one box | 16 parallel | - | 414/min, 0% fail |
| one box | 24 parallel | - | 507/min, 0% fail |
| one box | score mode + recycle tuning | - | 185/min |
| one box, 5-6 proxy IPs | parallel | - | ~1500-2000/min |

**Verdict: 363-507 mints/min on one box at 0% fail; to go faster, scale with IPs, not
boxes - each proxy IP adds ~340/min.**

Test it yourself (env vars, no flags; both default to `PORT=4101`, so pass `PORT=4100` for a
default pool):

```
$ PORT=4100 C=16 DUR=60000 VERIFY=20 node cpm.mjs   # CPM + sampled scores (defaults: C=16 DUR=30000 VERIFY=all; VERIFY=0 = pure CPM)
$ PORT=4100 N=10 node v3score.mjs                   # one-command score check: mint N tokens, siteverify each (defaults: N=10 CONC=1)
```

## The ceiling

- v3 and v3 Enterprise only. v2 checkbox/image challenges are out of scope.
- Every fleet runs a real Chrome; there is no offline minting path. Density is bounded by
  cores and RAM, not licenses.
- A token is bound to the (sitekey, target) it was minted for; it will not verify on another
  origin.
- Enterprise is chosen at mint time - `enterprise=1` on the request or `ENTERPRISE=1` in the
  env. It swaps the loader to `enterprise.js` and runs `grecaptcha.enterprise.execute`; not a
  post-mint transform.
- Do NOT expose the service publicly: the API has no auth, and anyone who can reach it mints
  through your IPs.

## License

MIT. See LICENSE.

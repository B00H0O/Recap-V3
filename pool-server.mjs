// pool-server.mjs (v3) - MULTI-TARGET, 2captcha-style. Keeps a rotating FRESH-PROFILE FLEET per (sitekey,target),
// created lazily on first request. Send any key/url per request:
//   GET /token?sitekey=6L..&target=https://site/page&action=verify[&enterprise=1]  ->  {token,ms,browser,uses}
//
// Model (clear naming - not "slot/pool"):
//   - Browser = one real Chrome process + a FRESH temp profile (the 0.9 identity/score unit; the recycle unit).
//   - Tab     = a mint page inside a browser (TABS_PER_BROWSER of them). Tabs in one browser SHARE the profile,
//               so they share its 0.9 reputation + burn budget - multi-tab buys cheap concurrency/RAM, not more
//               0.9 mints per profile. Concurrency = browsers x tabs.
//   - Fleet   = the set of browsers serving one (sitekey,target).
// Each browser is warmed (priming mints discarded), serves its ~0.9 window, then recycled (kill+wipe+relaunch).
// HEADLESS=1 = true headless ; HEADLESS=0 = visible window. Linux: auto xvfb-run. Per-IP throughput ~360/min.
//
// Hardened: retry-on-another-tab/browser, watchdog (auto-recycle dead Chrome), recycle-retry w/ backoff, token
// validation, /stats, validated config, optional mint-ahead buffer. Internals exported; listen()/watchdog only
// start when run directly (isMain) so the logic is unit-testable without launching Chrome.
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { connect } from './cdp.mjs';
import { warmPage, executeOn, closePage } from './solve.mjs';
import * as tui from './tui.mjs';

// validated env parsing - a garbage value (e.g. MAX_BROWSERS=abc -> NaN) would silently break the fleet.
const ts = () => new Date().toISOString().slice(11, 23);
const log = (...a) => console.log(ts(), ...a);
function numEnv(name, def, { min = 0, max = Infinity } = {}) {
  const names = Array.isArray(name) ? name : [name];        // accept [newClearName, ...oldAliases] - first one set wins (backward-compat rename)
  let raw, hit = names[0];
  for (const n of names) { if (process.env[n] !== undefined && process.env[n] !== '') { raw = process.env[n]; hit = n; break; } }
  if (raw === undefined || raw === '') return def;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < min || v > max) { console.error(`${ts()} [config] invalid ${hit}="${raw}" (need ${min}..${max}) - using ${def}`); return def; }
  return v;
}
// --- .env loader: KEY=VALUE from ./.env (or ../.env); only fills vars NOT already in the environment ---
function loadDotenv() {
  for (const f of [path.join(process.cwd(), '.env'), path.join(process.cwd(), '..', '.env'), path.join(path.dirname(process.execPath), '.env')]) {
    try { const txt = fs.readFileSync(f, 'utf8'); for (const line of txt.split(/\r?\n/)) { if (/^\s*#/.test(line)) continue; const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && process.env[m[1]] === undefined) { let v = m[2]; v = /^["']/.test(v) ? v.replace(/^["']|["']$/g, '') : v.replace(/\s+#.*$/, '').trim(); process.env[m[1]] = v; } } return; } catch {} // strip inline "# comment" on unquoted values
  }
}
loadDotenv();
const PROXY_MODE = /^(on|1|true|yes)$/i.test(process.env.USE_PROXIES || process.env.PROXY_MODE || ''); // toggle proxies on/off (clear name USE_PROXIES; old PROXY_MODE still works)
const PORT = numEnv('PORT', 4100, { min: 1, max: 65535 });
const BROWSERS_PER_FLEET = numEnv(['BROWSERS', 'BROWSERS_PER_FLEET'], 4, { min: 1 });   // how many real Chrome browsers = concurrency. v3 0.9-mode on ONE clean IP MUST be 1 (serial); with proxies = #IPs
const TABS_PER_BROWSER = numEnv(['TABS', 'TABS_PER_BROWSER'], 1, { min: 1 });        // mint pages per browser. v3 0.9 ALWAYS 1 (concurrent execute() on one profile floors the score to 0.1)
const MAX_BROWSERS = numEnv(['MAX_BROWSERS'], 16, { min: 1 });               // global ceiling on total Chromes
const MINTS_PER_BROWSER = numEnv(['RECYCLE_AFTER_MINTS', 'MINTS_PER_BROWSER'], PROXY_MODE ? 9 : 18, { min: 1 }); // fresh profile (+new exit) after this many mints. proxies -> 9 (recycle rotates exit, every token 0.9); off -> 18 throughput-safe. // default 18 = throughput-safe (MEASURED no-proxy: recycle@18=3228 CPM vs @9=2112, -35%, and score is moot without a proxy). FOR STRICT 0.9 WITH PROXIES set =9: MEASURED (clean residential) score holds 0.9 through mint #9, then 0.7 (#10-22), then 0.1 (#23+) - recycle@9 keeps every token at 0.9 (recycle rotates the exit too). 18 with a proxy = a mix of 0.9 (first 9) + 0.7 - fine for >=0.5 targets.
const WARMUP = numEnv('WARMUP', 1, { min: 0 });                            // MEASURED: only mint #1 is cold (0.3); mint #2 is already at plateau - 1 priming mint suffices
const RETRIES = numEnv('RETRIES', 3, { min: 1 });                          // attempts across tabs/browsers per /token
const TOKEN_DEADLINE = numEnv('TOKEN_DEADLINE', 40000, { min: 5000 });     // hard wall-clock cap on one /token (acquire wait + retries) so a dead pool fails fast instead of hanging
const RECYCLE_RETRIES = numEnv('RECYCLE_RETRIES', 4, { min: 1 });          // relaunch attempts w/ backoff before a browser is declared dead
const WATCHDOG_MS = numEnv('WATCHDOG_MS', 5000, { min: 0 });               // sweep that auto-recycles dead browsers (0=off)
const ROLLING = process.env.ROLLING !== '0';                              // rolling replacement (default ON): launch a fresh browser BEFORE retiring a burned one (no recycle gap; MEASURED +16% mint rate). ROLLING=0 to disable.
const BUFFER_SIZE = numEnv('BUFFER_SIZE', 0, { min: 0 });                  // pre-minted tokens per (key,action); 0=off
const TOKEN_TTL_MS = numEnv('TOKEN_TTL_MS', 60000, { min: 1000 });         // evict buffered tokens older than this (60s, NOT ~100s: a v3 token dies at ~120s and the caller still needs to round-trip it to their backend + Google siteverify - keep a safety margin)
const VIEWPORT_W = numEnv('VIEWPORT_W', 1280, { min: 1 }), VIEWPORT_H = numEnv('VIEWPORT_H', 800, { min: 1 }); // MEASURED 2026-06-15: realistic 1280x800 beats 100x100 on a STRICT key (2captcha-v3 avg 0.56 vs 0.48; burn-controlled) - 100x100 innerWidth is an absurd bot tell (reCAPTCHA fp idx 67 reads the viewport). Score-neutral on lenient keys; never hurts.
const HEADLESS = process.env.HEADLESS === '1';            // HEADLESS=1 hidden | HEADLESS=0 visible window (no off-screen mode)
const DEBUG = process.env.DEBUG === '1' || process.argv.includes('debug'); // DEBUG=1 (or `run.bat debug`) = full per-request pipeline (RECV->ACQUIRE->MINT->TOKEN->SEND)
let DBG_ID = 0;                                           // fallback request id for any launch-time logs
const UA = process.env.UA || `Mozilla/5.0 (${process.platform === 'win32' ? 'Windows NT 10.0; Win64; x64' : process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7' : 'X11; Linux x86_64'}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36`;
const CACHE_DIR = process.env.DISK_CACHE || path.join(os.tmpdir(), 'rev3-shared-cache');
const EXTRA_FLAGS = process.env.EXTRA_FLAGS || '';

// IP ROTATION: per-browser proxy from a rotating PROXIES list - the score lever (a token's score is bound to the
// EGRESS IP; api.js + the recaptcha calls go out via the proxy, so the score reflects the PROXY IP, not the box).
// Entries (comma/newline-separated): host:port | user:pass@host:port | scheme://user:pass@host:port | host:port:user:pass
export function parseProxies(s) {
  return (s || '').split(/[\n,]+/).map((x) => x.trim()).filter(Boolean).map((p) => {
    let m;
    if ((m = p.match(/^(?:(\w+):\/\/)?(?:([^:@\s]+):([^@\s]+)@)?([^:@\s]+):(\d+)$/))) return { server: `${m[1] || 'http'}://${m[4]}:${m[5]}`, username: m[2], password: m[3] };
    if ((m = p.match(/^([^:\s]+):(\d+):([^:\s]+):([^\s]+)$/))) return { server: `http://${m[1]}:${m[2]}`, username: m[3], password: m[4] };
    return null;
  }).filter(Boolean);
}
// proxies load ONLY when PROXY_MODE=on: from PROXIES env, else proxies.txt (CWD then parent). Verified-working list.
function loadProxies() {
  if (!PROXY_MODE) return [];
  let raw = process.env.PROXIES || '';
  if (!raw.trim()) for (const f of [path.join(process.cwd(), process.env.PROXIES_FILE || 'proxies.txt'), path.join(process.cwd(), '..', 'proxies.txt')]) { try { const t = fs.readFileSync(f, 'utf8'); if (t.trim()) { raw = t; break; } } catch {} }
  return parseProxies(raw);
}
const PROXIES = loadProxies();
let proxyIdx = 0;
const proxyFails = new Map();                              // proxy.server -> consecutive LAUNCH-fail count
const proxyCooldown = new Map();                           // proxy.server -> ts until skipped (RECOVERABLE - self-heals; no permanent pool collapse)
const PROXY_DEAD_AFTER = +(process.env.PROXY_DEAD_AFTER || 2); // cool a proxy after this many LAUNCH failures
const PROXY_COOLDOWN_MS = +(process.env.PROXY_COOLDOWN_MS || 120000); // ...then retry it (transient outages recover; prevents the all-proxies-dead death-spiral)
export function pickProxy() {                              // round-robin (rotates IP per launch), skipping exits in cooldown
  if (!PROXIES.length) return null;
  const now = Date.now();
  for (let i = 0; i < PROXIES.length; i++) { const p = PROXIES[proxyIdx++ % PROXIES.length]; if ((proxyCooldown.get(p.server) || 0) <= now) return p; }
  return null;                                             // all in cooldown (rare) -> fail fast; recovers as cooldowns expire
}
function noteProxyFail(p) { if (p && p.server) { const n = (proxyFails.get(p.server) || 0) + 1; proxyFails.set(p.server, n); if (n >= PROXY_DEAD_AFTER) { proxyCooldown.set(p.server, Date.now() + PROXY_COOLDOWN_MS); proxyFails.set(p.server, 0); log(`[proxy] ${p.server} cooled ${Math.round(PROXY_COOLDOWN_MS / 1000)}s after ${n} LAUNCH fails`); } } } // LAUNCH failures only
function noteProxyOk(p) { if (p && p.server) { proxyFails.delete(p.server); proxyCooldown.delete(p.server); } }

// a real reCAPTCHA token is a long, whitespace-free string. Reject junk so we retry instead of returning garbage.
export const looksLikeToken = (t) => typeof t === 'string' && t.length > 100 && !/\s/.test(t);
const stats = { requests: 0, ok: 0, fail: 0, retries: 0, recycles: 0, recycleFails: 0, watchdogKills: 0, bufferHits: 0, bufferStale: 0, started: Date.now(), msSum: 0, msN: 0 };

const FLAGS = [
  '--no-first-run', '--no-default-browser-check', '--disable-blink-features=AutomationControlled',
  '--disable-background-networking', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding', '--disable-hang-monitor', '--disable-sync', '--disable-breakpad',
  '--disable-component-extensions-with-background-pages', '--disable-ipc-flooding-protection', '--metrics-recording-only',
  '--password-store=basic', '--use-mock-keychain', '--no-pings', '--disable-domain-reliability',
  '--disable-features=Translate,BackForwardCache,MediaRouter,OptimizationHints', '--mute-audio',
];
function findChrome() {
  if (process.env.CHROME_BIN && fs.existsSync(process.env.CHROME_BIN)) return process.env.CHROME_BIN;
  const c = [
    path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(process.env['LOCALAPPDATA'] || '', 'Google\\Chrome\\Application\\chrome.exe'),
    '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/usr/bin/chromium-browser',
  ];
  for (const p of c) if (p && fs.existsSync(p)) return p;
  throw new Error('Chrome not found - set CHROME_BIN');
}
const CHROME = findChrome();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitForPort(port, timeout = 25000) { const end = Date.now() + timeout; while (Date.now() < end) { try { await fetch(`http://localhost:${port}/json/version`); return; } catch {} await sleep(250); } throw new Error('CDP not up on ' + port); }
function killTree(proc) { if (!proc || proc.killed) return; try { if (process.platform === 'win32') spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); else proc.kill('SIGKILL'); } catch {} }

let portCounter = 9400, globalBrowsers = 0;
export class Browser {
  constructor(id, opts) { this.id = id; this.opts = opts; this.proc = null; this.cdp = null; this.tabs = []; this.dir = null; this.port = 0; this.uses = 0; this.bad = null; this.recycling = false; this.dead = false; this.ready = false; this.lastUsed = 0; this.proxy = null; this.retiring = false; this.log = DEBUG ? (msg) => tui.step(true, DBG_ID, `W${this.id}`, 'MINT', msg) : () => {}; } // DEBUG: surface internal mint steps (page-load/grecaptcha-ready/execute)
  alive() { return !!this.proc && !this.proc.killed && !!this.cdp && !this.cdp.closed; }
  async close() {                                        // kill+wipe WITHOUT relaunch (used by rolling replacement)
    this.ready = false; this.retiring = true;
    for (const t of this.tabs) { try { await closePage(this.cdp, t.sessionId, t.targetId); } catch {} }
    try { this.cdp && this.cdp.close(); } catch {}
    killTree(this.proc); try { fs.rmSync(this.dir, { recursive: true, force: true }); } catch {}
  }
  idleTab() { return this.tabs.find((t) => !t.busy); }
  busyTabs() { return this.tabs.filter((t) => t.busy).length; }
  async launch() {
    this.ready = false; this.uses = 0; this.tabs = []; this.port = portCounter++;
    this.proxy = pickProxy(); // rotate egress IP on each (re)launch
    if (PROXY_MODE && !this.proxy) throw new Error(PROXIES.length ? 'all proxies dead/blacklisted - refusing box-IP fallback (PROXY_MODE=on)' : 'USE_PROXIES=on but the proxy pool is empty - put proxies in proxies.txt next to the exe (one per line) or set USE_PROXIES=off'); // fail fast (chosen policy): v3 on the box IP = 0.1 garbage, so error instead of silently serving. Empty pool used to slip past this and mint on the box IP silently.
    this.dir = path.join(os.tmpdir(), `rev3-${this.port}-${process.pid}`);
    const args = [`--remote-debugging-port=${this.port}`, `--user-data-dir=${this.dir}`, `--disk-cache-dir=${CACHE_DIR}`, `--window-size=${VIEWPORT_W},${VIEWPORT_H}`, ...FLAGS];
    if (HEADLESS) args.push('--headless=new', `--user-agent=${UA}`);   // else: a normal visible Chrome window
    if (process.platform === 'linux') args.push('--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader'); // root needs --no-sandbox; GPU-less box needs swiftshader + /dev/shm workaround
    if (this.proxy) args.push(`--proxy-server=${this.proxy.server}`); // route this browser's traffic via its proxy IP
    if (EXTRA_FLAGS) args.push(...EXTRA_FLAGS.split(/\s+/).filter(Boolean));
    args.push('about:blank');                              // start on a blank tab, not Chrome's "New Tab" page
    // Linux: HEADLESS=1 runs headless directly; otherwise wrap in xvfb-run for a virtual display (headful).
    this.proc = (process.platform === 'linux' && !HEADLESS) ? spawn('xvfb-run', ['-a', CHROME, ...args], { stdio: 'ignore' }) : spawn(CHROME, args, { stdio: 'ignore' });
    await waitForPort(this.port);
    this.cdp = await connect(`http://localhost:${this.port}`);
    const pa = this.proxy && this.proxy.username ? { username: this.proxy.username, password: this.proxy.password } : null;
    const first = await warmPage(this.cdp, { ...this.opts, proxyAuth: pa, reuseInitialTab: true, log: this.log }); // tab 0 FIRST (sequentially): claims the launch about:blank tab before sibling createTargets race for it
    const rest = await Promise.all(Array.from({ length: TABS_PER_BROWSER - 1 }, () => warmPage(this.cdp, { ...this.opts, proxyAuth: pa }))); // remaining tabs in parallel, each its own intercepted page
    this.tabs = [first, ...rest].map((p) => ({ sessionId: p.sessionId, targetId: p.targetId, busy: false }));
    for (let i = 0; i < WARMUP; i++) { try { await executeOn(this.cdp, this.tabs[0].sessionId, this.opts); } catch {} } // prime the profile (shared by all tabs)
    this.bad = null; this.ready = true;
  }
  async mintOn(tab, action) {                            // tab is reserved (busy=true) by the caller; released here
    try {
      const t = await executeOn(this.cdp, tab.sessionId, { ...this.opts, action, log: this.log });
      if (!looksLikeToken(t)) throw new Error('bad token: ' + JSON.stringify(String(t).slice(0, 30)));
      this.uses++; this.lastUsed = Date.now(); noteProxyOk(this.proxy); return t; // this exit works -> clear blacklist count
    } finally { tab.busy = false; }
  }
  markBad(why) { if (this.bad || this.recycling) return; this.bad = why || 'bad'; this.ready = false; this.recycle().catch(() => {}); }
  async recycle() {                                      // relaunch the whole browser (fresh profile + all tabs) w/ backoff
    if (this.recycling) return; this.recycling = true; this.ready = false;
    for (const t of this.tabs) { try { await closePage(this.cdp, t.sessionId, t.targetId); } catch {} }
    try { this.cdp && this.cdp.close(); } catch {}
    killTree(this.proc); await sleep(300);
    try { fs.rmSync(this.dir, { recursive: true, force: true }); } catch {}
    let err;
    for (let a = 0; a < RECYCLE_RETRIES; a++) {
      try { await this.launch(); this.bad = null; this.recycling = false; stats.recycles++; return; }
      catch (e) { err = e; killTree(this.proc); await sleep(500 * (a + 1)); }
    }
    this.recycling = false; this.dead = true; this.bad = 'relaunch failed: ' + (err && err.message); stats.recycleFails++;
  }
}
export class Fleet {
  constructor(opts) { this.opts = opts; this.browsers = []; }
  pruneDead() { this.browsers = this.browsers.filter((b) => { if (b.dead) { globalBrowsers = Math.max(0, globalBrowsers - 1); return false; } return true; }); }
  // returns {browser, tab} with the tab RESERVED (busy=true), or grows the fleet, or waits.
  async acquire(deadline = Date.now() + 40000) {
    while (Date.now() < deadline) {
      this.pruneDead();
      for (const b of this.browsers) { if (b.ready && !b.bad && !b.retiring && b.alive()) { const tab = b.idleTab(); if (tab) { tab.busy = true; return { browser: b, tab }; } } }
      const live = this.browsers.filter((b) => !b.retiring).length;
      if (live < BROWSERS_PER_FLEET && globalBrowsers < MAX_BROWSERS) {
        globalBrowsers++; const b = new Browser(globalBrowsers, this.opts); this.browsers.push(b);
        try { await b.launch(); } catch (e) { noteProxyFail(b.proxy); this.browsers = this.browsers.filter((x) => x !== b); globalBrowsers--; throw e; } // launch failed -> count against its proxy (dead-exit detection)
        const tab = b.idleTab(); if (tab) { tab.busy = true; return { browser: b, tab }; }
      }
      await sleep(25);
    }
    throw new Error('no tab available within deadline (pool saturated or all proxies dead - raise MAX_BROWSERS/BROWSERS_PER_FLEET/TABS_PER_BROWSER, or check proxies)');
  }
  // ROLLING REPLACEMENT: launch a fresh browser, THEN retire the burned one - no capacity gap (vs recycle-in-place).
  async rollReplace(old) {
    if (old.retiring) return; old.retiring = true; old.ready = false; // stop new work; old stays alive until replacement is up
    globalBrowsers++; const nb = new Browser(globalBrowsers, this.opts); this.browsers.push(nb);
    let launched = false;
    try { await nb.launch(); launched = true; } catch (e) { noteProxyFail(nb.proxy); this.browsers = this.browsers.filter((x) => x !== nb); globalBrowsers--; }
    if (!launched) { old.retiring = false; old.ready = !old.bad; return; } // FIX: replacement failed -> keep `old` (no capacity loss); next mint retries the roll
    const drainEnd = Date.now() + 30000;                  // FIX: drain in-flight tabs before closing (no-op at TABS=1; safe for multi-tab)
    while (old.busyTabs() > 0 && Date.now() < drainEnd) await sleep(100);
    this.browsers = this.browsers.filter((x) => x !== old); globalBrowsers = Math.max(0, globalBrowsers - 1);
    try { await old.close(); } catch {}
    stats.recycles++;                                     // count rolling replacements too (was only counted in recycle())
  }
}
const fleets = new Map();
const keyOf = (o) => `${o.enterprise ? 'e:' : ''}${o.sitekey}|${o.targetUrl}`;
function fleetFor(opts) { const k = keyOf(opts); let f = fleets.get(k); if (!f) { f = new Fleet(opts); fleets.set(k, f); } return f; }

// try up to `tries` tabs (across browsers); on error mark that browser bad (-> background recycle) and try another.
export async function serveWithRetry(fleet, action, tries = RETRIES) {
  const deadline = Date.now() + TOKEN_DEADLINE;             // bound the whole /token (acquire waits + retries) - never hang on a dead pool
  let lastErr;
  for (let i = 0; i < tries && Date.now() < deadline; i++) {
    let h;
    try { h = await fleet.acquire(deadline); } catch (e) { lastErr = e; break; } // no capacity - retrying won't help
    try { return { browser: h.browser, token: await h.browser.mintOn(h.tab, action) }; }
    catch (e) { lastErr = e; stats.retries++; h.browser.markBad('serve error: ' + e.message); } // mint failed: recycle the browser (fresh profile = good for v3 score) - do NOT blacklist the proxy (mint fails aren't proof the exit is bad; blacklisting caused the pool-collapse death-spiral)
  }
  throw lastErr || new Error('serve failed');
}

// mint-ahead buffer (keyed by sitekey,target,action; action-specific because a v3 token is action-bound).
export class TokenBuffer {
  constructor(size = BUFFER_SIZE, ttl = TOKEN_TTL_MS) { this.size = size; this.ttl = ttl; this.items = []; this.filling = false; }
  put(token, now) { this.items.push({ token, ts: now }); }
  take(now) { while (this.items.length) { const it = this.items.shift(); if (now - it.ts < this.ttl) return it.token; stats.bufferStale++; } return null; }
  fresh(now) { let n = 0; for (const it of this.items) if (now - it.ts < this.ttl) n++; return n; }
}
const buffers = new Map();
export function bufFor(fleet, action) { const k = keyOf(fleet.opts) + '::' + action; let b = buffers.get(k); if (!b) { b = new TokenBuffer(); buffers.set(k, b); } return b; }
export async function fillBuffer(fleet, action, buf) {   // top up to size on idle tabs only (never grows the fleet)
  if (buf.size <= 0 || buf.filling) return; buf.filling = true;
  try {
    while (buf.fresh(Date.now()) < buf.size) {
      let h = null;
      for (const b of fleet.browsers) { if (b.ready && !b.bad && !b.retiring && b.alive()) { const tab = b.idleTab(); if (tab) { tab.busy = true; h = { browser: b, tab }; break; } } }
      if (!h) break;
      try { const t = await h.browser.mintOn(h.tab, action); buf.put(t, Date.now()); if (h.browser.uses >= MINTS_PER_BROWSER) h.browser.recycle().catch(() => {}); }
      catch (e) { h.browser.markBad('fill: ' + e.message); }
    }
  } finally { buf.filling = false; }
}

// recycle any browser whose Chrome/CDP died; drop dead browsers so they free a global slot.
export function watchdog() {
  for (const f of fleets.values()) {
    for (const b of f.browsers) {
      if (b.dead || b.recycling || b.retiring || b.busyTabs() > 0) continue;
      if (b.ready && !b.alive()) { stats.watchdogKills++; b.markBad('watchdog: chrome/cdp dead'); }
    }
    f.pruneDead();
  }
}

function readBody(req, limit = 1 << 20) {                    // collect a POST body (JSON), capped at 1MB
  return new Promise((resolve, reject) => {
    let data = '', size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { req.destroy(); reject(new Error('body too large')); } else data += c; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
const cleanErr = (e) => (String(e?.message || e).split('\n')[0].trim().replace(/\s+/g, ' ').slice(0, 300)) || 'error'; // one line, no stack/paths, capped - what leaves the API stays clean
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  res.setHeader('content-type', 'application/json');
  if (u.pathname === '/health') { res.end(JSON.stringify({ ok: true, globalBrowsers, fleets: [...fleets.entries()].map(([k, f]) => ({ key: k, browsers: f.browsers.length, tabs: f.browsers.reduce((n, b) => n + b.tabs.length, 0) })) })); return; }
  if (u.pathname === '/stats') {
    res.end(JSON.stringify({
      ...stats, avgMs: stats.msN ? Math.round(stats.msSum / stats.msN) : 0, uptimeS: Math.round((Date.now() - stats.started) / 1000), globalBrowsers,
      fleets: [...fleets.entries()].map(([k, f]) => ({ key: k, browsers: f.browsers.map((b) => ({ id: b.id, uses: b.uses, tabs: b.tabs.length, busyTabs: b.busyTabs(), ready: b.ready, bad: b.bad, recycling: b.recycling, alive: b.alive(), proxy: b.proxy ? b.proxy.server : null })) })),
    }));
    return;
  }
  if (u.pathname !== '/token' && u.pathname !== '/') { res.statusCode = 404; res.end('{"success":false,"error":"use /token?sitekey=&target="}'); return; }
  // params from JSON body (POST), x-* headers, or ?query - in that priority
  let body = {};
  if (req.method === 'POST') { try { const raw = await readBody(req); body = raw ? JSON.parse(raw) : {}; } catch { body = {}; } }
  const h = req.headers;
  const sitekey = body.sitekey || h['x-sitekey'] || u.searchParams.get('sitekey');
  const targetUrl = body.target || body.url || body.targetUrl || h['x-target'] || h['x-url'] || u.searchParams.get('target') || u.searchParams.get('targetUrl');
  const action = body.action || h['x-action'] || u.searchParams.get('action') || 'verify';
  const enterprise = body.enterprise === true || body.enterprise === '1' || h['x-enterprise'] === '1' || u.searchParams.get('enterprise') === '1';
  if (!sitekey || !targetUrl) { res.statusCode = 400; res.end('{"success":false,"error":"sitekey and target are required"}'); return; }
  const id = tui.nextId(); DBG_ID = id;
  tui.step(DEBUG, id, '', 'RECV', `${(targetUrl || '').slice(0, 40)} | ${(sitekey || '').slice(0, 18)} | ${action}${enterprise ? ' (ent)' : ''}`);
  const t0 = Date.now(); stats.requests++;
  try {
    const fleet = fleetFor({ sitekey, targetUrl, enterprise });
    if (BUFFER_SIZE > 0) {
      const buf = bufFor(fleet, action);
      const tok = buf.take(Date.now());
      if (tok) { const ms = Date.now() - t0; stats.ok++; stats.bufferHits++; stats.msSum += ms; stats.msN++; res.end(JSON.stringify({ success: true, elapsed: ms, token: tok })); tui.result({ debug: DEBUG, id, label: 'buf', ok: true, ms, token: tok, tag: 'buffered' }); fillBuffer(fleet, action, buf).catch(() => {}); return; }
    }
    tui.step(DEBUG, id, '', 'ACQUIRE', 'browser/tab');
    const { browser, token } = await serveWithRetry(fleet, action);
    const ms = Date.now() - t0; stats.ok++; stats.msSum += ms; stats.msN++;
    tui.step(DEBUG, id, `W${browser.id}`, 'TOKEN', `len ${token.length} | uses ${browser.uses}`);
    res.end(JSON.stringify({ success: true, elapsed: ms, token }));
    tui.result({ debug: DEBUG, id, label: `W${browser.id}`, ok: true, ms, token });
    if (browser.uses >= MINTS_PER_BROWSER) (ROLLING ? fleet.rollReplace(browser) : browser.recycle()).catch((e) => log(`[browser ${browser.id}] recycle err`, e.message));
    if (BUFFER_SIZE > 0) fillBuffer(fleet, action, bufFor(fleet, action)).catch(() => {});
  } catch (e) { const ms = Date.now() - t0; stats.fail++; res.statusCode = 500; const msg = cleanErr(e); res.end(JSON.stringify({ success: false, error: msg, elapsed: ms })); tui.result({ debug: DEBUG, id, label: 'W-', ok: false, ms, err: msg }); }
});
process.on('SIGINT', () => { for (const f of fleets.values()) for (const b of f.browsers) killTree(b.proc); process.exit(0); });
process.on('SIGTERM', () => { for (const f of fleets.values()) for (const b of f.browsers) killTree(b.proc); process.exit(0); });

const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href || process.argv[1] === process.execPath; // 2nd clause: also main when the script is embedded in the running process itself (argv[1] = the process path, not a separate script file)
if (isMain) {
  server.on('error', (e) => { // a raw EADDRINUSE stack trace doesn't say WHAT holds the port - this message tells the operator what to do
    if (e.code === 'EADDRINUSE') { console.error(`${ts()} [fatal] port ${PORT} is already in use. Free it (netstat -ano | findstr :${PORT}) or set a different PORT in .env.`); process.exit(1); }
    throw e;
  });
  if (WATCHDOG_MS > 0) { const t = setInterval(watchdog, WATCHDOG_MS); if (t.unref) t.unref(); }
  server.listen(PORT, process.env.HOST || undefined, () => { // HOST unset = all interfaces (family default); HOST=127.0.0.1 locks it to local-only (recommended: the API has no auth)
    const cfg = `Browsers: ${BROWSERS_PER_FLEET} | Tabs: ${TABS_PER_BROWSER} | Recycle@${MINTS_PER_BROWSER} | Proxies: ${PROXY_MODE ? `On (${PROXIES.length})` : 'Off'} | Headless: ${HEADLESS ? 'On' : 'Off'}${BUFFER_SIZE ? ` | Buffer: ${BUFFER_SIZE}` : ''}`;
    tui.printBanner({ port: PORT, cfg, debug: DEBUG });
  });
}
export { fleets, stats };

// HTTP /token service: a warm pool of intercepted Chrome tabs (raw CDP) mints v3 tokens on demand.
// Your bots call:  GET /token?sitekey=6L..&target=https://site/page&action=verify[&enterprise=1]
//   -> { "token": "...", "ms": 530 }
// Warm pages are kept per (sitekey,target) and reused (re-execute, no re-nav) -> ~0.5s/token when warm.
// Setup: launch a real Chrome first:  chrome.exe --remote-debugging-port=9333 --user-data-dir="C:\path\profile"
// Run:   CONNECT=http://localhost:9333 PORT=4100 MAX_PAGES=6 node server.mjs
import http from 'node:http';
import { connect } from './cdp.mjs';
import { warmPage, executeOn, closePage } from './solve.mjs';

const PORT = +(process.env.PORT || 4100);
const BROWSER = process.env.CONNECT || 'http://localhost:9333';
const MAX_PAGES = +(process.env.MAX_PAGES || 6); // warm pages per (sitekey,target); rate plateaus ~6

const cdp = await connect(BROWSER);
console.log('connected to', cdp.version.Browser);

const pools = new Map(); // key -> { pages:[{sessionId,targetId,busy}], opts, waiters:[] }
const keyOf = (o) => `${o.enterprise ? 'e:' : ''}${o.sitekey}|${o.targetUrl}`;

async function acquire(opts) {
  const k = keyOf(opts);
  let pool = pools.get(k);
  if (!pool) { pool = { pages: [], opts, waiters: [] }; pools.set(k, pool); }
  const idle = pool.pages.find((p) => !p.busy && p.sessionId);
  if (idle) { idle.busy = true; return { pool, pg: idle }; }
  if (pool.pages.length < MAX_PAGES) {
    const pg = { busy: true, sessionId: null, targetId: null };
    pool.pages.push(pg);
    try { const w = await warmPage(cdp, opts); pg.targetId = w.targetId; pg.sessionId = w.sessionId; }
    catch (e) { pool.pages = pool.pages.filter((p) => p !== pg); throw e; }
    return { pool, pg };
  }
  await new Promise((res) => pool.waiters.push(res));
  return acquire(opts);
}
function release(pool, pg) { pg.busy = false; const w = pool.waiters.shift(); if (w) w(); }

async function getToken(opts) {
  const { pool, pg } = await acquire(opts);
  try {
    return await executeOn(cdp, pg.sessionId, opts);
  } catch (e) {
    try { await closePage(cdp, pg.sessionId, pg.targetId); } catch {}
    pool.pages = pool.pages.filter((p) => p !== pg);
    const w = pool.waiters.shift(); if (w) w();
    throw e;
  } finally {
    if (pool.pages.includes(pg)) release(pool, pg);
  }
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  res.setHeader('content-type', 'application/json');
  if (u.pathname === '/health') { res.end(JSON.stringify({ ok: true, pools: [...pools.entries()].map(([k, p]) => ({ key: k, pages: p.pages.length })) })); return; }
  if (u.pathname !== '/token') { res.statusCode = 404; res.end('{"error":"use /token?sitekey=&target=&action="}'); return; }
  const sitekey = u.searchParams.get('sitekey');
  const targetUrl = u.searchParams.get('target') || u.searchParams.get('targetUrl');
  const action = u.searchParams.get('action') || 'verify';
  const enterprise = u.searchParams.get('enterprise') === '1';
  if (!sitekey || !targetUrl) { res.statusCode = 400; res.end('{"error":"sitekey & target required"}'); return; }
  const t0 = Date.now();
  try {
    const token = await getToken({ sitekey, targetUrl, action, enterprise });
    res.end(JSON.stringify({ token, ms: Date.now() - t0 }));
  } catch (e) {
    res.statusCode = 500; res.end(JSON.stringify({ error: String(e?.message || e), ms: Date.now() - t0 }));
  }
});
server.listen(PORT, () => console.log(`/token on http://localhost:${PORT}  (MAX_PAGES=${MAX_PAGES}/pool, browser=${BROWSER})`));

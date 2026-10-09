// v3 CPM + SCORE load test. Runs C concurrent minters for DUR, reports CPM, per-token score, and a score distribution.
//   PORT=4101 C=16 DUR=30000 VERIFY=all node cpm.mjs
//   VERIFY=all  -> siteverify + print EVERY token's score (use at moderate C)
//   VERIFY=0    -> no scoring, pure throughput (use for MAX-CPM, high C)
//   VERIFY=20   -> siteverify 1 in every 20 (sample the score at high C without hammering the verify endpoint)
const PORT = +(process.env.PORT || 4101), HOST = process.env.HOST || '127.0.0.1'; // 4101 default avoids the pool server's own default PORT=4100 - pass PORT=4100 to target it
const C = +(process.env.C || 16), DUR = +(process.env.DUR || 30000);
const VR = String(process.env.VERIFY ?? 'all').toLowerCase();
const vEvery = VR === 'all' ? 1 : (VR === '0' || VR === 'off' || VR === 'no') ? 0 : Math.max(1, +VR || 0);
const ZN = { sk: '6Le0xVgUAAAAAIt20XEB4rVhYOODgTl00d8juDob', tgt: 'https://lessons.zennolab.com/captchas/recaptcha/v3.php?level=beta', act: 'verify' };
const TURL = `http://${HOST}:${PORT}/token`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function health() { for (let i = 0; i < 120; i++) { try { if ((await fetch(`http://${HOST}:${PORT}/health`)).ok) return true; } catch {} await sleep(500); } return false; }
async function mint() {
  const c = new AbortController(); const to = setTimeout(() => c.abort(), 35000); const s = Date.now();
  try { const r = await fetch(TURL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sitekey: ZN.sk, url: ZN.tgt, action: ZN.act }), signal: c.signal }); const j = await r.json(); return { ...j, ms: Date.now() - s }; }
  catch (e) { return { error: e.message, ms: Date.now() - s }; } finally { clearTimeout(to); }
}
async function verify(t) {
  try { const r = await fetch('https://lessons.zennolab.com/captchas/recaptcha/v3_verify.php?level=beta', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', referer: ZN.tgt, origin: 'https://lessons.zennolab.com' }, body: new URLSearchParams({ token: t, v3_submit: 'x' }).toString() }); const m = (await r.text()).match(/"score":\s*([0-9.]+)/); return m ? +m[1] : null; }
  catch { return null; }
}
let ok = 0, fail = 0, sumMs = 0, stop = false, n = 0, verified = 0; const lat = []; const errs = {};
let okAtStop = null, elAtStop = null;                       // snapshot at the window end (ignore the post-stop drain)
const buckets = { '0.9': 0, '0.7': 0, '0.3-0.5': 0, '0.1': 0 };
const bucket = (s) => { if (s >= 0.9) buckets['0.9']++; else if (s >= 0.7) buckets['0.7']++; else if (s >= 0.3) buckets['0.3-0.5']++; else buckets['0.1']++; };
async function worker() {
  while (!stop) {
    const j = await mint();
    if (j.token) {
      ok++; sumMs += j.ms; lat.push(j.ms); const i = ++n;
      // verify ASYNC (fire-and-forget) so it never slows the mint loop / CPM
      if (vEvery && i % vEvery === 0) verify(j.token).then((sc) => { if (sc != null) { verified++; bucket(sc); if (vEvery === 1) console.log(`  #${i}  ${String(j.ms + 'ms').padStart(7)}  score=${sc}  ${j.token.slice(0, 16)}...`); } });
    } else { fail++; const k = String(j.error || 'no-token').slice(0, 30); errs[k] = (errs[k] || 0) + 1; }
  }
}
(async () => {
  if (!await health()) { console.log('POOL NOT HEALTHY on :' + PORT); process.exit(1); }
  console.log(`CPM test -> C=${C} dur=${DUR / 1000}s verify=${VR} @ ${TURL}\n`);
  const t0 = Date.now();
  const tick = setInterval(() => { const el = (Date.now() - t0) / 1000; console.log(`  [${el.toFixed(0)}s] CPM=${Math.round(ok / (el / 60))} ok=${ok} fail=${fail}${vEvery ? ' scores=' + JSON.stringify(buckets) : ''}`); }, 3000);
  setTimeout(() => { stop = true; okAtStop = ok; elAtStop = (Date.now() - t0) / 1000; }, DUR);
  await Promise.all(Array.from({ length: C }, () => worker()));
  clearInterval(tick);
  await sleep(1500);                                        // let the last async verifies land
  lat.sort((a, b) => a - b);
  const cpm = Math.round(okAtStop / (elAtStop / 60));       // throughput DURING the window, not the drain
  console.log(`\n===== RESULT =====`);
  console.log(`tokens ${okAtStop} | fail ${fail} | success ${Math.round(100 * okAtStop / (okAtStop + fail || 1))}% | window ${Math.round(elAtStop)}s`);
  console.log(`CPM = ${cpm}  (tokens/min)`);
  console.log(`latency avg ${ok ? Math.round(sumMs / ok) : 0}ms | p50 ${lat[Math.floor(lat.length * 0.5)] || 0}ms | p90 ${lat[Math.floor(lat.length * 0.9)] || 0}ms`);
  if (vEvery) console.log(`score distribution (verified ${verified}${vEvery > 1 ? ', sampled 1/' + vEvery : ''}): ${JSON.stringify(buckets)}`);
  if (Object.keys(errs).length) console.log(`errors: ${JSON.stringify(errs)}`);
  process.exit(0);
})();

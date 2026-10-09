// v3 SCORE test: mint N zennolab tokens via the local pool, siteverify each, report the score distribution.
// Serial by default (CONC=1) because concurrency on one IP floors the score. Waits for /health itself.
//   PORT=4101 N=10 CONC=1 node v3score.mjs
const PORT = +(process.env.PORT || 4101), N = +(process.env.N || 10), CONC = +(process.env.CONC || 1); // 4101 default avoids the pool server's own default PORT=4100 - pass PORT=4100 to target it
const ZN = { sk: '6Le0xVgUAAAAAIt20XEB4rVhYOODgTl00d8juDob', tgt: 'https://lessons.zennolab.com/captchas/recaptcha/v3.php?level=beta', act: 'verify' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function health() { for (let i = 0; i < 160; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) return true; } catch {} await sleep(500); } return false; }
async function tok() { const u = `http://127.0.0.1:${PORT}/token?sitekey=${ZN.sk}&target=${encodeURIComponent(ZN.tgt)}&action=${ZN.act}`; const c = new AbortController(); const to = setTimeout(() => c.abort(), 45000); try { return await (await fetch(u, { signal: c.signal })).json(); } catch (e) { return { error: e.message }; } finally { clearTimeout(to); } }
async function verify(t) { try { const r = await fetch('https://lessons.zennolab.com/captchas/recaptcha/v3_verify.php?level=beta', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', referer: ZN.tgt, origin: 'https://lessons.zennolab.com' }, body: new URLSearchParams({ token: t, v3_submit: 'x' }).toString() }); const m = (await r.text()).match(/"score":\s*([0-9.]+)/); return m ? +m[1] : null; } catch { return null; } }

(async () => {
  if (!await health()) { console.log('POOL NOT HEALTHY on :' + PORT); process.exit(1); }
  console.log(`minting ${N} zennolab v3 tokens (conc=${CONC}) + siteverify...`);
  const scores = [];
  const one = async (i) => {
    const ts = Date.now(); const j = await tok();
    if (!j.token) { console.log(`#${i} MINT FAIL ${(j.error || 'no-token')}`); return; }
    const s = await verify(j.token); scores.push(s);
    console.log(`#${i} ${Date.now() - ts}ms  score=${s}`);
  };
  if (CONC <= 1) { for (let i = 0; i < N; i++) await one(i); }
  else { const q = [...Array(N).keys()]; while (q.length) await Promise.all(q.splice(0, CONC).map(one)); }
  const valid = scores.filter((s) => s != null).sort((a, b) => a - b);
  const med = valid.length ? valid[Math.floor(valid.length / 2)] : null;
  const b = { '>=0.9': 0, '0.7': 0, '0.3-0.5': 0, '<=0.1': 0 };
  for (const s of valid) { if (s >= 0.9) b['>=0.9']++; else if (s >= 0.7) b['0.7']++; else if (s >= 0.3) b['0.3-0.5']++; else b['<=0.1']++; }
  console.log(`\nSCORES: [${valid.join(', ')}]`);
  console.log(`minted ${valid.length}/${N} | median ${med} | buckets ${JSON.stringify(b)}`);
  process.exit(0);
})();

// v3 reCAPTCHA token minter: raw CDP + real Chrome + document interception.
// Intercepts the target document IN the browser and serves a minimal captcha-only page, so:
//   - the browser origin = the target (token valid for it),
//   - the real target server is NEVER contacted (no heavy page, no document-level antibot),
//   - only Google's reCAPTCHA endpoints are hit -> token born in a real browser -> real score.
// One-time setup (you, not this script):
//   chrome.exe --remote-debugging-port=9333 --user-data-dir="C:\path\profile"
// CLI:  CONNECT=http://localhost:9333 SITEKEY=6L.. TARGET_URL=https://site ACTION=verify [ENTERPRISE=1] node solve.mjs
// Lib:  import { connect } from './cdp.mjs'; import { warmPage, executeOn, mintOnce } from './solve.mjs';
import { fileURLToPath } from 'node:url';
import { connect } from './cdp.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Pre-execute behavior injection (env-gated, default OFF). reCAPTCHA's VM collects pointer/scroll signals (doc keys
// 352/959/idx40) during the session; a headless mint generates NONE. INJECT_BEHAVIOR=1 (+INJECT_SCROLL=1).
// MEASURED 2026-06-15 (strict 2captcha-v3): did NOT help - behavior-alone DROPPED to 0.34 (this linear interpolated
// path likely reads as robotic); scroll variant 7/10>=0.7 but inconclusive. Kept OFF; needs human-like (bezier/jitter/
// pauses) motion to be worth enabling. The realistic-viewport change (1280x800) was the win, not this.
async function injectBehavior(cdp, sessionId) {
  const w = Number(process.env.VIEWPORT_W) || 1280, h = Number(process.env.VIEWPORT_H) || 800;
  const pts = [[0.28, 0.42], [0.41, 0.55], [0.56, 0.49], [0.63, 0.6], [0.48, 0.52], [0.52, 0.46]];
  let px = Math.round(w * 0.2), py = Math.round(h * 0.3);
  for (const [fx, fy] of pts) {
    const tx = Math.round(w * fx), ty = Math.round(h * fy);
    for (let s = 1; s <= 4; s++) { // a few interpolated moves per leg = realistic pointermove stream
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(px + (tx - px) * s / 4), y: Math.round(py + (ty - py) * s / 4) }, sessionId).catch(() => {});
      await sleep(12 + (s * 7) % 19);
    }
    px = tx; py = ty;
  }
  if (process.env.INJECT_SCROLL === '1') { await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: Math.round(w / 2), y: Math.round(h / 2), deltaX: 0, deltaY: 180 }, sessionId).catch(() => {}); await sleep(80); }
}

const minimalPage = (sitekey, enterprise) =>
  `<!doctype html><html><head><meta charset=utf-8><title> </title>` +
  `<script>window.onerror=function(m,s,l,c,e){window.__booterr=String(m).slice(0,120)+'@'+String(s||'').slice(-30)+':'+l+':'+c+'|'+(e&&e.stack?String(e.stack).slice(0,400):'')};window.addEventListener('unhandledrejection',function(e){window.__booterr='REJ:'+String(e.reason&&(e.reason.message||e.reason)).slice(0,120)});</script>` +
  `<script src="https://www.google.com/recaptcha/${enterprise ? 'enterprise' : 'api'}.js?render=${sitekey}"></script>` +
  `</head><body></body></html>`;

// Stealth patch - fixes the JS-level headless tells (MEASURED: lifts headless 0.3 -> 0.8 = headful). Conditional,
// so it's a no-op in headful. Applied via Page.addScriptToEvaluateOnNewDocument (runs in every document before page JS).
export const STEALTH_PATCH = `(function(){try{
Object.defineProperty(navigator,'webdriver',{get:function(){return undefined;}});
var pq=navigator.permissions&&navigator.permissions.query;
if(pq)navigator.permissions.query=function(p){return(p&&p.name==='notifications')?Promise.resolve({state:(window.Notification&&Notification.permission)||'prompt',onchange:null}):pq.call(navigator.permissions,p);};
if(!window.chrome)window.chrome={runtime:{},app:{isInstalled:false},csi:function(){},loadTimes:function(){}};
if(!window.outerWidth)Object.defineProperty(window,'outerWidth',{get:function(){return window.innerWidth||1280;}});
if(!window.outerHeight)Object.defineProperty(window,'outerHeight',{get:function(){return (window.innerHeight||720)+85;}});
}catch(e){}})();`;

// Native-level realism patches (MEASURED tells via the RE-doc signal map, github elyelysiox/recaptcha):
//  - UA-Client-Hints: headless leaves navigator.userAgentData.brands=[] / platform="" (fp idx 72) - populate to match the UA.
//  - screen: headless defaults screen to 800x600 while a 1280 viewport gives innerWidth 1280 > screen.width = IMPOSSIBLE
//    on a real monitor (fp idx 67) - override to a realistic screen >= viewport.
// Done at the CDP/Emulation layer (no JS getter hooks, so nothing for reCAPTCHA to detect as tampering).
export async function applyRealismPatches(cdp, sessionId, ua) {
  const MOBILE = process.env.MOBILE === '1'; // experiment: emulate Android (some reports say mobile profiles score higher)
  if (ua) {
    const major = (ua.match(/Chrome\/(\d+)/) || [])[1] || '149';
    const isWin = /Windows/.test(ua), isMac = /Macintosh|Mac OS/.test(ua), isAndroid = /Android/.test(ua);
    const mob = MOBILE || isAndroid;
    const platform = mob ? 'Android' : isWin ? 'Windows' : isMac ? 'macOS' : 'Linux';
    const brands = [{ brand: 'Chromium', version: major }, { brand: 'Google Chrome', version: major }, { brand: 'Not.A/Brand', version: '99' }];
    const fullVersionList = brands.map((b) => ({ brand: b.brand, version: b.version + '.0.0.0' }));
    await cdp.send('Emulation.setUserAgentOverride', { userAgent: ua, acceptLanguage: 'en-US,en;q=0.9', userAgentMetadata: { brands, fullVersionList, fullVersion: major + '.0.0.0', platform, platformVersion: mob ? '14.0.0' : isWin ? '15.0.0' : isMac ? '14.0.0' : '6.5.0', architecture: mob ? '' : 'x86', model: mob ? 'Pixel 7' : '', mobile: mob, bitness: mob ? '' : '64', wow64: false } }, sessionId).catch(() => {});
  }
  if (MOBILE) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 412, height: 915, deviceScaleFactor: 2.625, mobile: true, screenWidth: 412, screenHeight: 915, screenOrientation: { type: 'portraitPrimary', angle: 0 } }, sessionId).catch(() => {});
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }, sessionId).catch(() => {});
  } else {
    const vw = Number(process.env.VIEWPORT_W) || 1280, vh = Number(process.env.VIEWPORT_H) || 800;
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: vw, height: vh, deviceScaleFactor: 1, mobile: false, screenWidth: Math.max(1920, vw), screenHeight: Math.max(1080, vh), screenOrientation: { type: 'landscapePrimary', angle: 0 } }, sessionId).catch(() => {});
  }
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: STEALTH_PATCH }, sessionId).catch(() => {}); // JS-level headless tells
}

const G = (enterprise) => (enterprise ? '(window.grecaptcha&&window.grecaptcha.enterprise)' : 'window.grecaptcha');
const readyExpr = (enterprise) =>
  `new Promise((res,rej)=>{const d=Date.now()+25000;const iv=setInterval(()=>{const G=${G(enterprise)};` +
  `if(G&&G.execute){clearInterval(iv);G.ready(()=>res(true));}else if(Date.now()>d){clearInterval(iv);rej('grecaptcha never ready');}},120);});`;
const executeExpr = (sitekey, action, enterprise) =>
  `new Promise((res,rej)=>{const G=${G(enterprise)};G.execute(${JSON.stringify(sitekey)},{action:${JSON.stringify(action)}})` +
  `.then(res).catch(e=>rej(String(e)));});`;

// Open a tab, intercept its document -> minimal captcha page on the target origin, wait until ready.
export async function warmPage(cdp, { sitekey, targetUrl, enterprise = false, proxyAuth = null, reuseInitialTab = false, log = () => {} }) {
  let targetId = null;
  // REUSE the about:blank tab Chrome already opened at launch (no dead extra tab). v3 always proxies at the Chrome
  // process level (no per-tab browserContext), so the first tab can always reuse it; tabs 2+ create their own.
  if (reuseInitialTab) {
    try { const { targetInfos } = await cdp.send('Target.getTargets'); const ex = (targetInfos || []).find((t) => t.type === 'page' && /^about:blank/.test(t.url || '')); if (ex) targetId = ex.targetId; } catch {}
  }
  if (!targetId) ({ targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' }));
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  // VPS-safe: strip "Headless" from the UA. MEASURED (WSL Linux headless): "HeadlessChrome" UA -> v3 score 0;
  // clean "Chrome" UA -> 0.5+ on the SAME GPU-less SwiftShader box. The UA token is the score-killer, not the GPU.
  const ua = ((cdp.version && cdp.version['User-Agent']) || '').replace(/Headless/g, '');
  await applyRealismPatches(cdp, sessionId, ua); // UA-CH + screen + stealth patch (fingerprint realism)
  const page = minimalPage(sitekey, enterprise);
  const state = { served: false };
  cdp.on('Fetch.requestPaused', async (p, sid) => {
    if (sid !== sessionId) return;
    try {
      if (!state.served && p.resourceType === 'Document') {
        state.served = true;
        await cdp.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }], body: Buffer.from(page).toString('base64') }, sid);
      } else {
        await cdp.send('Fetch.continueRequest', { requestId: p.requestId }, sid);
      }
    } catch {}
  }, sessionId);
  // Proxy auth (user:pass proxies): answer the 407 challenge. Needs handleAuthRequests + broaden patterns so the
  // proxied subresources (api.js etc.) are seen - the local document is fulfilled, but api.js egresses via the proxy.
  if (proxyAuth) cdp.on('Fetch.authRequired', async (p, sid) => { if (sid !== sessionId) return; try { await cdp.send('Fetch.continueWithAuth', { requestId: p.requestId, authChallengeResponse: { response: 'ProvideCredentials', username: proxyAuth.username, password: proxyAuth.password } }, sid); } catch {} }, sessionId);
  const patterns = proxyAuth ? [{ urlPattern: '*', requestStage: 'Request' }] : [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }];
  await cdp.send('Fetch.enable', { patterns, handleAuthRequests: !!proxyAuth }, sessionId);
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Page.navigate', { url: targetUrl }, sessionId);
  log('page loaded (intercepted)');
  await cdp.send('Runtime.evaluate', { expression: readyExpr(enterprise), awaitPromise: true, returnByValue: true }, sessionId);
  log('grecaptcha ready');
  if (process.env.INJECT_BEHAVIOR === '1') await injectBehavior(cdp, sessionId).catch(() => {});
  return { targetId, sessionId };
}

// Mint a token on an already-warm page (just re-runs execute - no navigation). ~0.5s.
export async function executeOn(cdp, sessionId, { sitekey, action = 'verify', enterprise = false, log = () => {} }) {
  log(`execute(${action})`);
  const r = await cdp.send('Runtime.evaluate', { expression: executeExpr(sitekey, action, enterprise), awaitPromise: true, returnByValue: true }, sessionId).catch((e) => ({ evalFail: String(e && e.message || e) }));
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'execute exception');
  const t = r.result?.value;
  if (r.evalFail) throw new Error(r.evalFail);
  if (!t || typeof t !== 'string') throw new Error('no token returned');
  return t;
}

export async function closePage(cdp, sessionId, targetId) {
  cdp.off('Fetch.requestPaused', sessionId);
  cdp.off('Fetch.authRequired', sessionId);                  // also remove the proxy-auth handler (was leaking across recycles in proxy mode)
  try { await cdp.send('Target.closeTarget', { targetId }); } catch {}
}

// Fresh-tab single mint (warm + execute + close).
export async function mintOnce(cdp, opts) {
  const { targetId, sessionId } = await warmPage(cdp, opts);
  try { return await executeOn(cdp, sessionId, opts); }
  finally { await closePage(cdp, sessionId, targetId); }
}

export async function solve(opts) {
  const cdp = await connect(opts.browserURL || 'http://localhost:9333');
  try { return await mintOnce(cdp, opts); } finally { cdp.close(); }
}

if (process.argv[1] && typeof import.meta.url === 'string' && process.argv[1] === fileURLToPath(import.meta.url)) { // typeof guard: run the CLI only when executed directly; when imported as a library, import.meta.url may be unavailable
  (async () => {
  const token = await solve({
    browserURL: process.env.CONNECT || 'http://localhost:9333',
    sitekey: process.env.SITEKEY, targetUrl: process.env.TARGET_URL,
    action: process.env.ACTION || 'verify', enterprise: process.env.ENTERPRISE === '1',
  });
  console.log(token);
  })();
}

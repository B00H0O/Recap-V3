// Minimal raw Chrome DevTools Protocol client over WebSocket.
// Drives a real Chrome over raw CDP.
// Uses the lightweight `ws` transport (Node has no global WebSocket < v22). Connect to a
// separately-launched real Chrome: chrome.exe --remote-debugging-port=PORT --user-data-dir=...
//
// Hardened (A1): every send() has a timeout, and if the socket closes/errors ALL in-flight sends
// reject immediately - so a dead or hung Chrome surfaces as a rejected promise instead of a
// forever-pending one that silently wedges a pool slot. TCP_NODELAY so tiny CDP frames aren't
// Nagle-batched. Exposes `closed` for the pool watchdog.
import WebSocket from 'ws';

const SEND_TIMEOUT = +(process.env.CDP_TIMEOUT || 60000); // ms per CDP command; 0 disables

export async function connect(browserURL) {
  const base = browserURL.replace(/\/$/, '');
  const ver = await (await fetch(base + '/json/version')).json();
  const ws = new WebSocket(ver.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', () => rej(new Error('CDP ws connect failed'))); });
  try { ws._socket && ws._socket.setNoDelay(true); } catch {} // TCP_NODELAY: don't Nagle-batch small CDP frames
  let nextId = 1;
  let closedErr = null;
  const pending = new Map();
  const handlers = [];
  const rejectAll = (err) => { for (const [, p] of pending) { if (p.timer) clearTimeout(p.timer); try { p.rej(err); } catch {} } pending.clear(); };
  ws.on('message', (data) => {
    let m; try { m = JSON.parse(data.toString()); } catch { return; }
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id); if (p.timer) clearTimeout(p.timer);
      m.error ? p.rej(new Error(m.error.message || JSON.stringify(m.error))) : p.res(m.result);
    } else if (m.method) {
      for (const h of handlers) if (h.method === m.method && (!h.sid || h.sid === m.sessionId)) { try { h.fn(m.params, m.sessionId); } catch {} }
    }
  });
  ws.on('close', () => { closedErr = closedErr || new Error('CDP socket closed'); rejectAll(closedErr); });
  ws.on('error', (e) => { closedErr = new Error('CDP socket error: ' + (e?.message || e)); rejectAll(closedErr); });
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
    if (closedErr) return rej(closedErr);
    const id = nextId++;
    const entry = { res, rej, timer: null };
    if (SEND_TIMEOUT > 0) {
      entry.timer = setTimeout(() => { if (pending.delete(id)) rej(new Error(`CDP timeout after ${SEND_TIMEOUT}ms: ${method}`)); }, SEND_TIMEOUT);
      if (entry.timer.unref) entry.timer.unref(); // don't hold the event loop open in CLI/one-shot use
    }
    pending.set(id, entry);
    const o = { id, method, params }; if (sessionId) o.sessionId = sessionId;
    try { ws.send(JSON.stringify(o)); } catch (e) { pending.delete(id); if (entry.timer) clearTimeout(entry.timer); rej(e); }
  });
  const on = (method, fn, sid) => { handlers.push({ method, fn, sid }); };
  const off = (method, sid) => { for (let i = handlers.length - 1; i >= 0; i--) if (handlers[i].method === method && handlers[i].sid === sid) handlers.splice(i, 1); };
  return { send, on, off, close: () => { try { ws.close(); } catch {} }, get closed() { return !!closedErr; }, version: ver };
}

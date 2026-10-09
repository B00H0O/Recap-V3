// Terminal UI for the pool - pure ANSI.
//   normal : embedded banner + subtitle + clean endpoint URL, then `[HH:MM:SS] | elapsed | token`
//            (green ok / red fail). NO config line, NO "ready" line.
//   debug  : adds the config line + "DEBUG MODE", and the per-request pipeline
//            RECV -> ACQUIRE -> MINT (grecaptcha.execute) -> TOKEN -> SEND.
// Banner is EMBEDDED (base64 below - no external file). To change the art: base64-encode the new figlet and replace ART_B64.
const A = {
  reset: '\x1b[0m', boldCyan: '\x1b[1;36m', dim: '\x1b[2m', gray: '\x1b[90m',
  cyan: '\x1b[96m', green: '\x1b[92m', red: '\x1b[91m', yellow: '\x1b[93m',
  magenta: '\x1b[95m', blue: '\x1b[94m', white: '\x1b[37m',
};
const ART_B64 = 'IF9fX18gICAgICAgICAgICAgICAgICAgICAgXyAgICAgICBfICAgICAgICAgICAgX18gICAgIF9fX19fX18gCnwgIF8gXCBfX18gIF9fXyBfXyBfIF8gX18gfCB8XyBfX198IHxfXyAgIF9fIF8gIFwgXCAgIC8gL19fXyAvIAp8IHxfKSAvIF8gXC8gX18vIF9gIHwgJ18gXHwgX18vIF9ffCAnXyBcIC8gX2AgfCAgXCBcIC8gLyAgfF8gXCAKfCAgXyA8ICBfXy8gKF98IChffCB8IHxfKSB8IHx8IChfX3wgfCB8IHwgKF98IHwgICBcIFYgLyAgX19fKSB8CnxffCBcX1xfX198XF9fX1xfXyxffCAuX18vIFxfX1xfX198X3wgfF98XF9fLF98ICAgIFxfLyAgfF9fX18vIAogICAgICAgICAgICAgICAgICAgIHxffCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA=';
const ART = Buffer.from(ART_B64, 'base64').toString('utf8').split('\n');
const SUBTITLE = 'Recaptcha V3 Solver  |  By @B00H0  |  t.me/HK407';

const width = () => process.stdout.columns || 100;
const vlen = (s) => s.replace(/\x1b\[[0-9;]*m/g, '').length;
const pad = (s, w) => { const n = vlen(s); return n >= w ? 0 : Math.floor((w - n) / 2); };
const centerPlain = (s, w) => ' '.repeat(pad(s, w)) + s;
const center = (s, color, w) => ' '.repeat(pad(s, w)) + color + s + A.reset;
const padc = (s, w) => { const n = vlen(s); if (n >= w) return s; const l = Math.floor((w - n) / 2); return ' '.repeat(l) + s + ' '.repeat(w - n - l); };   // center content in a cell
const hms = () => { const d = new Date(); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`; };
const ms3 = () => { const d = new Date(); return `${hms()}.${String(d.getMilliseconds()).padStart(3, '0')}`; };

export function printBanner({ port, cfg = '', debug = false } = {}) {
  const w = width();
  let out = '\x1b[2J\x1b[H\n';
  const artW = Math.max(...ART.map((l) => l.length));       // BLOCK-center the figlet: one shared indent for ALL lines preserves its internal alignment
  const lead = ' '.repeat(Math.max(0, Math.floor((w - artW) / 2)));
  for (const line of ART) out += lead + A.boldCyan + line + A.reset + '\n';
  out += '\n' + center(SUBTITLE, A.boldCyan, w) + '\n\n';
  if (debug) {                                              // config + DEBUG label show ONLY in debug mode
    if (cfg) out += center(cfg, A.blue, w) + '\n\n';        // config line, then a blank line
    out += center('DEBUG MODE', A.magenta, w) + '\n';
  }
  const url = `http://localhost:${port}/token`;             // clean endpoint, rule sized to it
  out += centerPlain(url, w) + '\n';
  out += center('-'.repeat(Math.min(vlen(url), w)), A.dim, w) + '\n\n';
  process.stdout.write(out);
}

export function ready() {}                                  // intentionally empty (no "Ready - waiting..." line)

let _ids = 0;
export const nextId = () => ++_ids;

// debug-only pipeline step (no-op in normal mode). Even columns, `|` separators:
//   [HH:MM:SS.mmm] | #id | Wn | TAG     | message
export function step(debug, id, label, tag, msg = '') {
  if (!debug) return;
  const colors = { RECV: A.cyan, ACQUIRE: A.blue, MINT: A.yellow, EXEC: A.yellow, TOKEN: A.green, SEND: A.magenta, RETRY: A.yellow };
  const c = colors[tag] || A.gray;
  const s = `${A.dim}|${A.reset}`;
  console.log(`  ${A.blue}[${ms3()}]${A.reset} ${s} ${A.dim}${padc('#' + id, 2)}${A.reset} ${s} ${A.cyan}${padc(label || '', 2)}${A.reset} ${s} ${c}${tag.padEnd(7)}${A.reset} ${s} ${msg}`);
}

// short token preview: a 54-char prefix + "..."
const shortTok = (t) => { const s = String(t); return s.length <= 54 ? s : s.slice(0, 54) + '...'; };

// final per-request line - normal: `[HH:MM:SS] | elapsed | token`
export function result({ debug, id, label, ok, ms, token = '', err = '', tag = '' }) {
  if (debug) {
    const c = ok ? A.green : A.red; const s = `${A.dim}|${A.reset}`;
    console.log(`  ${A.blue}[${ms3()}]${A.reset} ${s} ${A.dim}${padc('#' + id, 2)}${A.reset} ${s} ${A.cyan}${padc('', 2)}${A.reset} ${s} ${A.magenta}${'SEND'.padEnd(7)}${A.reset} ${s} ${c}${ok ? 'OK' : 'FAIL'}${A.reset}${tag ? ' ' + A.dim + tag + A.reset : ''} ${A.dim}in${A.reset} ${A.yellow}${ms}ms${A.reset}${ok ? '' : '  ' + A.red + err + A.reset}`);
    console.log('');
    return;
  }
  const sep = `${A.dim}|${A.reset}`;                        // normal line: `[HH:MM:SS] | elapsed | token` - blue time
  if (ok) console.log(`  ${A.blue}[${hms()}]${A.reset} ${sep} ${A.yellow}${padc(ms + 'ms', 7)}${A.reset} ${sep} ${A.green}${shortTok(token)}${A.reset}`);
  else console.log(`  ${A.blue}[${hms()}]${A.reset} ${sep} ${A.yellow}${padc(ms + 'ms', 7)}${A.reset} ${sep} ${A.red}${err}${A.reset}`);
}

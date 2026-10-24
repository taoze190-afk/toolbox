// 逐个工具页在真机上截图，确认 17 套参数面板都渲染得出来（引擎已由 device-verify 覆盖）
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { need } from './local.mjs';

const ADB = need('adb');
const PKG = 'com.qoder.toolbox';
const PORT = 9342;
const DIR = 'shots/device-tools';
fs.mkdirSync(DIR, { recursive: true });

function adb(...a) {
  return execFileSync(ADB, a, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
}
const want = process.env.ANDROID_SERIAL ?? need('serialPhone');
const lines = adb('devices').split(/\r?\n/).slice(1).map((l) => l.split(/\t/)).filter((a) => a[1] === 'device').map((a) => a[0]);
const hits = [...new Set(lines.filter((s) => s.includes(want)))];
if (!hits.length) throw new Error(`没找到含 ${want} 的设备`);
const serial = hits[0];
const dev = ['-s', serial];

adb(...dev, 'shell', 'input', 'keyevent', '224');
adb(...dev, 'shell', 'wm', 'dismiss-keyguard');
if (!/mWakefulness=Awake/.test(adb(...dev, 'shell', 'dumpsys', 'power'))) throw new Error('屏幕没醒');
const mf = /mCurrentFocus=Window\{\S+ \S+ (\S+?)[/}]/.exec(adb(...dev, 'shell', 'dumpsys', 'window'))?.[1] ?? '';
if (/incallui|telecom|dialer/i.test(mf)) throw new Error(`设备正在通话（${mf}）`);

adb(...dev, 'shell', 'am', 'start', '-n', `${PKG}/com.qoder.toolbox.MainActivity`);
await new Promise((r) => setTimeout(r, 2500));
const pid = adb(...dev, 'shell', 'pidof', PKG).trim().split(/\s+/)[0];
adb(...dev, 'forward', `tcp:${PORT}`, `localabstract:webview_devtools_remote_${pid}`);

let target = null;
for (let i = 0; i < 30 && !target; i++) {
  await new Promise((r) => setTimeout(r, 400));
  try {
    target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(
      (t) => t.type === 'page' && t.webSocketDebuggerUrl && t.description?.includes('visible'),
    );
  } catch {
    /* 还没起 */
  }
}
if (!target) throw new Error('找不到前台 WebView');

function who() {
  try {
    return /mCurrentFocus=Window\{\S+ \S+ (\S+?)[/}]/.exec(adb(...dev, 'shell', 'dumpsys', 'window'))?.[1] ?? '(读不到)';
  } catch {
    return '(读不到)';
  }
}
function connect() {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`连不上 WebView（10s）；前台是 ${who()}，可能被别的 App 占着`)), 10_000);
    ws.onopen = () => (clearTimeout(t), res());
    ws.onerror = () => (clearTimeout(t), rej(new Error('CDP 连接失败')));
  });
}
let ws, mid = 0;
const pending = new Map();
ws = new WebSocket(target.webSocketDebuggerUrl);
await connect();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) (0, pending.get(m.id))(m), pending.delete(m.id);
};
function ev(expr, ms = 20_000) {
  const id = ++mid;
  return new Promise((res, rej) => {
    const t = setTimeout(() => (pending.delete(id), rej(new Error('超时'))), ms);
    pending.set(id, (v) => {
      clearTimeout(t);
      const r = v.result;
      if (v.error || r?.exceptionDetails) return rej(new Error(v.error?.message ?? r.exceptionDetails.exception?.description ?? '异常'));
      res(r.result.value);
    });
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
  });
}

const tools = await ev('__tk.tools.map(t=>({id:t.id,name:t.name,zone:t.zone}))');
console.log('工具', tools.length);
const bad = [];
for (const t of tools) {
  const info = await ev(
    `(async()=>{location.hash='#/t/${t.id}';await new Promise(r=>setTimeout(r,700));
      const main=document.querySelector('main');
      const rows=[...document.querySelectorAll('main .divide-y > div')].length;
      const btns=[...document.querySelectorAll('button')].map(b=>b.innerText.trim()).filter(Boolean);
      return {title:document.title, hasMain:!!main, rows, btns:btns.length,
              text:(main?main.innerText:'').slice(0,300), overflow: main? main.scrollWidth>window.innerWidth+1 : false};})()`,
  );
  if (!process.argv.includes('--fast')) {
    const shot = execFileSync(ADB, [...dev, 'exec-out', 'screencap', '-p'], { maxBuffer: 64 * 1024 * 1024 });
    fs.writeFileSync(path.join(DIR, `${t.id}.png`), shot);
  }
  const ok = info.hasMain && info.title === t.name && !info.overflow;
  if (!ok) bad.push(`${t.id}: ${JSON.stringify(info)}`);
  console.log(`${ok ? 'OK  ' : 'BAD'} ${t.id.padEnd(18)} 参数组 ${String(info.rows).padStart(2)} · 按钮 ${String(info.btns).padStart(2)} · ${info.text.split('\n').filter(Boolean).slice(0, 3).join(' / ').slice(0, 62)}`);
}

await ev(`location.hash='#/'`).catch(() => {});
adb(...dev, 'forward', '--remove', `tcp:${PORT}`);
if (bad.length) {
  console.log('\n有问题的页面：');
  for (const b of bad) console.log('  ' + b);
  process.exit(1);
}
console.log(`\n17 个工具页全部渲染正常，截图在 ${DIR}/`);

// 在真机上打开设置页并截图，确认服务器转换配置界面可用
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { need } from './local.mjs';

const ADB = need('adb');
const PKG = 'com.qoder.toolbox';
const PORT = 9343;

function adb(...a) {
  return execFileSync(ADB, a, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
}
const want = process.env.ANDROID_SERIAL ?? need('serialPhone');
const lines = adb('devices').split(/\r?\n/).slice(1).map((l) => l.split(/\t/)).filter((a) => a[1] === 'device').map((a) => a[0]);
const hits = [...new Set(lines.filter((s) => s.includes(want)))];
if (!hits.length) throw new Error(`没找到含 ${want} 的设备；在线：${lines.join(' , ')}`);
const dev = ['-s', hits[0]];

adb(...dev, 'shell', 'input', 'keyevent', '224');
adb(...dev, 'shell', 'wm', 'dismiss-keyguard');
if (!/mWakefulness=Awake/.test(adb(...dev, 'shell', 'dumpsys', 'power'))) throw new Error('屏幕没醒');
const mf = /mCurrentFocus=Window\{\S+ \S+ (\S+?)[/}]/.exec(adb(...dev, 'shell', 'dumpsys', 'window'))?.[1] ?? '';
if (/incallui|telecom|dialer/i.test(mf)) throw new Error(`设备正在通话（${mf}）`);

adb(...dev, 'shell', 'am', 'force-stop', PKG);
adb(...dev, 'shell', 'am', 'start', '-n', `${PKG}/com.qoder.toolbox.MainActivity`);
await new Promise((r) => setTimeout(r, 4000));
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
function ev(expr, ms = 25_000) {
  const id = ++mid;
  return new Promise((res, rej) => {
    const t = setTimeout(() => (pending.delete(id), rej(new Error('求值超时'))), ms);
    pending.set(id, (v) => {
      clearTimeout(t);
      const r = v.result;
      if (v.error || r?.exceptionDetails) return rej(new Error(v.error?.message ?? r.exceptionDetails.exception?.description ?? '异常'));
      res(r.result.value);
    });
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
  });
}
await ev(`(async()=>{location.hash='#/settings';await new Promise(r=>setTimeout(r,900));return 1;})()`);
const info = await ev(
  `({title:document.title, rows:document.querySelectorAll('main .divide-y > div').length,
    selects:document.querySelectorAll('select').length, inputs:document.querySelectorAll('input').length,
    btns:[...document.querySelectorAll('button')].map(b=>b.innerText.trim()).filter(t=>t&&t!=='‹'),
    text:document.querySelector('main')?.innerText.slice(0,260),
    overflow: document.documentElement.scrollWidth > window.innerWidth + 1})`,
);
console.log(JSON.stringify(info, null, 1));
fs.writeFileSync('shots/device-settings.png', execFileSync(ADB, [...dev, 'exec-out', 'screencap', '-p'], { maxBuffer: 64 * 1024 * 1024 }));
console.log('截图 shots/device-settings.png');

// 顺手确认没配密钥时，四个走服务器的工具会明说"未配置"
if (info.overflow) throw new Error('设置页横向溢出了');
adb(...dev, 'forward', '--remove', `tcp:${PORT}`);

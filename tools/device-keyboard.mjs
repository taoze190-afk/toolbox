// 键盘弹出时布局到底缩不缩：真点一下输入框，比较弹出前后的 innerHeight，并确认焦点框没被键盘盖住。
// 用法：node tools/device-keyboard.mjs --serial=<设备号>
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { need } from './local.mjs';

const ADB = need('adb');
const PKG = 'com.qoder.toolbox';
const PORT = 9349;
const DIR = 'shots/ui-device';
fs.mkdirSync(DIR, { recursive: true });

const want = process.argv.find((a) => a.startsWith('--serial='))?.split('=')[1] ?? need('serialPad');
function adb(...a) {
  return execFileSync(ADB, a, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
}
const online = adb('devices')
  .split(/\r?\n/)
  .slice(1)
  .map((l) => l.split(/\t/))
  .filter((x) => x[1] === 'device')
  .map((x) => x[0]);
const hits = [...new Set(online.filter((s) => s.includes(want)))];
if (hits.length !== 1) throw new Error(`要正好一台匹配 ${want} 的设备，实际 ${hits.length} 台：${hits.join(' , ')}`);
const dev = ['-s', hits[0]];
const model = adb(...dev, 'shell', 'getprop', 'ro.product.model');

adb(...dev, 'shell', 'input', 'keyevent', '224');
adb(...dev, 'shell', 'wm', 'dismiss-keyguard');
await new Promise((r) => setTimeout(r, 800));
adb(...dev, 'shell', 'am', 'force-stop', PKG);
adb(...dev, 'shell', 'am', 'start', '-n', `${PKG}/com.qoder.toolbox.MainActivity`);
await new Promise((r) => setTimeout(r, 4200));
const pid = adb(...dev, 'shell', 'pidof', PKG).trim().split(/\s+/)[0];
if (!pid) throw new Error('进程没起来');
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
let ws, mid = 0;
const pending = new Map();
ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('连不上 WebView（10s）')), 10_000);
  ws.onopen = () => (clearTimeout(t), res());
  ws.onerror = () => (clearTimeout(t), rej(new Error('CDP 连接失败')));
});
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) (0, pending.get(m.id))(m), pending.delete(m.id);
};
function ev(expr, ms = 20_000) {
  const id = ++mid;
  return new Promise((res, rej) => {
    const t = setTimeout(() => (pending.delete(id), rej(new Error(`求值超时 ${Math.round(ms / 1000)}s`))), ms);
    pending.set(id, (v) => {
      clearTimeout(t);
      const r = v.result;
      if (v.error || r?.exceptionDetails) return rej(new Error(v.error?.message ?? r.exceptionDetails.exception?.description ?? '异常'));
      res(r.result.value);
    });
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
  });
}
const shot = (f) =>
  fs.writeFileSync(path.join(DIR, f), execFileSync(ADB, [...dev, 'exec-out', 'screencap', '-p'], { maxBuffer: 64 * 1024 * 1024 }));

let pass = 0;
let fail = 0;
const chk = (ok, name, extra = '') => {
  if (ok) { pass++; console.log(`通过  ${name}${extra ? '  ' + extra : ''}`); }
  else { fail++; console.log(`失败  ${name}${extra ? '  ' + extra : ''}`); }
};

// 找一个数字框（图片压缩的「目标大小」），报告它在屏幕上的中心
const PROBE = `(()=>{
  const rows=[...document.querySelectorAll('main .divide-y > div')];
  const box=rows.map(r=>[...r.querySelectorAll('input')]).find(a=>a&&a.length)||[];
  const el=box[0];
  if(!el) return {err:'这一页没有输入框'};
  const r=el.getBoundingClientRect();
  const foot=document.querySelector('footer');
  return {w:innerWidth,h:innerHeight,dpr:devicePixelRatio,
    cx:Math.round((r.left+r.width/2)*devicePixelRatio), cy:Math.round((r.top+r.height/2)*devicePixelRatio),
    bottomCss:Math.round(r.bottom), focused:document.activeElement===el,
    footBottom: foot?Math.round(foot.getBoundingClientRect().bottom):-1,
    value:el.value};
})()`;

await ev(`(async()=>{location.hash='#/t/image-compress';await new Promise(r=>setTimeout(r,900));return 1;})()`);
const a = await ev(PROBE);
if (a.err) throw new Error(a.err);
shot(`${model}-keyboard-before.png`);
console.log(`点前 innerHeight=${a.h} 输入框中心=${a.cx},${a.cy} dpr=${a.dpr} 值=${a.value}`);

adb(...dev, 'shell', 'input', 'tap', String(a.cx), String(a.cy));
await new Promise((r) => setTimeout(r, 1800));
const b = await ev(PROBE);
shot(`${model}-keyboard-after.png`);
console.log(`点后 innerHeight=${b.h} 焦点在输入框=${b.focused} footBottom=${b.footBottom}`);

const shrunk = a.h - b.h;
chk(shrunk > a.h * 0.12, `键盘弹出后布局高度缩了 ${shrunk}px（应超过屏高 12%）`, `${a.h} → ${b.h}`);
chk(b.focused, '焦点确实在被点的输入框上');
chk(b.footBottom <= b.h + 1, `底部操作条没被键盘压住（foot ${b.footBottom} ≤ 视口 ${b.h}）`);
chk(b.bottomCss <= b.h - 8, `输入框本身在键盘上方可见（底边 ${b.bottomCss} ≤ ${b.h}）`);

// 真敲一次数：0100 那个 bug 的回归
adb(...dev, 'shell', 'input', 'keyevent', 'KEYCODE_MOVE_END');
for (let i = 0; i < 6; i++) adb(...dev, 'shell', 'input', 'keyevent', 'KEYCODE_DEL');
adb(...dev, 'shell', 'input', 'text', '100');
await new Promise((r) => setTimeout(r, 500));
const typed = await ev(PROBE);
chk(typed.value === '100', `清空后敲 100，框里就是 100（实际 "${typed.value}"）`);
adb(...dev, 'shell', 'input', 'keyevent', '111');

adb(...dev, 'forward', '--remove', `tcp:${PORT}`);
console.log(`\n键盘验收（${model}）：通过 ${pass} / 失败 ${fail}，截图 shots/ui-device/`);
process.exit(fail ? 1 : 0);

// 在真机/真平板上逐页截图并量几何：确认布局在这块屏上真的对，不只是无头 Chrome 里对。
// 用法：node tools/device-ui-shots.mjs --serial=<设备号>   （默认为 tools/local.json 里的 serialPad）
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { need } from './local.mjs';

const ADB = need('adb');
const PKG = 'com.qoder.toolbox';
const PORT = 9348;
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
  .filter((a) => a[1] === 'device')
  .map((a) => a[0]);
const hits = [...new Set(online.filter((s) => s.includes(want)))];
if (!hits.length) throw new Error(`没找到含 ${want} 的设备；在线：${online.join(' , ') || '无'}`);
if (hits.length > 1) throw new Error(`${want} 匹配到多台，别猜：${hits.join(' , ')}`);
const dev = ['-s', hits[0]];
const model = adb(...dev, 'shell', 'getprop', 'ro.product.model');

adb(...dev, 'shell', 'input', 'keyevent', '224');
adb(...dev, 'shell', 'wm', 'dismiss-keyguard');
let awake = false;
for (let i = 0; i < 8 && !awake; i++) {
  await new Promise((r) => setTimeout(r, 700));
  awake = /mWakefulness=Awake/.test(adb(...dev, 'shell', 'dumpsys', 'power'));
}
if (!awake) throw new Error('屏幕没醒');
console.log('设备', hits[0], model, adb(...dev, 'shell', 'wm', 'size'), adb(...dev, 'shell', 'wm', 'density'));

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
function ev(expr, ms = 30_000) {
  const id = ++mid;
  return new Promise((res, rej) => {
    const t = setTimeout(() => (pending.delete(id), rej(new Error(`求值超时 ${Math.round(ms / 1000)}s`))), ms);
    pending.set(id, (v) => {
      clearTimeout(t);
      const r = v.result;
      if (v.error || r?.exceptionDetails) {
        return rej(new Error(v.error?.message ?? r.exceptionDetails.exception?.description ?? '异常'));
      }
      res(r.result.value);
    });
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
  });
}
const shot = (f) =>
  fs.writeFileSync(path.join(DIR, f), execFileSync(ADB, [...dev, 'exec-out', 'screencap', '-p'], { maxBuffer: 64 * 1024 * 1024 }));

const GEOM = `(()=>{
  const de=document.documentElement;
  const rail=document.querySelector('nav'), foot=document.querySelector('footer');
  const wide=innerWidth>=1024;
  const bad=[];
  for (const el of document.querySelectorAll('button,input,select,h1,h2')) {
    const r=el.getBoundingClientRect();
    if (r.width && (r.right>innerWidth+1 || r.left<-1)) bad.push((el.tagName+'.'+(el.className||'')).slice(0,36));
  }
  let min=1e9,minWhat='';
  for (const b of document.querySelectorAll('button')) {
    const hh=Math.round(b.getBoundingClientRect().height);
    if (hh>0 && hh<min) { min=hh; minWhat=(b.innerText||b.getAttribute('aria-label')||b.className).slice(0,24); }
  }
  return {w:innerWidth,h:innerHeight,overflowX:de.scrollWidth-de.clientWidth,theme:de.dataset.theme||'',
    rail:!!rail,railOk:!!rail===wide,footW:foot?Math.round(foot.getBoundingClientRect().width):0,
    footFits:foot?foot.getBoundingClientRect().right<=innerWidth+1:true,clipped:bad.slice(0,3),
    tap:min,tapWhat:minWhat};
})()`;

let pass = 0;
let fail = 0;
const chk = (ok, name, extra = '') => {
  if (ok) { pass++; console.log(`通过  ${name}${extra ? '  ' + extra : ''}`); }
  else { fail++; console.log(`失败  ${name}${extra ? '  ' + extra : ''}`); }
};

const CASES = [
  { hash: '#/', name: 'home' },
  { hash: '#/t/image-compress', name: 'tool' },
  { hash: '#/t/pdf-to-word', name: 'tool-ocr' },
  { hash: '#/settings', name: 'settings' },
];

for (const theme of ['light', 'dark']) {
  // 换主题要真重载：只改 localStorage + hash 的话首屏定色脚本不会跑，测出来的是上一次的色
  await ev(`localStorage.setItem('tk.theme','${theme}');location.hash='#/';1`);
  await ev(`location.reload();1`).catch(() => {});
  await new Promise((r) => setTimeout(r, 2600));
  for (const c of CASES) {
    await ev(`location.hash='${c.hash}';new Promise(r=>setTimeout(r,700))`);
    const g = await ev(GEOM);
    const f = `${model}-${g.w}x${g.h}-${theme}-${c.name}.png`;
    shot(f);
    const tag = `${theme} ${c.name} @${g.w}x${g.h}`;
    chk(g.overflowX <= 0 && !g.clipped.length, `${tag} 无横向溢出`, `溢出${g.overflowX} 越界${g.clipped.join('|')}`);
    chk(g.railOk, `${tag} 侧栏按宽度出现`, `rail=${g.rail}`);
    chk(g.theme === theme, `${tag} 主题生效`, `data-theme=${g.theme}`);
    chk(g.footFits, `${tag} 操作条不越界`, `footW=${g.footW}`);
    if (c.name === 'home') chk(g.tap >= 36, `${tag} 最小可点区域 ${g.tap}px「${g.tapWhat}」（应≥36）`);
  }
}
// 转屏：平板横屏要出侧栏。自动旋转是用户的设置，先读原值，测完原样还回去
const rot0 = adb(...dev, 'shell', 'settings', 'get', 'system', 'accelerometer_rotation');
await ev(`location.hash='#/';1`);
const before = await ev(GEOM);
console.log(`当前视口 ${before.w}x${before.h}，试转屏`);
const restore = () => {
  adb(...dev, 'shell', 'content', 'insert', '--uri', 'content://settings/system', '--bind', 'name:s:user_rotation', '--bind', 'i:0');
  if (rot0 !== 'null') adb(...dev, 'shell', 'settings', 'put', 'system', 'accelerometer_rotation', rot0);
};
try {
  adb(...dev, 'shell', 'settings', 'put', 'system', 'accelerometer_rotation', '0');
  adb(...dev, 'shell', 'content', 'insert', '--uri', 'content://settings/system', '--bind', 'name:s:user_rotation', '--bind', 'i:1');
  await new Promise((r) => setTimeout(r, 1600));
  const after = await ev(GEOM);
  shot(`rotate-${after.w}x${after.h}.png`);
  chk(after.w !== before.w, '转屏后视口变了', `${before.w}x${before.h} → ${after.w}x${after.h}`);
  chk(after.railOk, '转屏后侧栏跟着出现/收起', `w=${after.w} rail=${after.rail}`);
  chk(after.overflowX <= 0 && !after.clipped.length, '转屏后无溢出', `溢出${after.overflowX} 越界${after.clipped.join('|')}`);
} finally {
  restore();
}

adb(...dev, 'forward', '--remove', `tcp:${PORT}`);
console.log(`\n真机界面验收（${model}）：通过 ${pass} / 失败 ${fail}，截图 shots/ui-device/`);
process.exit(fail ? 1 : 0);

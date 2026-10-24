// 真机执行套件：在手机的 WebView 里真跑每个工具，产物传回 node 侧解析断言。
// 需要 toolbox-*-debug-test.apk（node tools/build-apk.mjs --test）
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { MIME, GEN, INSPECT, CASES, must, setOutDir } from './lib.mjs';
import { need } from './local.mjs';

const ADB = need('adb');
const PKG = 'com.qoder.toolbox';
const PORT = 9341;
const OUT = 'out/device';
fs.mkdirSync(OUT, { recursive: true });
setOutDir(OUT);

/** 大夹具不往设备里塞：photo.jpg 用同尺寸同算法的页内生成件替代 */
const SUBST = { 'photo.jpg': '@photo' };
/** 6.7MB 的扫描件不传，PDF 压缩改由下面的链式用例覆盖 */
const SKIP = new Set(['PDF 压缩 · 扫描版极限档']);

GEN['@photo'] = `(async()=>{
  const w=2200,h=1500,buf=new Uint8ClampedArray(w*h*4);
  let s=7;const rnd=()=>((s=(s*1103515245+12345)&0x7fffffff)/0x7fffffff);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){const i=(y*w+x)*4;
    const a=Math.sin(x/17+y/41)*0.5+0.5,b=Math.sin((x+y)/7)*0.5+0.5,c=Math.sin(x/3)*Math.cos(y/5)*0.5+0.5;
    buf[i]=a*200+b*55+rnd()*26;buf[i+1]=(1-a)*150+c*90+rnd()*26+y/h*30;buf[i+2]=b*120+c*120+rnd()*26+x/w*20;buf[i+3]=255;}
  const cv=new OffscreenCanvas(w,h);cv.getContext('2d').putImageData(new ImageData(buf,w,h),0,0);
  const b=await cv.convertToBlob({type:'image/jpeg',quality:0.96});
  return new File([b],'photo.jpg',{type:'image/jpeg'});
})()`;

function adb(...args) {
  return execFileSync(ADB, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
}
/** 必须显式认自己的机器：多设备时 adb 会报 more than one device，点按还会打进别人的手机 */
function pickSerial() {
  const want =
    process.env.ANDROID_SERIAL ?? process.argv.find((a) => a.startsWith('--serial='))?.split('=')[1] ?? need('serialPhone');
  const lines = adb('devices')
    .split(/\r?\n/)
    .slice(1)
    .map((l) => l.split(/\t/))
    .filter((a) => a[1] === 'device')
    .map((a) => a[0]);
  const hits = [...new Set(lines.filter((s) => s.includes(want)))];
  if (!hits.length) throw new Error(`没找到序列号含 "${want}" 的设备；在线 ${lines.length} 台：${lines.join(' , ')}`);
  return hits[0];
}
const serial = pickSerial();
const dev = ['-s', serial];

adb(...dev, 'shell', 'input', 'keyevent', '224');
adb(...dev, 'shell', 'wm', 'dismiss-keyguard');
if (!/mWakefulness=Awake/.test(adb(...dev, 'shell', 'dumpsys', 'power'))) throw new Error('屏幕没醒');
const mf = /mCurrentFocus=Window\{\S+ \S+ (\S?)[/}]/.exec(adb(...dev, 'shell', 'dumpsys', 'window'))?.[1] ?? '';
if (/incallui|telecom|dialer/i.test(mf)) throw new Error(`设备正在通话（${mf}）`);

const apk = 'toolbox-0.1.0-debug-test.apk';
if (!fs.existsSync(apk)) throw new Error(`先跑 node tools/build-apk.mjs --test 生成 ${apk}`);
console.log('安装', apk);
console.log(adb('-s', serial, 'install', '-r', path.resolve(apk)).slice(-40));

adb(...dev, 'shell', 'am', 'force-stop', PKG);
adb(...dev, 'shell', 'am', 'start', '-n', `${PKG}/com.qoder.toolbox.MainActivity`);
await new Promise((r) => setTimeout(r, 4500));

const pid = adb(...dev, 'shell', 'pidof', PKG).trim().split(/\s+/)[0];
if (!pid) throw new Error('进程没起来');
adb(...dev, 'forward', `tcp:${PORT}`, `localabstract:webview_devtools_remote_${pid}`);

let target = null;
for (let i = 0; i < 30 && !target; i++) {
  await new Promise((r) => setTimeout(r, 400));
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl && t.description?.includes('visible'));
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
const pageErrors = [];
ws = new WebSocket(target.webSocketDebuggerUrl);
await connect();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Runtime.exceptionThrown') pageErrors.push((m.params.exceptionDetails.exception?.description ?? '').slice(0, 200));
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
};
function send(method, params = {}) {
  const id = ++mid;
  return new Promise((res, rej) => {
    const t = setTimeout(() => (pending.delete(id), rej(new Error('timeout ' + method))), 30_000);
    pending.set(id, (v) => (clearTimeout(t), v.error ? rej(new Error(JSON.stringify(v.error))) : res(v.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
}
function ev(expr, ms = 180_000) {
  const id = ++mid;
  return new Promise((res, rej) => {
    const t = setTimeout(() => (pending.delete(id), rej(new Error(`求值超时 ${Math.round(ms / 1000)}s`))), ms);
    pending.set(id, (v) => {
      clearTimeout(t);
      if (v.error) return rej(new Error(JSON.stringify(v.error)));
      const r = v.result;
      if (r.exceptionDetails) return rej(new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
      res(r.result.value);
    });
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
  });
}
await send('Runtime.enable');

if (!(await ev('!!window.__tk'))) throw new Error('测试钩子没进包，请用 --test 重新构建');
console.log('已连上', target.url, '| 工具', (await ev('__tk.tools.length')));

function oneFile(f) {
  if (f === '@bigpdf') return 'window.__bigpdf';
  const key = SUBST[f] ?? f;
  if (GEN[key]) return `(await (${GEN[key]}))`;
  const b64 = fs.readFileSync(path.join('fixtures', key)).toString('base64');
  const mime = MIME[key.split('.').pop()] ?? 'application/octet-stream';
  // 分块解码，一次 atob 几 MB 在手机上会占住主线程
  return `(await (async()=>{const p='${b64}';const bin=atob(p);const u=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)u[i]=bin.charCodeAt(i);return new File([u],'${key}',{type:'${mime}'});})())`;
}

const DEVICE_ONLY = [
  {
    id: 'img-to-pdf',
    name: '链式 · 三张大图先合成 PDF 再压',
    files: ['@photo', '@photo', '@photo'],
    opts: { page: 'a4', margin: 0, merge: 'one', quality: 95 },
    check(outs, insp) {
      must(insp[0].pages === 3, `应 3 页，实际 ${insp[0].pages}`);
      return { 页数: 3, 体积KB: Math.round(outs[0].size / 1024) };
    },
  },
  {
    id: 'pdf-compress',
    name: 'PDF 压缩 · 大图版极限档',
    files: ['@bigpdf'],
    opts: { level: 'tiny', maxSide: 1600 },
    check(outs, insp) {
      must(insp[0].pages === 3, `页数变了：${insp[0].pages}`);
      must(outs[0].size < 3 * 1024 * 1024, `没压下来：${(outs[0].size / 1024).toFixed(0)}KB`);
      return { 体积KB: Math.round(outs[0].size / 1024), note: outs[0].note };
    },
  },
];

const t0 = Date.now();
let pass = 0;
let fail = 0;
const rows = [];
const cases = CASES.filter((c) => !SKIP.has(c.name)).concat(DEVICE_ONLY);

/** 屏幕一熄 WebView 的定时器就被冻结，之后的每条用例都会挂满超时，所以每条前确认还亮着 */
function ensureAwake() {
  const pow = () => adb(...dev, 'shell', 'dumpsys', 'power');
  if (/mWakefulness=Awake/.test(pow())) return;
  adb(...dev, 'shell', 'input', 'keyevent', '224');
  adb(...dev, 'shell', 'wm', 'dismiss-keyguard');
  for (let i = 0; i < 8; i++) {
    if (/mWakefulness=Awake/.test(pow())) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600);
  }
  throw new Error('屏幕熄了且叫不醒，把手机点亮并解锁再重跑');
}

// 连续 3 条超时/设备掉线就不是工具的问题了，是设备或链路没了，继续跑只会白等几小时
let deadStreak = 0;

for (const c of cases) {
    const started = Date.now();
  try {
    ensureAwake();
    const files = c.files.map(oneFile).join(',');
    const body = `(async()=>{
      const files=[${files}];
      try {
        const r = await __tk.run(${JSON.stringify(c.id)}, files, ${JSON.stringify(c.opts ?? {})});
        if (r && r[0] && r[0].kind === 'pdf') {
          const bin = atob(r[0].b64); const u = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
          window.__bigpdf = new File([u], 'big.pdf', { type: 'application/pdf' });
        }
        return r;
      } catch(e){ return {__err:String(e&&e.message||e)}; }
    })()`;
    const outs = await ev(body, 300_000);
    if (outs && outs.__err) {
      if (c.expectError && c.expectError.test(outs.__err)) {
        pass++;
        rows.push({ 状态: '通过', 用例: c.name, 详情: `按预期报错：${outs.__err.slice(0, 110)}` });
        continue;
      }
      throw new Error(outs.__err);
    }
    if (!Array.isArray(outs)) throw new Error('没拿到结果数组');
    const insp = [];
    for (const o of outs) {
      const fn = INSPECT[o.kind];
      if (fn) insp.push(await fn(o.b64, o.name));
      fs.writeFileSync(path.join(OUT, o.name), Buffer.from(o.b64, 'base64'));
    }
    const detail = c.check(outs, insp);
    pass++;
    deadStreak = 0;
    rows.push({ 状态: '通过', 用例: c.name, 耗时ms: Date.now() - started, 详情: JSON.stringify(detail) });
  } catch (e) {
    fail++;
    const msg = String(e.message);
    rows.push({ 状态: '失败', 用例: c.name, 耗时ms: Date.now() - started, 详情: msg.slice(0, 240) });
    if (/求值超时|not found|device offline|Closed|屏幕熄了|Command failed/.test(msg) && ++deadStreak >= 3) {
      console.log(`\n连续 ${deadStreak} 条打不通，停在这里（手机熄屏或 adb 无线连接掉了）。已跑结果见下：`);
      break;
    }
  }
  const last = rows[rows.length - 1];
  console.log(`${last.状态}  ${last.用例}  ${last.详情}`);
}

fs.writeFileSync(path.join(OUT, 'device-report.json'), JSON.stringify({ at: new Date().toISOString(), pass, fail, rows, pageErrors }, null, 2));
console.log(`\n真机 通过 ${pass} / 失败 ${fail}，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s，产物与报告在 ${OUT}/`);
if (pageErrors.length) {
  console.log('页面未捕获异常：');
  for (const e of pageErrors.slice(0, 8)) console.log('  ' + e);
}
adb(...dev, 'forward', '--remove', `tcp:${PORT}`);
process.exit(fail ? 1 : 0);

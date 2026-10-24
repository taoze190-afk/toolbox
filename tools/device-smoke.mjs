// 真机冒烟：启动 App，连 WebView 的 DevTools，验渲染 + 逐个探静态资源可达性
import { execFileSync } from 'node:child_process';
import { need } from './local.mjs';

const ADB = need('adb');
const PKG = 'com.qoder.toolbox';
const PORT = 9340;

function adb(...args) {
  return execFileSync(ADB, args, { encoding: 'utf8', maxBuffer: 40 * 1024 * 1024 }).trim();
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
console.log('设备', serial);

// 屏幕必须醒着，否则 WebView 被节流，求值永远不回话
adb(...dev, 'shell', 'input', 'keyevent', '224');
adb(...dev, 'shell', 'wm', 'dismiss-keyguard');
const wake = adb(...dev, 'shell', 'dumpsys', 'power');
if (!/mWakefulness=Awake/.test(wake)) throw new Error('屏幕没醒，中止');
// 只看 mCurrentFocus：整份 dump 里有历史记录，会误判成"正在通话"
const focus = adb(...dev, 'shell', 'dumpsys', 'window');
const mf = /mCurrentFocus=Window\{\S+ \S+ (\S+?)[/}]/.exec(focus)?.[1] ?? '';
console.log('前台', mf || '(读不到)');
if (/incallui|telecom|dialer/i.test(mf)) throw new Error(`设备正在通话（${mf}），不打扰`);

adb(...dev, 'shell', 'am', 'force-stop', PKG);
adb(...dev, 'shell', 'am', 'start', '-n', `${PKG}/com.qoder.toolbox.MainActivity`);
await new Promise((r) => setTimeout(r, 4000));

const pid = adb(...dev, 'shell', 'pidof', PKG).trim().split(/\s+/)[0];
if (!pid) throw new Error('进程没起来');
adb(...dev, 'forward', `tcp:${PORT}`, `localabstract:webview_devtools_remote_${pid}`);

let list = [];
for (let i = 0; i < 20; i++) {
  try {
    list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    if (list.some((t) => t.type === 'page')) break;
  } catch {
    /* 还没起 */
  }
  await new Promise((r) => setTimeout(r, 500));
}
const target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl && t.description?.includes('visible'));
if (!target) throw new Error('找不到前台 WebView，页面列表：' + list.map((t) => t.title + '|' + t.description).join(' , '));
console.log('页面', target.url, target.title);

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
const errors = [];
function ev(expr, ms = 30_000) {
  const id = ++mid;
  return new Promise((res, rej) => {
    const t = setTimeout(() => {
      pending.delete(id);
      rej(new Error('求值超时'));
    }, ms);
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
function send(method, params = {}) {
  const id = ++mid;
  return new Promise((res, rej) => {
    const t = setTimeout(() => (pending.delete(id), rej(new Error('timeout ' + method))), 20_000);
    pending.set(id, (v) => (clearTimeout(t), v.error ? rej(new Error(JSON.stringify(v.error))) : res(v.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
}

ws = new WebSocket(target.webSocketDebuggerUrl);
await connect();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    errors.push((d.exception?.description ?? d.text ?? '').slice(0, 200));
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    errors.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 200));
  }
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
};
await send('Runtime.enable');
await send('Log.enable').catch(() => {});

const geom = await ev(`({w:innerWidth,h:innerHeight,dpr:devicePixelRatio,cards:document.querySelectorAll('main button').length,title:document.title,body:document.body.innerText.slice(0,40)})`);
console.log('视口', `${geom.w}×${geom.h}@${geom.dpr}`, '卡片', geom.cards, JSON.stringify(geom.body));
if (geom.w < 300) throw new Error('视口宽度异常，页面可能不在前台');
if (geom.cards < 17) throw new Error(`首页只渲染出 ${geom.cards} 个工具`);

const assets = [
  'pdfjs/pdf.worker.min.mjs',
  'pdfjs/cmaps/Adobe-CNS1-0.bcmap',
  'tesseract/worker.min.js',
  'tesseract/core/tesseract-core-simd.wasm.js',
  'tessdata/chi_sim.traineddata',
  'tessdata/eng.traineddata',
];
const probe = await ev(
  `(async()=>{const out={};for(const p of ${JSON.stringify(assets)}){try{const r=await fetch(new URL(p,document.baseURI).href);out[p]=r.status+' '+(r.headers.get('content-length')??'?');}catch(e){out[p]='ERR '+e.message;}}return out;})()`,
  60_000,
);
let bad = 0;
for (const [k, v] of Object.entries(probe)) {
  const ok = /^200 /.test(v);
  if (!ok) bad++;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${k}  ${v}`);
}
if (bad) throw new Error(`${bad} 个静态资源在真机上取不到`);

const caps = await ev(`({sab:!!self.SharedArrayBuffer, wasm:typeof WebAssembly==='object', simd:WebAssembly.validate(new Uint8Array([0,97,115,109,1,0,0,0,1,5,1,96,0,1,123,3,2,1,0,10,10,1,8,0,65,0,253,15,253,98,11])), fs:!!window.Capacitor, plugins:window.Capacitor?Object.keys(window.Capacitor.Plugins||{}):[], storage:false})`);
console.log('能力', JSON.stringify(caps));
if (!caps.simd) throw new Error('设备不支持 wasm SIMD，OCR 会挂');
if (!caps.fs) throw new Error('Capacitor 桥没注入');
if (!caps.plugins.includes('Filesystem') || !caps.plugins.includes('Share')) {
  throw new Error(`插件没注册全：${caps.plugins.join(',')}`);
}

// 真跑一次图片压缩：证明 canvas 编码链在 WebView 里可用
const real = await ev(
  `(async()=>{
    const c=document.createElement('canvas');c.width=1600;c.height=1200;
    const g=c.getContext('2d');g.fillStyle='#7aa';g.fillRect(0,0,1600,1200);
    for(let i=0;i<3000;i++){g.fillStyle='hsl('+(i*37%360)+',60%,'+(20+i%60)+'%)';g.fillRect((i*97)%1600,(i*53)%1200,8,8);}
    const b=await new Promise(r=>c.toBlob(r,'image/jpeg',0.95));
    const f=new File([b],'device.jpg',{type:'image/jpeg'});
    const cv2=document.createElement('canvas');cv2.width=40;cv2.height=40;
    const okEnc=await new Promise(r=>cv2.toBlob((x)=>r(!!x&&x.size>0),'image/webp'));
    return {src:b.size, webpEncode:okEnc, bitmap:!!(await createImageBitmap(f).then(()=>true).catch(()=>false))};
  })()`,
  60_000,
);
console.log('编码链', JSON.stringify(real));
if (!real.webpEncode) throw new Error('WebView 不能编码 WebP');
if (!real.bitmap) throw new Error('createImageBitmap 不可用');

const shot = execFileSync(ADB, [...dev, 'exec-out', 'screencap', '-p'], { maxBuffer: 64 * 1024 * 1024 });
import('node:fs').then(({ default: fs }) => fs.writeFileSync('shots/device-home.png', shot));
console.log('截图 shots/device-home.png', (shot.length / 1024).toFixed(0), 'KB');

if (errors.length) {
  console.log('--- 页面报错 ---');
  for (const e of errors.slice(0, 10)) console.log('  ' + e);
  throw new Error(`${errors.length} 条运行时错误`);
}
console.log('\n真机冒烟通过');
adb(...dev, 'forward', '--remove', `tcp:${PORT}`);

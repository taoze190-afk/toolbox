// 真机端到端：在设置页选「自建服务」、填地址和令牌、点验证并启用，然后真调一次 Word 转 PDF 走服务器。
// 用法：node tools/device-selfhost.mjs   （地址和令牌从 server/.selfhost 读）
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { need } from './local.mjs';

const ADB = need('adb');
const PKG = 'com.qoder.toolbox';
const PORT = 9344;
const BASE = process.env.SELF_BASE ?? need('selfHostBase');
const TOKEN = fs.readFileSync('server/.token', 'utf8').trim();

function adb(...a) {
  return execFileSync(ADB, a, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
}
const want = process.env.ANDROID_SERIAL ?? need('serialPhone');
const online = adb('devices')
  .split(/\r?\n/)
  .slice(1)
  .map((l) => l.split(/\t/))
  .filter((a) => a[1] === 'device')
  .map((a) => a[0]);
const hit = [...new Set(online.filter((s) => s.includes(want)))][0];
if (!hit) throw new Error(`没找到含 ${want} 的设备；在线：${online.join(' , ')}`);
const dev = ['-s', hit];

adb(...dev, 'shell', 'input', 'keyevent', '224');
adb(...dev, 'shell', 'wm', 'dismiss-keyguard');
// 亮屏指令发过去到状态真变 Awake 之间有一拍，立刻读会误判成"屏幕没醒"
let awake = false;
for (let i = 0; i < 8 && !awake; i++) {
  await new Promise((r) => setTimeout(r, 700));
  awake = /mWakefulness=Awake/.test(adb(...dev, 'shell', 'dumpsys', 'power'));
}
if (!awake) throw new Error('屏幕没醒');
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

function who() {
  try {
    return /mCurrentFocus=Window\{\S+ \S+ (\S+?)[/}]/.exec(adb(...dev, 'shell', 'dumpsys', 'window'))?.[1] ?? '(读不到)';
  } catch {
    return '(读不到)';
  }
}
let ws, mid = 0;
const pending = new Map();
ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error(`连不上 WebView（10s）；前台是 ${who()}`)), 10_000);
  ws.onopen = () => (clearTimeout(t), res());
  ws.onerror = () => (clearTimeout(t), rej(new Error('CDP 连接失败')));
});
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) (0, pending.get(m.id))(m), pending.delete(m.id);
};
function ev(expr, ms = 60_000) {
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
await ev(`(async()=>{location.hash='#/settings';await new Promise(r=>setTimeout(r,900));return 1;})()`);

const shot = (f) => fs.writeFileSync(path.join('shots', f), execFileSync(ADB, [...dev, 'exec-out', 'screencap', '-p'], { maxBuffer: 64 * 1024 * 1024 }));

let pass = 0;
let fail = 0;
const chk = (name, ok, extra = '') => {
  if (ok) { pass++; console.log(`通过  ${name}${extra ? '  ' + extra : ''}`); }
  else { fail++; console.log(`失败  ${name}${extra ? '  ' + extra : ''}`); }
};

// 1) 点「自建服务」，确认服务地址输入框出现
const afterPick = await ev(`(async()=>{
  const b=[...document.querySelectorAll('button')].find(x=>x.innerText.trim()==='自建服务');
  if(!b) return {err:'没有自建服务按钮'};
  b.click(); await new Promise(r=>setTimeout(r,500));
  return {inputs:[...document.querySelectorAll('input')].map(i=>i.placeholder),
          labels:[...document.querySelectorAll('main .divide-y > div')].map(d=>d.innerText.split('\\n')[0])};
})()`);
chk('选自建服务后出现服务地址输入', (afterPick.inputs ?? []).some((p) => /29433|https/.test(p)), JSON.stringify(afterPick.labels));
shot('device-settings-selfhost.png');

// 2) 填地址和令牌（React 受控输入要走原生 setter + input 事件），点「验证并启用」
const verified = await ev(`(async()=>{
  const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
  const put=(el,v)=>{set.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));};
  const ins=[...document.querySelectorAll('input')];
  const url=ins.find(i=>/https/.test(i.placeholder)); const tok=ins.find(i=>/安装脚本|API key/.test(i.placeholder));
  if(!url||!tok) return {err:'找不到输入框', got:ins.map(i=>i.placeholder)};
  put(url, ${JSON.stringify(BASE)}); put(tok, ${JSON.stringify(TOKEN)});
  await new Promise(r=>setTimeout(r,200));
  const btn=[...document.querySelectorAll('button')].find(b=>b.innerText.includes('验证并启用'));
  if(btn.disabled) return {err:'按钮还是灰的'};
  btn.click();
  const sel=() => document.querySelector('main p.text-good, main p.text-bad');
  for(let i=0;i<60;i++){ await new Promise(r=>setTimeout(r,500));
    const p=sel(); if(p && !/连接中/.test(p.innerText) && p.innerText.trim()) break; }
  const p=sel();
  return {msg:p?p.innerText:'', saved:JSON.parse(localStorage.getItem('tk.settings')||'{}')};
})()`, 90_000);
chk('手机上验证并启用成功', /已连通/.test(verified.msg ?? ''), verified.msg ?? JSON.stringify(verified.err));
chk(
  '设置已落盘（provider/baseUrl/令牌）',
  verified.saved?.provider === 'self' && verified.saved?.baseUrl === BASE && !!verified.saved?.ccKey,
  JSON.stringify({ provider: verified.saved?.provider, baseUrl: verified.saved?.baseUrl, keyLen: (verified.saved?.ccKey ?? '').length }),
);
shot('device-settings-verified.png');

// 3) 真调一次 Word 转 PDF：产物应带「自建服务」标记，且内容非空白
const docxB64 = fs.readFileSync(path.join('fixtures', 'cn.docx')).toString('base64');
const conv = await ev(`(async()=>{
  const bin=atob(${JSON.stringify(docxB64)}); const u=new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++)u[i]=bin.charCodeAt(i);
  const f=new File([u],'中文长文.docx',{type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'});
  const t0=Date.now();
  try{ const r=await __tk.run('word-to-pdf',[f],{paper:'a4',margin:'normal',fontSize:10.5,skipImage:false});
       return {ms:Date.now()-t0, name:r[0].name, size:r[0].size, note:r[0].note, kind:r[0].kind, b64:r[0].b64.slice(0,64)}; }
  catch(e){ return {err:String(e&&e.message||e)}; }
})()`, 300_000);
if (conv.err) {
  chk('走服务器完成一次转换', false, conv.err);
} else {
  const isPdf = conv.b64.startsWith('JVBER');
  chk('走服务器完成一次转换', /自建服务/.test(conv.note) && isPdf, `${conv.name} ${(conv.size / 1024).toFixed(0)}KB ${conv.ms}ms · ${conv.note}`);
}
shot('device-selfhost-final.png');

adb(...dev, 'forward', '--remove', `tcp:${PORT}`);
console.log(`\n真机自建服务链路：通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);

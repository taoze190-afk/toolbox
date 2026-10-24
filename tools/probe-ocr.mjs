// 流式探 OCR：页面把每一步推进 window.__trace，node 侧轮询打印，卡住也能看出卡在哪一步
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

import { opt } from './local.mjs';

const CHROME = opt('chrome') ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const APP = 'http://127.0.0.1:5175/';
const PORT = 9334;

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${path.join(os.tmpdir(), 'tk-chrome-probe')}`,
    '--no-first-run',
    '--disable-gpu',
    'about:blank',
  ],
  { stdio: 'ignore' },
);
process.on('exit', () => chrome.kill());

let ws;
let mid = 0;
const pending = new Map();
const consoleLines = [];
function send(method, params = {}) {
  return new Promise((res, rej) => {
    const id = ++mid;
    const t = setTimeout(() => (pending.delete(id), rej(new Error('timeout ' + method))), 60_000);
    pending.set(id, (v) => (clearTimeout(t), v.error ? rej(new Error(JSON.stringify(v.error))) : res(v.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function ev(expr, ms = 60_000) {
  const id = ++mid;
  return new Promise((res, rej) => {
    const t = setTimeout(() => (pending.delete(id), rej(new Error('求值超时'))), ms);
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

let target = null;
for (let i = 0; i < 60 && !target; i++) {
  await new Promise((r) => setTimeout(r, 300));
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  } catch {
    /* 还没起 */
  }
}
ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Runtime.consoleAPICalled') consoleLines.push(m.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
  if (m.method === 'Runtime.exceptionThrown') consoleLines.push('EX ' + (m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text));
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
};
await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url: APP });
await new Promise((r) => setTimeout(r, 2500));

const say = (k, v) => console.log(`  ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);

console.log('[1] 静态资源');
say(
  'assets',
  await ev(`(async()=>{const o={};for(const p of ['tesseract/worker.min.js','tesseract/core/tesseract-core-simd.wasm.js','tessdata/chi_sim.traineddata','tessdata/eng.traineddata']){try{const r=await fetch(new URL(p,document.baseURI).href);o[p]=r.status+' '+(r.headers.get('content-length')??'?');}catch(e){o[p]='ERR '+e.message;}}return o;})()`),
);

console.log('[2] 启动 worker（不等待，推进 __trace）');
await ev(`(async()=>{
  window.__trace=[]; const T=(s)=>{window.__trace.push(s+' @'+Math.round(performance.now()));};
  try{
    T('import ocr');
    const m = await import('/src/core/ocr.ts');
    T('imported');
    const w = await m.getOcrWorker('chi_sim+eng',(p)=>T('prog '+(p.label||'')+':'+(p.done||0).toFixed(2)));
    T('worker ready');
    const c=document.createElement('canvas');c.width=900;c.height=200;
    const g=c.getContext('2d');g.fillStyle='#fff';g.fillRect(0,0,900,200);g.fillStyle='#000';g.textBaseline='top';g.font='52px system-ui, sans-serif';g.fillText('Hello 肌电手势 12345',30,70);
    T('recognize...');
    const r=await m.ocrImage(c,'chi_sim+eng',(p)=>T('rec '+(p.label||'')+':'+(p.done||0).toFixed(2)));
    window.__res={text:r.text,conf:r.conf,lines:r.lines.length};
    T('done');
  }catch(e){ window.__res={error:String(e&&e.message||e)}; T('ERR '+String(e&&e.message||e)); }
  return 'started';
})()`, 5_000).catch((e) => say('note', '长任务已挂起：' + e.message));

let last = 0;
for (let i = 0; i < 100; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  const t = await ev('window.__trace ? window.__trace.slice(0) : []').catch(() => []);
  for (const line of t.slice(last)) say('trace', line);
  last = t.length;
  const res = await ev('window.__res ?? null').catch(() => null);
  if (res) {
    say('结果', { text: String(res.text ?? '').slice(0, 120), conf: res.conf, lines: res.lines, error: res.error });
    break;
  }
  if (i === 29) console.log('  ... 60s 无进展，判定为卡死');
}
if (consoleLines.length) {
  console.log('--- 页面 console ---');
  for (const l of consoleLines.slice(-20)) console.log('  ' + l.slice(0, 240));
}

console.log('[3] 走 __tk.run 的完整链路');
const r3 = await ev(
  `(async()=>{
    const c=document.createElement('canvas');c.width=1100;c.height=460;
    const g=c.getContext('2d');g.fillStyle='#fff';g.fillRect(0,0,1100,460);g.fillStyle='#000';g.textBaseline='top';
    ['表面肌电信号手势识别实验报告','第一章 采集平台的搭建与调试','采样率设置为一千赫兹，工频陷波五十赫兹','受试者十二名，每人完成十一类手势各二十次']
      .forEach((t,i)=>{g.font=(i===0?'bold 46px':'34px')+' system-ui, sans-serif';g.fillText(t,40,40+i*100);});
    const b=await new Promise(r=>c.toBlob(r,'image/png'));
    const f=new File([b],'text-cn.png',{type:'image/png'});
    const info={fileName:f.name,fileSize:f.size,fileType:f.type};
    try{ const outs=await __tk.run('img-to-word',[f],{langs:'chi_sim+eng',scale:2,mergeWrap:true,output:'one'}); info.outs=outs.map(o=>({name:o.name,size:o.size,note:o.note})); }
    catch(e){ info.err=String(e&&e.message||e); }
    return info;
  })()`,
  180_000,
).catch((e) => ({ thrown: String(e.message) }));
say('结果', r3);


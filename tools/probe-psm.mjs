// 对比 tesseract 各 PSM 在"表格照"上能不能拆出列：看词数与 x 起点聚类数
import path from 'node:path';
import { spawn } from 'node:child_process';

import { opt } from './local.mjs';

const CHROME = opt('chrome') ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9335;
const chrome = spawn(
  CHROME,
  ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(process.env.TEMP, 'tk-chrome-psm')}`, '--no-first-run', '--disable-gpu', 'about:blank'],
  { stdio: 'ignore' },
);
process.on('exit', () => chrome.kill());

let ws, mid = 0;
const pending = new Map();
function send(m, p = {}) {
  return new Promise((res, rej) => {
    const id = ++mid;
    const t = setTimeout(() => (pending.delete(id), rej(new Error('t ' + m))), 60_000);
    pending.set(id, (v) => (clearTimeout(t), v.error ? rej(new Error(JSON.stringify(v.error))) : res(v.result)));
    ws.send(JSON.stringify({ id, method: m, params: p }));
  });
}
function ev(expr, ms = 180_000) {
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
    target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  } catch {
    /* 还没起 */
  }
}
ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) (0, pending.get(m.id))(m), pending.delete(m.id);
};
await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url: 'http://127.0.0.1:5175/' });
await new Promise((r) => setTimeout(r, 2500));

const out = await ev(`(async()=>{
  const m = await import('/src/core/ocr.ts');
  const { flatten, resize, decode, iw, ih, makeCanvas } = await import('/src/core/images.ts');
  const W=590,H=310;
  const src=document.createElement('canvas');src.width=W;src.height=H;
  const g=src.getContext('2d');g.fillStyle='#fff';g.fillRect(0,0,W,H);
  const cols=['学号','姓名','班级','平时分','期末分'];const cw=[130,130,110,120,120];const rh=52;
  const rows=[[101,'张三','一班',88,92],[102,'李四','二班',76,81],[103,'王五','三班',95,89],[104,'赵六','一班',67,73]];
  g.strokeStyle='#333';g.lineWidth=2;
  for(let r=0;r<=rows.length;r++){g.beginPath();g.moveTo(0,r*rh);g.lineTo(W,r*rh);g.stroke();}
  let x=0;for(let k=0;k<=cols.length;k++){g.beginPath();g.moveTo(x,0);g.lineTo(x,H);g.stroke();x+=cw[k]??0;}
  g.textBaseline='middle';g.fillStyle='#000';
  cols.forEach((t,k)=>{g.font='bold 26px system-ui, sans-serif';g.fillText(t,cw.slice(0,k).reduce((a,b)=>a+b,0)+14,rh/2);});
  rows.forEach((rw,ri)=>rw.forEach((t,k)=>{g.font='26px system-ui, sans-serif';g.fillText(String(t),cw.slice(0,k).reduce((a,b)=>a+b,0)+14,(ri+1.5)*rh);}));

  const big = resize(src, W*2, H*2, makeCanvas(W*2,H*2));
  const work = flatten(big);

  function strip(cv){
    const gg=cv.getContext('2d',{willReadFrequently:true});const w=cv.width,h=cv.height;
    const im=gg.getImageData(0,0,w,h),d=im.data;
    const lum=(i)=>d[i]*0.299+d[i+1]*0.587+d[i+2]*0.114;
    const dr=new Float32Array(h),dc=new Float32Array(w);
    for(let y=0;y<h;y++)for(let xx=0;xx<w;xx++){const i=(y*w+xx)*4;if(lum(i)<160){dr[y]++;dc[xx]++;}}
    for(let y=0;y<h;y++){if(dr[y]/w<=0.55)continue;for(let xx=0;xx<w;xx++){const i=(y*w+xx)*4;if(lum(i)<200){d[i]=d[i+1]=d[i+2]=255;}}}
    for(let xx=0;xx<w;xx++){if(dc[xx]/h<=0.55)continue;for(let y=0;y<h;y++){const i=(y*w+xx)*4;if(lum(i)<200){d[i]=d[i+1]=d[i+2]=255;}}}
    gg.putImageData(im,0,0);
  }

  const cluster=(vals,tol)=>{const s=vals.slice().sort((a,b)=>a-b);const out=[];for(const v of s){if(!out.length||v-out[out.length-1][out.length-1][1]>tol)out.push([[v,v]]);else out[out.length-1][0][1]=v;}return out.length;};

  const res = {};
  for (const psm of ['3','4','6','11']) {
    strip(work);
    const r = await m.ocrImage(work, 'chi_sim+eng', undefined, psm);
    const words=[];for(const l of r.lines)for(const w of l.words)words.push(w);
    const mh = words.length? words.map(x=>x.h).sort((a,b)=>a-b)[Math.floor(words.length/2)] : 20;
    const tol = Math.max(8, 1.6*mh);
    const starts = words.map(w=>w.x);
    const uniq = new Set(starts.map(v=>Math.round(v/tol)));
    res['psm'+psm] = { lines:r.lines.length, words:words.length, mh:Math.round(mh), tol:Math.round(tol),
      distinctStarts: new Set(starts.map(v=>Math.round(v/10))).size,
      sample: words.slice(0,10).map(w=>w.text), conf: Math.round(r.conf) };
  }
  return res;
})()`);

console.log(JSON.stringify(out, null, 1));

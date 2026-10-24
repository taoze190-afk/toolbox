// 验证 A+D 分流：图片拼成的"扫描件"PDF（无文字层）→ 自动 OCR → docx / xlsx
// 同时验关掉识别时必须明确报错，不能静默出空文件。
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { GEN } from './lib.mjs';

const require = createRequire(import.meta.url);
import { opt } from './local.mjs';

const CHROME = opt('chrome') ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const APP = process.env.APP_URL ?? 'http://127.0.0.1:5175/';
const PORT = 9346;

const chrome = spawn(
  CHROME,
  ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(process.env.TEMP, 'tk-scan')}`, '--no-first-run', '--disable-gpu', 'about:blank'],
  { stdio: 'ignore' },
);
process.on('exit', () => chrome.kill());

let ws, mid = 0;
const pending = new Map();
const errs = [];

// 等 chrome 起来拿 target
let target = null;
for (let i = 0; i < 60 && !target; i++) {
  await new Promise((r) => setTimeout(r, 300));
  try {
    target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(
      (t) => t.type === 'page' && t.webSocketDebuggerUrl,
    );
  } catch {
    /* 还没起 */
  }
}
if (!target) throw new Error('Chrome 没起来');
ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => {
  ws.onopen = r;
  const t = setTimeout(() => j(new Error('连不上 CDP（10s）')), 10_000);
  ws.onerror = () => (clearTimeout(t), j(new Error('CDP 失败')));
});
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Runtime.exceptionThrown') errs.push((m.params.exceptionDetails.exception?.description ?? '').slice(0, 200));
  if (m.id && pending.has(m.id)) (0, pending.get(m.id))(m), pending.delete(m.id);
};
function send(method, params = {}) {
  const id = ++mid;
  return new Promise((res, rej) => {
    const t = setTimeout(() => (pending.delete(id), rej(new Error('timeout ' + method))), 30_000);
    pending.set(id, (v) => (clearTimeout(t), v.error ? rej(new Error(JSON.stringify(v.error))) : res(v.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
}
function ev(expr, ms = 240_000) {
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
await send('Page.enable');
await send('Page.navigate', { url: APP });
for (let i = 0; i < 40; i++) {
  try {
    if (await ev('!!window.__tk', 15_000)) break;
  } catch {
    /* 换页中 */
  }
  await new Promise((r) => setTimeout(r, 400));
}

// 把两张图拼成"扫描件"PDF，再分别走 pdf-to-word / pdf-to-excel
const expr = `(async()=>{
  const textImg = await (${GEN['@textimg']});
  const tableImg = await (${GEN['@tableimg']});

  // 合成只有图片、没有文字层的 PDF
  const mkPdf = async (file) => {
    const r = await __tk.run('img-to-pdf', [file], { page: 'fit', merge: 'one', margin: 0 });
    const bin = atob(r[0].b64); const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return new File([u], 'scan.pdf', { type: 'application/pdf' });
  };
  const scanText = await mkPdf(textImg);
  const scanTable = await mkPdf(tableImg);

  const out = { sizes: { scanText: scanText.size, scanTable: scanTable.size } };
  const grab = (r) => ({ name: r[0].name, size: r[0].size, note: r[0].note, b64: r[0].b64 });

  try { out.word = grab(await __tk.run('pdf-to-word', [scanText], { ocr: true, langs: 'chi_sim+eng', ocrDpi: 200 })); }
  catch (e) { out.wordErr = String(e.message); }

  try { out.excel = grab(await __tk.run('pdf-to-excel', [scanTable], { ocr: true, langs: 'chi_sim+eng', ocrDpi: 200, colTol: 'mid', layout: 'page' })); }
  catch (e) { out.excelErr = String(e.message); }

  // 关掉识别必须明确报错，不能静默给个空文件
  try {
    const r = await __tk.run('pdf-to-word', [scanText], { ocr: false });
    out.ocrOffShouldFail = false; out.ocrOffGot = r[0].note;
  } catch (e) { out.ocrOffShouldFail = true; out.ocrOffMsg = String(e.message); }

  // 有文字层的正常路径不能受影响
  const fr = await fetch('${'http://127.0.0.1:5199/text.pdf'}').catch(()=>null);
  return out;
})()`;

// 起一个夹具静态服务，供页面取 text.pdf 做对照
const http = await import('node:http');
const srv = http.createServer((req, res) => {
  const p = path.join('fixtures', decodeURIComponent(req.url).replace(/^\/+/, ''));
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (!fs.existsSync(p)) return void res.writeHead(404).end();
  res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => srv.listen(5199, '127.0.0.1', r));

const res = await ev(expr);

let pass = 0;
let fail = 0;
const chk = (name, ok, extra = '') => {
  if (ok) { pass++; console.log(`通过  ${name}${extra ? '  ' + extra : ''}`); }
  else { fail++; console.log(`失败  ${name}${extra ? '  ' + extra : ''}`); }
};

console.log('扫描件体积', JSON.stringify(res.sizes));

if (res.word) {
  fs.writeFileSync('out/scan-word.docx', Buffer.from(res.word.b64, 'base64'));
  const JSZip = require('jszip');
  const z = await JSZip.loadAsync(fs.readFileSync('out/scan-word.docx'));
  const xml = await z.file('word/document.xml').async('string');
  const text = [...xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]).join('');
  const hits = ['肌电', '手势', '采集平台', '采样率', '受试者'].filter((k) => text.includes(k));
  chk('扫描件 → Word（自动 OCR）', hits.length >= 2 && res.word.note.includes('识别'), `命中[${hits}] ${res.word.note}`);
  if (!text.length) console.log('   实际文字：', JSON.stringify(text.slice(0, 120)));
} else chk('扫描件 → Word（自动 OCR）', false, res.wordErr);

if (res.excel) {
  fs.writeFileSync('out/scan-table.xlsx', Buffer.from(res.excel.b64, 'base64'));
  const E = require('exceljs');
  const wb = new E.Workbook();
  await wb.xlsx.load(fs.readFileSync('out/scan-table.xlsx'));
  const w0 = wb.worksheets[0];
  chk('扫描表格 → Excel（自动 OCR）', w0.columnCount >= 3 && w0.rowCount >= 4, `${w0.rowCount}行×${w0.columnCount}列 ${res.excel.note}`);
} else chk('扫描表格 → Excel（自动 OCR）', false, res.excelErr);

chk('关掉识别时必须明确报错', res.ocrOffShouldFail === true, res.ocrOffMsg || res.ocrOffGot || '');

// 对照：有文字层的 PDF 不该触发 OCR
const ctl = await ev(`(async()=>{
  const r=await fetch('http://127.0.0.1:5199/text.pdf'); const b=await r.blob();
  const f=new File([b],'text.pdf',{type:'application/pdf'});
  const o=await __tk.run('pdf-to-word',[f],{ocr:true,langs:'chi_sim+eng',ocrDpi:200});
  return {note:o[0].note, size:o[0].size};
})()`);
chk('有文字层的页不走 OCR', !/识别/.test(ctl.note), ctl.note);

srv.close();
chrome.kill();
console.log(`\nA+D 分流验证：通过 ${pass} / 失败 ${fail}`);
if (errs.length) console.log('页面异常:', errs.slice(0, 3).join(' | '));
process.exit(fail ? 1 : 0);

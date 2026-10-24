// 真打转换服务，验证 6 个方向；产物在 node 侧解析内容后断言。
// 用法： CC_KEY=xxx node tools/test-remote.mjs [--provider=cloudconvert|convertapi]
//   或把 key 写进 cc.key 文件后直接 node tools/test-remote.mjs
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const CC = 'https://api.cloudconvert.com/v2';
const CV = 'https://v2.convertapi.com';
const PROVIDER = (process.argv.find((a) => a.startsWith('--provider=')) ?? '--provider=cloudconvert').split('=')[1];
const key = (process.env.CC_KEY ?? (fs.existsSync('cc.key') ? fs.readFileSync('cc.key', 'utf8') : '')).trim();

if (!key) {
  console.log('没给密钥。两种给法：\n  CC_KEY=你的key node tools/test-remote.mjs\n  或把 key 存进 cc.key（别提交出去）');
  process.exit(2);
}
console.log('服务商：', PROVIDER);

const JOBS = [
  { dir: 'docx>pdf', file: 'cn.docx', want: { pages: '>=1' } },
  { dir: 'pptx>pdf', file: 't.pptx', want: { pages: '>=1' } },
  { dir: 'xlsx>pdf', file: 't.xlsx', want: { pages: '>=1' } },
  { dir: 'pdf>docx', file: 'text.pdf', want: { text: /Electromyography/ } },
  { dir: 'pdf>xlsx', file: 'table.pdf', want: { cols: '>=4' } },
];

async function ccCall(p, init) {
  const r = await fetch(`${CC}${p}`, {
    ...init,
    headers: { Authorization: `Bearer ${key}`, ...(init?.body ? { 'Content-Type': 'application/json' } : {}) },
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${t.slice(0, 200)}`);
  return JSON.parse(t);
}

async function ccConvert(dir, file) {
  const [src, dst] = dir.split('>');
  const buf = fs.readFileSync(path.join('fixtures', file));
  const job = await ccCall('/jobs', {
    method: 'POST',
    body: JSON.stringify({
      tasks: {
        imp: { operation: 'import/upload' },
        conv: { operation: 'convert', input: 'imp', input_format: src, output_format: dst },
        exp: { operation: 'export', input: 'conv', input_format: dst },
      },
    }),
  });
  const id = job.data.id;
  const imp = job.data.tasks.find((t) => t.operation === 'import/upload');
  if (!imp?.form?.url) throw new Error('没拿到上传入口：' + JSON.stringify(imp).slice(0, 200));

  const fd = new FormData();
  for (const [k, v] of Object.entries(imp.form.parameters ?? {})) if (k !== 'file') fd.append(k, String(v));
  fd.append('file', new Blob([buf]), file);
  const up = await fetch(imp.form.url, { method: 'POST', body: fd });
  if (!up.ok && up.status !== 201 && up.status !== 204) throw new Error(`上传失败 HTTP ${up.status} ${(await up.text()).slice(0, 160)}`);

  let status = 'queued';
  let tasks = [];
  for (let i = 0; i < 60; i++) {
    const j = await ccCall(`/jobs/${id}`);
    status = j.data.status;
    tasks = j.data.tasks;
    if (status === 'finished' || status === 'error') break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (status !== 'finished') {
    const f = tasks.find((t) => t.status === 'error');
    throw new Error(f ? `转换失败：${f.error?.message ?? f.message}` : `超时，状态 ${status}`);
  }
  const exp = tasks.find((t) => t.operation === 'export');
  const url = exp?.url ?? exp?.result?.url;
  if (!url) throw new Error('没有结果地址：' + JSON.stringify(exp).slice(0, 200));
  return { buf: Buffer.from(await (await fetch(url)).arrayBuffer()), dst };
}

async function cvConvert(dir, file) {
  const [src, dst] = dir.split('>');
  const fd = new FormData();
  fd.append('File', fs.readFileSync(path.join('fixtures', file)), file);
  fd.append('StoreFile', 'true');
  const r = await fetch(`${CV}/convert/${src}/to/${dst}`, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: fd });
  const t = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${t.slice(0, 200)}`);
  const j = JSON.parse(t);
  const url = j?.Files?.[0]?.Url;
  if (!url) throw new Error('没有结果地址：' + JSON.stringify(j).slice(0, 200));
  return { buf: Buffer.from(await (await fetch(url)).arrayBuffer()), dst };
}

async function inspect(name, buf) {
  if (name.endsWith('.pdf')) {
    const { PDFDocument } = require('pdf-lib');
    const d = await PDFDocument.load(buf, { ignoreEncryption: true });
    const p = d.getPage(0);
    return { 页数: d.getPageCount(), 首页: `${Math.round(p.getWidth())}×${Math.round(p.getHeight())}` };
  }
  if (name.endsWith('.docx')) {
    const JSZip = require('jszip');
    const z = await JSZip.loadAsync(buf);
    const xml = await z.file('word/document.xml')?.async('string');
    if (!xml) throw new Error('docx 里没有 word/document.xml');
    const text = [...xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]).join('');
    return { 段落: (xml.match(/<w:p [^>]*>|<w:p>/g) ?? []).length, 字数: text.length, 开头: text.slice(0, 40) };
  }
  if (name.endsWith('.xlsx')) {
    const E = require('exceljs');
    const wb = new E.Workbook();
    await wb.xlsx.load(buf);
    return {
      表数: wb.worksheets.length,
      行列: wb.worksheets.map((w) => `${w.rowCount}×${w.columnCount}`).join(','),
      抽样: String(wb.worksheets[0]?.getCell(1, 1).value ?? ''),
    };
  }
  return {};
}

fs.mkdirSync('out/cc', { recursive: true });
let ok = 0;
let bad = 0;
for (const j of JOBS) {
  const t0 = Date.now();
  const [_, dst] = j.dir.split('>');
  const name = `out/cc/${j.file.replace(/\.\w+$/, '')}.${dst}`;
  try {
    const r = PROVIDER === 'convertapi' ? await cvConvert(j.dir, j.file) : await ccConvert(j.dir, j.file);
    if (r.buf.length < 1024) throw new Error('结果过小');
    fs.writeFileSync(name, r.buf);
    const info = await inspect(name, r.buf);
    if (j.want?.pages && !/^\d+$/.test(String(info.页数 ?? ''))) throw new Error('没有页数');
    if (j.want?.text && !j.want.text.test(info.开头 ?? '')) {
      const all = JSON.stringify(info);
      if (!j.want.text.test(all)) throw new Error(`内容没抽到：${all.slice(0, 80)}`);
    }
    ok++;
    console.log(`通过  ${j.dir.padEnd(10)} ${j.file.padEnd(11)} ${((Date.now() - t0) / 1000).toFixed(1)}s  ${(r.buf.length / 1024).toFixed(0)}KB  ${JSON.stringify(info)}`);
  } catch (e) {
    bad++;
    console.log(`失败  ${j.dir.padEnd(10)} ${j.file.padEnd(11)} ${String(e.message).slice(0, 180)}`);
  }
}

try {
  const d =
    PROVIDER === 'convertapi'
      ? await (await fetch(`${CV}/user`, { headers: { Authorization: `Bearer ${key}` } })).json()
      : (await ccCall('/user')).data;
  console.log(`\n账户：${JSON.stringify(d).slice(0, 200)}`);
} catch (e) {
  console.log('读账户信息失败：' + e.message);
}
console.log(`通过 ${ok} / 失败 ${bad}，产物在 out/cc/`);
process.exit(bad ? 1 : 0);

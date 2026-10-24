// 真打自建服务：把 5 个方向各转一次，产物在本地解析内容后断言，并记录耗时（J1900 性能基线）
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { need } from './local.mjs';

const require = createRequire(import.meta.url);
const BASE = process.env.SELF_BASE ?? need('selfTestBase');
const TOKEN = fs.readFileSync('server/.token', 'utf8').trim();
if (!TOKEN) throw new Error('server/.token 是空的');
const OUT = 'out/self';
fs.mkdirSync(OUT, { recursive: true });

const JOBS = [
  { dir: 'docx>pdf', file: 'cn.docx', label: 'Word 转 PDF（真实中文长文）' },
  { dir: 'docx>pdf', file: 't.docx', label: 'Word 转 PDF（含标题与表格）' },
  { dir: 'pptx>pdf', file: 't.pptx', label: 'PPT 转 PDF' },
  { dir: 'xlsx>pdf', file: 't.xlsx', label: 'Excel 转 PDF' },
  // 这两个方向 LibreOffice 本身做不到（Draw 没有导出 Word/Excel 的过滤器），
  // 服务端应当直接拒掉，App 走本机实现
  { dir: 'pdf>docx', file: 'text.pdf', label: 'PDF 转 Word 应被拒', expectReject: true },
  { dir: 'pdf>xlsx', file: 'table.pdf', label: 'PDF 转 Excel 应被拒', expectReject: true },
];

async function put(dir, file) {
  const [from, to] = dir.split('>');
  const buf = fs.readFileSync(path.join('fixtures', file));
  const t0 = Date.now();
  const r = await fetch(`${BASE}/convert?from=${from}&to=${to}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${TOKEN}` },
    body: buf,
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  const out = Buffer.from(await r.arrayBuffer());
  return { out, ms: Date.now() - t0, inSize: buf.length, to };
}

async function inspect(buf, ext, name) {
  if (ext === 'pdf') {
    const { PDFDocument } = require('pdf-lib');
    const d = await PDFDocument.load(buf, { ignoreEncryption: true });
    const p = d.getPage(0);
    return { 页数: d.getPageCount(), 首页pt: `${Math.round(p.getWidth())}×${Math.round(p.getHeight())}` };
  }
  if (ext === 'docx') {
    const JSZip = require('jszip');
    const z = await JSZip.loadAsync(buf);
    const xml = await z.file('word/document.xml')?.async('string');
    if (!xml) throw new Error('docx 缺 document.xml');
    const text = [...xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]).join('');
    return { 段落: (xml.match(/<w:p [^>]*>|<w:p>/g) ?? []).length, 字数: text.length, 开头: text.slice(0, 34) };
  }
  if (ext === 'xlsx') {
    const E = require('exceljs');
    const wb = new E.Workbook();
    await wb.xlsx.load(buf);
    const w0 = wb.worksheets[0];
    return { 表数: wb.worksheets.length, 首页行列: `${w0?.rowCount}×${w0?.columnCount}`, 左上: String(w0?.getCell(1, 1).value ?? '') };
  }
  return {};
}

console.log('目标', BASE);
const h = await fetch(`${BASE}/health`, { headers: { Authorization: `Bearer ${TOKEN}` } });
console.log('健康检查', h.status, JSON.stringify(await h.json()));
console.log('');

let pass = 0;
let fail = 0;
for (const j of JOBS) {
  const [_, to] = j.dir.split('>');
  try {
    const { out, ms, inSize } = await put(j.dir, j.file);
    if (j.expectReject) {
      fail++;
      console.log(`失败  ${j.label.padEnd(26)} 本该被拒却转成功了`);
      continue;
    }
    const info = await inspect(out, to, j.file);
    if (out.length < 800) throw new Error('结果过小 ' + out.length);
    const name = `${OUT}/${j.file.replace(/\.\w+$/, '')}.${to}`;
    fs.writeFileSync(name, out);
    pass++;
    console.log(
      `通过  ${j.label.padEnd(26)} ${(inSize / 1024).toFixed(0)}KB → ${(out.length / 1024).toFixed(0)}KB  ${(ms / 1000).toFixed(1)}s  ${JSON.stringify(info)}`,
    );
  } catch (e) {
    if (j.expectReject && /HTTP 400/.test(String(e.message))) {
      pass++;
      console.log(`通过  ${j.label.padEnd(26)} 已按预期拒绝，App 会走本机实现`);
      continue;
    }
    fail++;
    console.log(`失败  ${j.label.padEnd(26)} ${String(e.message).slice(0, 180)}`);
  }
}

// 鉴权与非法方向也要仍然生效
for (const [name, p, init] of [
  ['不带令牌要 401', '/health', {}],
  ['非法方向要 400', '/convert?from=exe&to=pdf', { method: 'PUT', headers: { Authorization: `Bearer ${TOKEN}` }, body: Buffer.alloc(2048) }],
]) {
  try {
    const r = await fetch(BASE + p, init);
    const want = name.includes('401') ? 401 : 400;
    if (r.status === want) {
      pass++;
      console.log(`通过  ${name.padEnd(26)} ${r.status}`);
    } else {
      fail++;
      console.log(`失败  ${name.padEnd(26)} 期望 ${want} 实际 ${r.status}`);
    }
  } catch (e) {
    fail++;
    console.log(`失败  ${name.padEnd(26)} ${e.message}`);
  }
}

console.log(`\n自建服务真机联调：通过 ${pass} / 失败 ${fail}，产物在 ${OUT}/`);
process.exit(fail ? 1 : 0);

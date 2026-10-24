// 把 wasm/worker/cmap/语言包等"不能被打包器处理"的原始资源拷进 public/
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nm = (p) => path.join(root, 'node_modules', p);
const pub = (p) => path.join(root, 'public', p);

function copy(from, to, label) {
  const s = nm(from);
  if (!fs.existsSync(s)) {
    console.error(`[prebuild] 缺少 ${label ?? from}: ${s}`);
    process.exitCode = 1;
    return false;
  }
  const d = pub(to);
  fs.mkdirSync(path.dirname(d), { recursive: true });
  fs.cpSync(s, d, { recursive: true });
  return true;
}

function copyDir(from, to, filter) {
  const s = nm(from);
  if (!fs.existsSync(s)) {
    console.error(`[prebuild] 缺目录 ${from}`);
    process.exitCode = 1;
    return;
  }
  const d = pub(to);
  fs.mkdirSync(d, { recursive: true });
  for (const f of fs.readdirSync(s)) {
    if (filter && !filter(f)) continue;
    fs.cpSync(path.join(s, f), path.join(d, f));
  }
}

copy('pdfjs-dist/build/pdf.worker.min.mjs', 'pdfjs/pdf.worker.min.mjs');
copyDir('pdfjs-dist/cmaps', 'pdfjs/cmaps', (f) => f.endsWith('.bcmap') || f === 'cmap_info.txt');
copyDir('pdfjs-dist/standard_fonts', 'pdfjs/standard_fonts', (f) => f.endsWith('.pdf'));
copy('tesseract.js/dist/worker.min.js', 'tesseract/worker.min.js');
// 只带 SIMD 版：它是自包含的（wasm 以 base64 内嵌），Android WebView Chrome>=91 必支持
copyDir('tesseract.js-core', 'tesseract/core', (f) => f === 'tesseract-core-simd.wasm.js');

// ---- OCR 语言包：优先本地已有，否则按镜像顺序下载 ----
const TESSDATA = [
  'https://cdn.jsdelivr.net/gh/tesseract-ocr/tessdata_fast@main/',
  'https://github.com/tesseract-ocr/tessdata_fast/raw/main/',
  'https://testingcf.jsdelivr.net/gh/tesseract-ocr/tessdata_fast@main/',
];
const langs = process.argv.slice(2).length ? process.argv.slice(2) : ['eng', 'chi_sim'];

async function fetchWithTimeout(url, ms = 90_000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, { signal: ac.signal, redirect: 'follow' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  } finally {
    clearTimeout(t);
  }
}

for (const lang of langs) {
  const out = pub(`tessdata/${lang}.traineddata`);
  if (fs.existsSync(out) && fs.statSync(out).size > 500_000) {
    console.log(`[prebuild] ${lang} 已存在 ${(fs.statSync(out).size / 1048576).toFixed(1)}MB`);
    continue;
  }
  let done = false;
  for (const base of TESSDATA) {
    try {
      process.stdout.write(`[prebuild] ${lang} <- ${new URL(base).host} ... `);
      const buf = await fetchWithTimeout(base + lang + '.traineddata');
      if (buf.length < 500_000) throw new Error(`体积异常 ${buf.length}B`);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, buf);
      console.log(`OK ${(buf.length / 1048576).toFixed(1)}MB`);
      done = true;
      break;
    } catch (e) {
      console.log(`失败(${e.message})`);
    }
  }
  if (!done) {
    console.error(`[prebuild] 语言包 ${lang} 全部源失败，OCR 功能将不可用`);
    process.exitCode = 1;
  }
}

const total = ['pdfjs', 'tesseract', 'tessdata'].reduce((a, d) => {
  const p = pub(d);
  if (!fs.existsSync(p)) return a;
  const walk = (x) => (fs.statSync(x).isDirectory() ? fs.readdirSync(x).reduce((s, f) => s + walk(path.join(x, f)), 0) : fs.statSync(x).size);
  return a + walk(p);
}, 0);
console.log(`[prebuild] public 静态资源合计 ${(total / 1048576).toFixed(1)}MB`);

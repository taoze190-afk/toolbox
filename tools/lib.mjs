// 验证共享件：夹具生成表达式、产物内容解析器、用例表。verify.mjs 与 device-verify.mjs 共用。
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { opt } from './local.mjs';

const require = createRequire(import.meta.url);
let OUT = 'out';
export function setOutDir(d) { OUT = d; fs.mkdirSync(OUT, { recursive: true }); }
export function outDir() { return OUT; }

export const MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
  pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  mp3: 'audio/mpeg', wav: 'audio/wav',
};

/** 页内现造的夹具：需要中文渲染时只能用浏览器画布，node 侧 librsvg 没中文字体 */
export const GEN = {
  '@textimg': `(async()=>{const c=document.createElement('canvas');c.width=1100;c.height=460;const g=c.getContext('2d');g.fillStyle='#fff';g.fillRect(0,0,1100,460);g.fillStyle='#000';g.textBaseline='top';const L=['表面肌电信号手势识别实验报告','第一章 采集平台的搭建与调试','采样率设置为一千赫兹，工频陷波五十赫兹','受试者十二名，每人完成十一类手势各二十次'];L.forEach((t,i)=>{g.font=(i===0?'bold 46px':'34px')+' system-ui, sans-serif';g.fillText(t,40,40+i*100);});const b=await new Promise(r=>c.toBlob(r,'image/png'));return new File([b],'text-cn.png',{type:'image/png'});})()`,
  '@tableimg': `(async()=>{const cols=['学号','姓名','班级','平时分','期末分'];const rows=[[101,'张三','一班',88,92],[102,'李四','二班',76,81],[103,'王五','三班',95,89],[104,'赵六','一班',67,73]];const cw=[130,130,110,120,120];const rh=52;const W=cw.reduce((a,b)=>a+b,0);const c=document.createElement('canvas');c.width=W+20;c.height=rh*(rows.length+1)+20;const g=c.getContext('2d');g.fillStyle='#fff';g.fillRect(0,0,c.width,c.height);g.strokeStyle='#333';g.lineWidth=2;g.textBaseline='middle';const line=(y)=>{g.beginPath();g.moveTo(10,y);g.lineTo(W+10,y);g.stroke();};let y=10;for(let r=0;r<=rows.length;r++){line(y+r*rh);}let x=10;for(let k=0;k<=cols.length;k++){g.beginPath();g.moveTo(x,10);g.lineTo(x,10+rh*(rows.length+1));g.stroke();x+=cw[k]??0;}const cell=(txt,cx,cy,w,h,bold)=>{g.fillStyle='#000';g.font=(bold?'bold 26px':'24px')+' system-ui, sans-serif';g.fillText(String(txt),cx+14,cy+h/2);};cols.forEach((t,k)=>cell(t,cw.slice(0,k).reduce((a,b)=>a+b,10),10,cw[k],rh,true));rows.forEach((rw,ri)=>rw.forEach((t,k)=>cell(t,cw.slice(0,k).reduce((a,b)=>a+b,10),10+(ri+1)*rh,cw[k],rh,false)));const b=await new Promise(r=>c.toBlob(r,'image/png'));return new File([b],'table-cn.png',{type:'image/png'});})()`,
  '@webp': `(async()=>{const c=document.createElement('canvas');c.width=1600;c.height=1000;const g=c.getContext('2d');g.fillStyle='#345';g.fillRect(0,0,1600,1000);for(let i=0;i<400;i++){g.fillStyle='hsl('+(i*7%360)+',70%,'+(30+i%40)+'%)';g.fillRect((i*97)%1600,(i*53)%1000,60,40);}const b=await new Promise(r=>c.toBlob(r,'image/webp',0.9));return new File([b],'gen.webp',{type:'image/webp'});})()`,
};

/** 扫描件夹具：把中文图塞进 PDF，得到只有图像、没有文字层的件，用来验 A+D 分流 */
const asScannedPdf = (srcExpr) =>
  `(async()=>{const img=await (${srcExpr});const r=await __tk.run('img-to-pdf',[img],{page:'fit',merge:'one',margin:0});const bin=atob(r[0].b64);const u=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)u[i]=bin.charCodeAt(i);return new File([u],'scanned.pdf',{type:'application/pdf'});})()`;

GEN['@scantextpdf'] = asScannedPdf(GEN['@textimg']);
GEN['@scantablepdf'] = asScannedPdf(GEN['@tableimg']);

// ---------------- 产物内容校验 ----------------
export async function inspectImage(b64) {
  const sharp = require('sharp');
  const buf = Buffer.from(b64, 'base64');
  const m = await sharp(buf, { animated: true }).metadata();
  let mean = null;
  let min = null;
  let max = null;
  try {
    const st = await sharp(buf).grayscale().stats();
    const c = st.channels[0];
    mean = Math.round(c.mean);
    min = Math.round(c.min);
    max = Math.round(c.max);
  } catch {
    /* 动图不支持统计，忽略 */
  }
  return { w: m.width, h: m.height, format: m.format, frames: m.pages ?? 1, mean, min, max };
}
export async function inspectPdf(b64) {
  const { PDFDocument } = require('pdf-lib');
  const d = await PDFDocument.load(Buffer.from(b64, 'base64'), { ignoreEncryption: true });
  const p = d.getPage(0);
  return { pages: d.getPageCount(), page0: [Math.round(p.getWidth()), Math.round(p.getHeight())] };
}
export async function inspectDocx(b64) {
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(Buffer.from(b64, 'base64'));
  const xml = await zip.file('word/document.xml')?.async('string');
  if (!xml) throw new Error('缺少 word/document.xml');
  const texts = [...xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]);
  return {
    paras: (xml.match(/<w:p [^>]*>|<w:p>/g) ?? []).length,
    tables: (xml.match(/<w:tbl>/g) ?? []).length,
    images: Object.keys(zip.files).filter((f) => f.startsWith('word/media/')).length,
    text: texts.join('').slice(0, 4000),
  };
}
export async function inspectXlsx(b64) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(b64, 'base64'));
  return {
    sheets: wb.worksheets.map((ws) => {
      const cells = [];
      ws.eachRow((row) => {
        for (const c of row.values.slice(1)) if (c !== undefined && c !== null && c !== '') cells.push(String(c));
      });
      return {
        name: ws.name,
        rows: ws.rowCount,
        cols: ws.columnCount,
        sample: String(ws.getCell(1, 1).value ?? '') + '|' + String(ws.getCell(2, 1).value ?? ''),
        cells,
      };
    }),
  };
}
export async function inspectPptx(b64) {
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(Buffer.from(b64, 'base64'));
  const slides = Object.keys(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f));
  const media = Object.keys(zip.files).filter((f) => f.startsWith('ppt/media/'));
  let text = '';
  for (const s of slides) {
    const xml = await zip.file(s).async('string');
    text += [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]).join(' ');
  }
  return { slides: slides.length, media: media.length, textLen: text.length, sample: text.slice(0, 200) };
}
export function inspectAudio(b64, name) {
  const p = path.join(OUT, '_probe' + path.extname(name));
  fs.writeFileSync(p, Buffer.from(b64, 'base64'));
  const FFMPEG = process.env.FFMPEG ?? opt('ffmpeg') ?? 'ffmpeg';
  const r = spawnSyncText(FFMPEG, ['-hide_banner', '-i', p]);
  const dur = /Duration:\s+(\d+):(\d+):([\d.]+)/.exec(r);
  const br = /Audio:[^\n]*?(\d+)\s*kb\/s/.exec(r);
  const sr = /Audio:[^\n]*?(\d+)\s*Hz/.exec(r);
  return {
    sec: dur ? +dur[1] * 3600 + +dur[2] * 60 + +dur[3] : null,
    kbps: br ? +br[1] : null,
    hz: sr ? +sr[1] : null,
  };
}
function spawnSyncText(cmd, args) {
  const { execFileSync } = require('node:child_process');
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    return String(e.stdout ?? '') + String(e.stderr ?? '');
  }
}
export const INSPECT = {
  image: inspectImage,
  pdf: inspectPdf,
  doc: inspectDocx,
  sheet: inspectXlsx,
  slides: inspectPptx,
  audio: inspectAudio,
};

/** 每条用例：跑工具 -> 校验产物内容 -> 断言 */
export const CASES = [
  {
    id: 'image-compress',
    name: '图片压缩 · 压到 300KB',
    files: ['photo.jpg'],
    opts: { mode: 'size', targetKB: 300, mime: 'image/jpeg' },
    check(outs) {
      must(outs.length === 1, `应出 1 个，实际 ${outs.length}`);
      const o = outs[0];
      must(o.size <= 300 * 1024 * 1.03, `未达目标体积：${(o.size / 1024).toFixed(0)}KB`);
      must(o.size > 200 * 1024, `压得过狠 ${(o.size / 1024).toFixed(0)}KB（二分没收敛到接近目标）`);
      return { 体积KB: Math.round(o.size / 1024), note: o.note };
    },
  },
  {
    id: 'image-compress',
    name: '图片压缩 · 质量档 + 限边',
    files: ['photo.jpg'],
    opts: { mode: 'quality', quality: 60, mime: 'image/jpeg', maxSide: 1200 },
    check(outs) {
      must(outs.length === 1, '应出 1 个');
      return { 体积KB: Math.round(outs[0].size / 1024), note: outs[0].note };
    },
  },
  {
    id: 'image-compress',
    name: '图片压缩 · 多文件重名',
    files: ['photo.jpg', 'id.jpg'],
    opts: { mode: 'quality', quality: 80, mime: 'image/webp' },
    check(outs) {
      must(outs.length === 2, `应出 2 个，实际 ${outs.length}`);
      must(new Set(outs.map((o) => o.name)).size === 2, '输出重名');
      return { 文件: outs.map((o) => `${o.name}(${Math.round(o.size / 1024)}KB)`).join(', ') };
    },
  },
  {
    id: 'pdf-to-pages',
    name: 'PDF 逐页转图 · 4 页',
    files: ['text.pdf'],
    opts: { dpi: 150, mime: 'image/jpeg' },
    check(outs) {
      must(outs.length === 4, `应出 4 页，实际 ${outs.length}`);
      must(/第0*\d+页\.jpg$/.test(outs[0].name), `文件名不像页码：${outs[0].name}`);
      return { 页数: outs.length, 首个: `${outs[0].name} ${outs[0].note}` };
    },
  },
  {
    id: 'img-to-pdf',
    name: '图片转 PDF · 合成一个 A4',
    files: ['photo.jpg', 'id.jpg'],
    opts: { page: 'a4', margin: 18, merge: 'one', quality: 90 },
    check(outs) {
      must(outs.length === 1, '应出 1 个 PDF');
      return { 文件: outs[0].name, note: outs[0].note, 体积KB: Math.round(outs[0].size / 1024) };
    },
  },
  {
    id: 'img-to-pdf',
    name: '图片转 PDF · 与原图同尺寸',
    files: ['id.jpg'],
    opts: { page: 'fit', margin: 0, merge: 'one' },
    check(outs) {
      must(outs.length === 1, '应出 1 个 PDF');
      return { note: outs[0].note };
    },
  },
  {
    id: 'img-to-pdf',
    name: '图片转 PDF · 横向 A4',
    files: ['photo.jpg'],
    opts: { page: 'a4', orient: 'l', margin: 0, merge: 'one' },
    check(outs, insp) {
      const [w, h] = insp[0].page0;
      must(w > h, `横向未生效：${w}×${h}`);
      return { 首页pt: `${w}×${h}` };
    },
  },
  {
    id: 'img-to-pdf',
    name: '图片转 PDF · WebP 转码嵌入',
    files: ['@webp'],
    opts: { page: 'fit', merge: 'one' },
    check(outs) {
      must(outs.length === 1, '应出 1 个 PDF');
      return { note: outs[0].note };
    },
  },

  // ---- pdf-tools 批次 ----
  {
    id: 'pdf-compress',
    name: 'PDF 压缩 · 扫描版极限档',
    files: ['scan.pdf'],
    opts: { level: 'tiny', maxSide: 1600 },
    check(outs, insp) {
      must(outs.length === 1, '应出 1 个 PDF');
      must(insp[0].pages === 3, `页数变了：${insp[0].pages}`);
      const [w, h] = insp[0].page0;
      must(w === 595 && h === 842, `页面尺寸没保持：${w}×${h}`);
      must(outs[0].size < 6735 * 1024 * 0.5, `压缩没效果：${(outs[0].size / 1024).toFixed(0)}KB`);
      return { 体积KB: Math.round(outs[0].size / 1024), note: outs[0].note };
    },
  },
  {
    id: 'pdf-compress',
    name: 'PDF 压缩 · 文字版（应提示丢文字层）',
    files: ['text.pdf'],
    opts: { level: 'balanced', maxSide: 2048 },
    check(outs, insp) {
      must(insp[0].pages === 4, `页数变了：${insp[0].pages}`);
      must(/文字层/.test(outs[0].note), `note 没提示丢文字层：${outs[0].note}`);
      return { 体积KB: Math.round(outs[0].size / 1024), note: outs[0].note };
    },
  },
  {
    id: 'pdf-to-longimg',
    name: 'PDF 转长图 · 4 页竖拼',
    files: ['text.pdf'],
    opts: { dpi: 100, mime: 'image/jpeg' },
    check(outs, insp) {
      must(outs.length === 1, '应出 1 张图');
      const m = insp[0];
      must(m.h > m.w * 2.5, `不像长图：${m.w}×${m.h}`);
      return { 尺寸: `${m.w}×${m.h}`, 体积KB: Math.round(outs[0].size / 1024), note: outs[0].note };
    },
  },
  {
    id: 'pdf-to-longimg',
    name: 'PDF 转长图 · 高 dpi 触发放宽降级',
    files: ['scan.pdf'],
    opts: { dpi: 250, mime: 'image/jpeg' },
    check(outs, insp) {
      const m = insp[0];
      must(m.h <= 16384, `超出画布上限没拦住：${m.h}`);
      return { 尺寸: `${m.w}×${m.h}`, note: outs[0].note };
    },
  },
  {
    id: 'pdf-to-ppt',
    name: 'PDF 转 PPT · 每页一张幻灯片',
    files: ['text.pdf'],
    opts: { dpi: 120, ratio: 'first' },
    check(outs, insp) {
      must(outs.length === 1, '应出 1 个 pptx');
      must(insp[0].slides === 4, `幻灯片数 ${insp[0].slides}，应为 4`);
      must(insp[0].media >= 4, `内嵌图片只有 ${insp[0].media} 张`);
      return { 幻灯片: insp[0].slides, 配图: insp[0].media, note: outs[0].note };
    },
  },

  // ---- compress-tools 批次 ----
  {
    id: 'idphoto-size',
    name: '证件尺寸修改 · 一寸裁切白底',
    files: ['id.jpg'],
    opts: { size: 'one', bg: 'white', mode: 'crop', mime: 'jpg', sheet: '' },
    check(outs, insp) {
      must(outs.length === 1, '应出 1 张');
      const m = insp[0];
      must(m.w === 295 && m.h === 413, `不是一寸 295×413，实际 ${m.w}×${m.h}`);
      return { 尺寸: `${m.w}×${m.h}`, 体积KB: Math.round(outs[0].size / 1024), note: outs[0].note };
    },
  },
  {
    id: 'idphoto-size',
    name: '证件尺寸修改 · 二寸留白蓝底 + 6寸排版',
    files: ['photo.jpg'],
    opts: { size: 'two', bg: 'blue', mode: 'pad', mime: 'jpg', sheet: '6in' },
    check(outs, insp) {
      must(outs.length >= 2, `应出照片 + 排版页，实际 ${outs.length}`);
      const sheet = insp[insp.length - 1];
      must(sheet.w >= 1700 && sheet.w <= 1850, `6寸相纸宽度不对：${sheet.w}`);
      return { 输出: outs.map((o) => o.name).join(', '), 排版页: `${sheet.w}×${sheet.h}` };
    },
  },
  {
    id: 'idphoto-compress',
    name: '证件照片压缩 · 一寸压到 60KB',
    files: ['photo.jpg'],
    opts: { size: 'one', targetKB: 60, bg: 'white', mime: 'jpg' },
    check(outs, insp) {
      must(outs.length === 1, '应出 1 张');
      must(insp[0].w === 295 && insp[0].h === 413, `尺寸不对：${insp[0].w}×${insp[0].h}`);
      must(outs[0].size <= 60 * 1024 * 1.03, `没压到 60KB：${(outs[0].size / 1024).toFixed(1)}KB`);
      return { 尺寸: `${insp[0].w}×${insp[0].h}`, 体积KB: (outs[0].size / 1024).toFixed(1), note: outs[0].note };
    },
  },
  {
    id: 'idphoto-compress',
    name: '证件照片压缩 · 目标过小应明确报错',
    files: ['photo.jpg'],
    opts: { size: 'two', targetKB: 2, bg: 'white', mime: 'jpg' },
    expectError: /压不到|无法|放宽/,
    check() {
      return {};
    },
  },
  {
    id: 'gif-compress',
    name: 'GIF 压缩 · 均衡档',
    files: ['anim.gif'],
    opts: { level: 'balance', scale: 'none', skip: 'off' },
    check(outs, insp) {
      must(outs.length === 1, '应出 1 个 gif');
      must(insp[0].frames === 24, `帧数变了：${insp[0].frames}，均衡档不该抽帧`);
      must(outs[0].size < 1255469 * 0.8, `没压下来：${(outs[0].size / 1024).toFixed(0)}KB / 原 1226KB`);
      return { 尺寸: `${insp[0].w}×${insp[0].h}`, 帧数: insp[0].frames, 体积KB: Math.round(outs[0].size / 1024), note: outs[0].note };
    },
  },
  {
    id: 'gif-compress',
    name: 'GIF 压缩 · 缩放 + 抽帧',
    files: ['anim.gif'],
    opts: { level: 'tiny', scale: 's60', skip: 'half' },
    check(outs, insp) {
      const m = insp[0];
      must(m.w < 320, `没缩放：${m.w}`);
      must(m.frames < 24, `没抽帧：还是 ${m.frames} 帧`);
      must(!/未抽帧/.test(outs[0].note), `note 自报未抽帧：${outs[0].note}`);
      return { 尺寸: `${m.w}×${m.w}`, 帧数: m.frames, 体积KB: Math.round(outs[0].size / 1024), note: outs[0].note };
    },
  },
  {
    id: 'audio-compress',
    name: '音频压缩 · 192k 立体声转 64k 单声道',
    files: ['tone.mp3'],
    opts: { kbps: 64, rate: 0, mono: true },
    check(outs, insp) {
      must(outs.length === 1, '应出 1 个音频');
      must(/\.mp3$/i.test(outs[0].name), `后缀不对：${outs[0].name}`);
      const a = insp[0];
      must(a.sec && Math.abs(a.sec - 12) < 0.6, `时长不对：${a.sec}s（应约 12s）`);
      must(a.kbps && Math.abs(a.kbps - 64) <= 4, `码率不对：${a.kbps}kbps`);
      must(outs[0].size < 283 * 1024 * 0.6, `体积没降：${(outs[0].size / 1024).toFixed(0)}KB`);
      return { 时长: `${a.sec.toFixed(1)}s`, 码率: `${a.kbps}kbps`, 采样率: `${a.hz}Hz`, 体积KB: Math.round(outs[0].size / 1024) };
    },
  },
  {
    id: 'audio-compress',
    name: '音频压缩 · 降采样到 16k',
    files: ['tone.mp3'],
    opts: { kbps: 32, rate: 16000, mono: true },
    check(outs, insp) {
      const a = insp[0];
      must(a.hz === 16000, `采样率没生效：${a.hz}`);
      return { 采样率: `${a.hz}Hz`, 体积KB: Math.round(outs[0].size / 1024), note: outs[0].note };
    },
  },

  // ---- text-extract-tools 批次 ----
  {
    id: 'pdf-to-word',
    name: 'PDF 转 Word · 文字与标题抽取',
    files: ['text.pdf'],
    opts: { mergeWrap: true, detectHeading: true, splitEvery: 0 },
    check(outs, insp) {
      must(outs.length === 1 && /\.docx$/i.test(outs[0].name), '应出 1 个 docx');
      const d = insp[0];
      must(/Electromyography/.test(d.text), `正文没抽到：${d.text.slice(0, 80)}`);
      must(/SVM 87\.4/.test(d.text.replace(/\s+/g, ' ')), '表格行文字缺失');
      must(d.paras > 10, `段落太少：${d.paras}`);
      must(!/识别/.test(outs[0].note), `有文字层却触发了识别：${outs[0].note}`);
      return { 段落: d.paras, 字数: d.text.length, 开头: d.text.slice(0, 60) };
    },
  },
  {
    id: 'pdf-to-excel',
    name: 'PDF 转 Excel · 按坐标还原行列',
    files: ['table.pdf'],
    opts: { colTol: 'mid', layout: 'page', dedupHead: true, numeric: true },
    check(outs, insp) {
      must(outs.length === 1 && /\.xlsx$/i.test(outs[0].name), '应出 1 个 xlsx');
      const sheets = insp[0].sheets;
      must(sheets.length >= 2, `两页应出 2 张表，实际 ${sheets.length}`);
      const s = sheets[0];
      must(s.cols === 8, `列数应为 8，实际 ${s.cols}`);
      must(s.rows >= 15, `行数太少：${s.rows}`);
      const total = sheets.reduce((a, x) => a + x.rows, 0);
      return { 表数: sheets.length, 首页: `${s.rows}行×${s.cols}列`, 总行数: total };
    },
  },
  {
    id: 'img-to-word',
    name: '图片转 Word · 中文离线 OCR',
    files: ['@textimg'],
    opts: { langs: 'chi_sim+eng', scale: 2, mergeWrap: true, output: 'one' },
    timeoutMs: 420_000,
    check(outs, insp) {
      must(outs.length === 1 && /\.docx$/i.test(outs[0].name), '应出 1 个 docx');
      const t = insp[0].text;
      must(t.length >= 15, `识别文字过少：${t.length} 字`);
      const hits = ['肌电', '手势', '采集平台', '采样率', '受试者'].filter((k) => t.includes(k));
      must(hits.length >= 2, `关键词命中不足：[${hits}] 实际「${t.slice(0, 120)}」`);
      return { 命中: hits.join('/'), 字数: t.length, 识别: t.slice(0, 70) };
    },
  },
  {
    id: 'img-to-excel',
    name: '图片转 Excel · 表格线内文字重建',
    files: ['@tableimg'],
    opts: { langs: 'chi_sim+eng', psm: 'block', gap: 'std', scale: 2, stripGrid: true, numeric: true, rawSheet: true },
    timeoutMs: 420_000,
    check(outs, insp) {
      must(outs.length === 1 && /\.xlsx$/i.test(outs[0].name), '应出 1 个 xlsx');
      const main = insp[0].sheets[0];
      must(main.cols >= 3, `列数偏少：${main.cols}`);
      must(main.rows >= 4, `行数偏少：${main.rows}`);
      return { 表数: insp[0].sheets.length, 行列: `${main.rows}×${main.cols}`, 抽样: insp[0].sheets.map((s) => s.name).join(',') };
    },
  },

  // ---- office-to-pdf 批次 ----
  {
    id: 'word-to-pdf',
    name: 'Word 转 PDF · 真实中文文档',
    files: ['cn.docx'],
    opts: { paper: 'a4', margin: 'normal', fontSize: 10.5, skipImage: false },
    check(outs, insp) {
      must(outs.length === 1 && /\.pdf$/i.test(outs[0].name), '应出 1 个 pdf');
      const [w, h] = insp[0].page0;
      must(Math.abs(w - 595) <= 2 && Math.abs(h - 842) <= 2, `不是 A4：${w}×${h}`);
      must(insp[0].pages >= 1, `页数偏少：${insp[0].pages}`);
      must(outs[0].size > 30 * 1024, `疑似空白：只有 ${(outs[0].size / 1024).toFixed(0)}KB`);
      return { 页数: insp[0].pages, 页面: `${w}×${h}`, 体积KB: Math.round(outs[0].size / 1024), note: outs[0].note };
    },
  },
  {
    id: 'word-to-pdf',
    name: 'Word 转 PDF · 含标题与表格',
    files: ['t.docx'],
    opts: { paper: 'a4', margin: 'narrow', fontSize: 12, skipImage: false },
    check(outs, insp) {
      must(insp[0].pages >= 1, '没有页');
      return { 页数: insp[0].pages, 体积KB: Math.round(outs[0].size / 1024) };
    },
  },
  {
    id: 'excel-to-pdf',
    name: 'Excel 转 PDF · 两个 sheet 含超宽表',
    files: ['t.xlsx'],
    opts: { paper: 'a4', orient: 'auto', overflow: 'shrink', sheets: 'all', header: true, blank: false, newPage: true },
    check(outs, insp) {
      must(outs.length === 1 && /\.pdf$/i.test(outs[0].name), '应出 1 个 pdf');
      must(insp[0].pages >= 2, `两个 sheet 至少两页，实际 ${insp[0].pages}`);
      return { 页数: insp[0].pages, 首页: insp[0].page0.join('×'), 体积KB: Math.round(outs[0].size / 1024), note: outs[0].note };
    },
  },
  {
    id: 'excel-to-pdf',
    name: 'Excel 转 PDF · 超宽时横向分页',
    files: ['t.xlsx'],
    opts: { paper: 'a4', orient: 'p', overflow: 'split', sheets: 'all', header: true, blank: false, newPage: true },
    check(outs, insp) {
      must(insp[0].pages >= 3, `横向分页没生效，只有 ${insp[0].pages} 页`);
      return { 页数: insp[0].pages };
    },
  },
  {
    id: 'ppt-to-pdf',
    name: 'PPT 转 PDF · 三页含表格',
    files: ['t.pptx'],
    opts: { width: 1600, image: true, pageNo: true },
    check(outs, insp) {
      must(outs.length === 1 && /\.pdf$/i.test(outs[0].name), '应出 1 个 pdf');
      must(insp[0].pages === 3, `页数 ${insp[0].pages}，应为 3`);
      const [w, h] = insp[0].page0;
      must(w / h > 1.4 && w / h < 1.9, `16:9 比例不对：${w}×${h}`);
      return { 页数: insp[0].pages, 页面: `${w}×${h}`, note: outs[0].note };
    },
  },

  // ---- 回环：把降级渲染出来的 PDF 再渲染成图，确认不是白纸也不是黑块 ----
  {
    id: 'pdf-to-pages',
    name: '回环 · Word 转出的 PDF 首页有墨',
    files: ['chk-cn.pdf'],
    opts: { dpi: 110, mime: 'image/jpeg' },
    check(outs, insp) {
      must(outs.length >= 1, '没有页');
      const { min, max, mean, w, h } = insp[0];
      must(min < 128, `首页没有深色像素（最暗 ${min}），是白纸`);
      must(max > 200, `首页没有白底（最亮 ${max}），整页发黑`);
      return { 明暗: `${min}-${max}`, 均色: mean, 尺寸: `${w}×${h}` };
    },
  },
  {
    id: 'pdf-to-pages',
    name: '回环 · 含标题表格的 docx 转出的 PDF 有结构',
    files: ['chk-t.pdf'],
    opts: { dpi: 110, mime: 'image/jpeg' },
    check(outs, insp) {
      const { min, max, mean, w, h } = insp[0];
      must(min < 128, `首页是白纸（最暗 ${min}）`);
      must(max > 200, `整页发黑（最亮 ${max}）`);
      must(w < h, `A4 应竖向：${w}×${h}`);
      return { 明暗: `${min}-${max}`, 均色: mean, 尺寸: `${w}×${h}` };
    },
  },
  {
    id: 'pdf-to-pages',
    name: '回环 · Excel 转出的 PDF 每页都有表格',
    files: ['chk-x.pdf'],
    opts: { dpi: 110, mime: 'image/jpeg' },
    check(outs, insp) {
      must(outs.length >= 2, `超宽表应分多页，实际 ${outs.length}`);
      const bad = insp.map((i, n) => (i.min < 128 && i.max > 200 ? null : n + 1)).filter(Boolean);
      must(!bad.length, `这些页像空白：${bad.join(',')}`);
      return { 页数: outs.length, 首页: `${insp[0].w}×${insp[0].h}`, 明暗: insp.map((i) => i.min).join('/') };
    },
  },
  {
    id: 'pdf-to-pages',
    name: '回环 · PPT 转出的 PDF 三页都有内容',
    files: ['chk-p.pdf'],
    opts: { dpi: 110, mime: 'image/jpeg' },
    check(outs, insp) {
      must(outs.length === 3, `应 3 页，实际 ${outs.length}`);
      const bad = insp.map((i, n) => (i.min < 128 ? null : n + 1)).filter(Boolean);
      must(!bad.length, `这些页没有文字墨迹：${bad.join(',')}`);
      return { 页数: 3, 明暗: insp.map((i) => `${i.min}-${i.max}`).join(' / '), 尺寸: `${insp[0].w}×${insp[0].h}` };
    },
  },

  // ---- A+D 分流：无文字层的页自动渲染后离线识别 ----
  {
    id: 'pdf-to-word',
    name: '扫描件转 Word · 无文字层自动走识别',
    files: ['@scantextpdf'],
    opts: { mergeWrap: true, detectHeading: true, splitEvery: 0, ocr: true, langs: 'chi_sim+eng', ocrDpi: 200 },
    timeoutMs: 420_000,
    check(outs, insp) {
      must(outs.length === 1 && /\.docx$/i.test(outs[0].name), '应出 1 个 docx');
      const t = insp[0].text;
      const hits = ['肌电', '手势', '采集平台', '采样率', '受试者'].filter((k) => t.includes(k));
      must(hits.length >= 2, `识别内容命中不足：[${hits}] 实际「${t.slice(0, 120)}」`);
      must(/页走识别/.test(outs[0].note), `note 没说明走过识别：${outs[0].note}`);
      return { 命中: hits.join('/'), 字数: t.length, note: outs[0].note };
    },
  },
  {
    id: 'pdf-to-excel',
    name: '扫描表格转 Excel · 无文字层自动走识别',
    files: ['@scantablepdf'],
    opts: { colTol: 'mid', layout: 'page', dedupHead: true, numeric: true, ocr: true, langs: 'chi_sim+eng', ocrDpi: 200 },
    timeoutMs: 420_000,
    check(outs, insp) {
      const s = insp[0].sheets[0];
      const cells = s.cells ?? [];
      const joined = cells.join(' ');
      must(s.cols >= 3, `列数偏少：${s.cols}`);
      must(/页走识别/.test(outs[0].note), `note 没说明走过识别：${outs[0].note}`);
      must(s.rows >= 5, `表头加四行数据应≥5 行，实际 ${s.rows}`);
      // 只数行列是不够的：格线被认成 "[" "|" 时行列数照样凑得上，内容却是废的
      const names = ['张三', '李四', '王五', '赵六'].filter((k) => joined.includes(k));
      must(names.length >= 2, `识别内容命中不足：[${names}] 实际「${joined.slice(0, 120)}」`);
      must(/10[1-4]/.test(joined), `学号列没认出来：「${joined.slice(0, 120)}」`);
      must(!/^\s*[|[\]]+\s*$/.test(joined), `格线被当成文字：「${joined.slice(0, 80)}」`);
      return { 行列: `${s.rows}×${s.cols}`, 命中: names.join('/'), 抽样: joined.slice(0, 60), note: outs[0].note };
    },
  },
  {
    id: 'pdf-to-word',
    name: '扫描件关掉识别要明确报错',
    files: ['@scantextpdf'],
    opts: { ocr: false },
    expectError: /没有文字层/,
    check() {
      return {};
    },
  },
];

export function must(cond, msg) {
  if (!cond) throw new Error(msg);
}

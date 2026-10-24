// 生成验证用的夹具文件到 fixtures/。幂等：已存在且体积正常的跳过。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import ExcelJS from 'exceljs';
import PptxGenJSMod from 'pptxgenjs';
const PptxGenJS = PptxGenJSMod.default ?? PptxGenJSMod;
import { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType } from 'docx';
import { need, opt } from './local.mjs';

const FFMPEG = process.env.FFMPEG ?? need('ffmpeg');
const dir = 'fixtures';
fs.mkdirSync(dir, { recursive: true });

const has = (p, min = 1000) => fs.existsSync(path.join(dir, p)) && fs.statSync(path.join(dir, p)).size >= min;
const log = (m) => console.log('[fixtures] ' + m);

/** 造一张有细节的"类照片"：多频正弦叠加 + 噪声 + 渐变，JPEG 压得动也有内容 */
function photo(w, h, seed) {
  const buf = Buffer.alloc(w * h * 3);
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      const a = Math.sin(x / 17 + y / 41) * 0.5 + 0.5;
      const b = Math.sin((x + y) / 7) * 0.5 + 0.5;
      const c = Math.sin(x / 3) * Math.cos(y / 5) * 0.5 + 0.5;
      buf[i] = Math.max(0, Math.min(255, a * 200 + b * 55 + rnd() * 26));
      buf[i + 1] = Math.max(0, Math.min(255, (1 - a) * 150 + c * 90 + rnd() * 26 + y / h * 30));
      buf[i + 2] = Math.max(0, Math.min(255, b * 120 + c * 120 + rnd() * 26 + x / w * 20));
    }
  }
  return sharp(buf, { raw: { width: w, height: h, channels: 3 } });
}

if (!has('photo.jpg', 200_000)) {
  await photo(2200, 1500, 7).jpeg({ quality: 96, chromaSubsampling: '4:4:4' }).toFile(`${dir}/photo.jpg`);
  log(`photo.jpg ${(fs.statSync(`${dir}/photo.jpg`).size / 1024).toFixed(0)}KB`);
}

if (!has('id.jpg', 50_000)) {
  // 类人像：肤色椭圆 + 深色头发 + 纯色背景，证件照工具的合法输入
  const w = 700;
  const h = 930;
  const buf = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      const bg = [228, 232, 238];
      let c = bg;
      const fx = (x - w / 2) / 190;
      const fy = (y - h * 0.42) / 240;
      const face = fx * fx + fy * fy;
      const shx = (x - w / 2) / 300;
      const shy = (y - h * 0.95) / 190;
      if (shx * shx + shy * shy < 1) c = [58, 62, 96];
      if (face < 1) {
        c = [226, 186, 158];
        const ex = Math.abs(Math.abs(fx) - 0.42) / 0.12 + Math.abs(fy + 0.12) / 0.06;
        if (ex < 1) c = [40, 34, 30];
        const mx = Math.abs(fx) / 0.1 + Math.abs(fy - 0.42) / 0.05;
        if (mx < 1) c = [176, 108, 104];
      }
      if (fy < -0.75 && face < 1.9) c = [46, 38, 32];
      buf[i] = c[0];
      buf[i + 1] = c[1];
      buf[i + 2] = c[2];
    }
  await sharp(buf, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 94 }).toFile(`${dir}/id.jpg`);
  log('id.jpg ok');
}

if (!has('anim.gif', 40_000)) {
  const { GIFEncoder, quantize, applyPalette } = await import('node:module').then(({ createRequire }) =>
    createRequire(import.meta.url)('gifenc'),
  );
  const w = 320;
  const h = 320;
  const gif = GIFEncoder();
  for (let f = 0; f < 24; f++) {
    const rgba = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const dx = x - w / 2;
        const dy = y - h / 2;
        const r = Math.hypot(dx, dy);
        const ang = Math.atan2(dy, dx) + (f / 24) * Math.PI * 2;
        const v = Math.sin(r / 14 - f * 0.6) * 0.5 + 0.5;
        rgba[i] = Math.round(v * 255);
        rgba[i + 1] = Math.round((Math.sin(ang * 3) * 0.5 + 0.5) * 200 + 40);
        rgba[i + 2] = Math.round((1 - v) * 220);
        rgba[i + 3] = 255;
      }
    const palette = quantize(rgba, 256);
    const index = applyPalette(rgba, palette);
    gif.writeFrame(index, w, h, { palette, delay: 60 });
  }
  gif.finish();
  fs.writeFileSync(`${dir}/anim.gif`, Buffer.from(gif.bytes()));
  log(`anim.gif ${(fs.statSync(`${dir}/anim.gif`).size / 1024).toFixed(0)}KB 24帧`);
}

// ---- PDF：文字版 + 扫描版（大图拼的） ----
if (!has('text.pdf', 3000)) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const lines = [
    'Surface Electromyography Gesture Recognition',
    '',
    'This sample document is used to verify text extraction fidelity.',
    'Chapter 1 introduces the acquisition platform and the sensor front end.',
    'Chapter 2 describes time domain features such as RMS and waveform length.',
    '',
    'Summary of accuracy by model:',
    'SVM 87.4 percent, Random Forest 89.1 percent, CNN 93.6 percent.',
  ];
  for (let p = 0; p < 4; p++) {
    const page = doc.addPage([595.28, 841.89]);
    let y = 780;
    page.drawText(`Page ${p + 1}`, { x: 60, y, size: 18, font, color: rgb(0, 0, 0) });
    y -= 34;
    for (const t of lines) {
      page.drawText(t, { x: 60, y, size: 11, font });
      y -= 17;
    }
    page.drawText(`Row A | 12.5 | 33.0 | 41.2 | total 86.7 | note alpha${p}`, { x: 60, y: 120, size: 11, font });
    page.drawText(`Row B | 18.0 | 21.5 | 60.0 | total 99.5 | note beta${p}`, { x: 60, y: 100, size: 11, font });
    page.drawText(`Row C | 22.0 | 19.5 | 30.0 | total 71.5 | note gamma${p}`, { x: 60, y: 80, size: 11, font });
  }
  fs.writeFileSync(`${dir}/text.pdf`, Buffer.from(await doc.save()));
  log('text.pdf ok');
}

if (!has('scan.pdf', 200_000)) {
  const doc = await PDFDocument.create();
  for (let p = 0; p < 3; p++) {
    const jpg = await photo(1800, 2400, 100 + p).jpeg({ quality: 95 }).toBuffer();
    const img = await doc.embedJpg(jpg);
    const page = doc.addPage([595.28, 841.89]);
    page.drawImage(img, { x: 0, y: 0, width: 595.28, height: 841.89 });
  }
  fs.writeFileSync(`${dir}/scan.pdf`, Buffer.from(await doc.save()));
  log(`scan.pdf ${(fs.statSync(`${dir}/scan.pdf`).size / 1024).toFixed(0)}KB`);
}

// ---- xlsx ----
if (!has('t.xlsx', 4000)) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('成绩表');
  ws.columns = [
    { header: '学号', key: 'id', width: 12 },
    { header: '姓名', key: 'name', width: 14 },
    { header: '班级', key: 'cls', width: 10 },
    { header: '平时分', key: 'a', width: 10 },
    { header: '实验分', key: 'b', width: 10 },
    { header: '期末分', key: 'c', width: 10 },
    { header: '总评', key: 'd', width: 10 },
    { header: '备注说明列比较长的表头', key: 'e', width: 26 },
  ];
  ws.getRow(1).font = { bold: true };
  for (let i = 0; i < 42; i++) {
    ws.addRow({
      id: `2024${String(i).padStart(3, '0')}`,
      name: `考生${i}`,
      cls: `${(i % 4) + 1}班`,
      a: 70 + (i % 30),
      b: 65 + ((i * 7) % 35),
      c: 60 + ((i * 13) % 40),
      d: 66 + ((i * 3) % 30),
      e: i % 5 === 0 ? '需补交实验报告，截止下周五' : '',
    });
  }
  const ws2 = wb.addWorksheet('超宽表');
  for (let r = 1; r <= 12; r++) {
    const row = [];
    for (let c = 1; c <= 26; c++) row.push(r === 1 ? `列${c}` : r * c);
    ws2.addRow(row);
  }
  fs.writeFileSync(`${dir}/t.xlsx`, Buffer.from(await wb.xlsx.writeBuffer()));
  log('t.xlsx ok');
}

// ---- docx（自己造一份带表格和标题的；再拷一份真实中文文档） ----
if (!has('t.docx', 3000)) {
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({ text: '表面肌电信号手势识别实验方案', heading: HeadingLevel.HEADING_1 }),
          new Paragraph({ children: [new TextRun('一、采集平台')] , heading: HeadingLevel.HEADING_2 }),
          new Paragraph({ children: [new TextRun('使用 8 通道干电极传感器与 24 位 ADC 前端，采样率 1000Hz，工频陷波 50Hz。')] }),
          new Paragraph({ children: [new TextRun('受试者 12 名，每人完成 11 类手势各 20 次，组间休息 30 秒以抑制疲劳伪迹。')] }),
          new Paragraph({ children: [new TextRun('二、特征与模型')], heading: HeadingLevel.HEADING_2 }),
          new Paragraph({ children: [new TextRun('MA、RMS、WL、ZC 四个时域特征拼接后送入 1D-CNN，与 SVM 和随机森林对照。')] }),
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: [
              new TableRow({ children: ['模型', '准确率', '延迟'].map((t) => new TableCell({ children: [new Paragraph(t)] })) }),
              new TableRow({ children: ['SVM', '87.4%', '12ms'].map((t) => new TableCell({ children: [new Paragraph(t)] })) }),
              new TableRow({ children: ['1D-CNN', '93.6%', '31ms'].map((t) => new TableCell({ children: [new Paragraph(t)] })) }),
            ],
          }),
          new Paragraph({ children: [new TextRun('三、结论')], heading: HeadingLevel.HEADING_2 }),
          new Paragraph({ children: [new TextRun('端侧部署时把卷积通道数从 64 降到 32，准确率损失 1.2 个百分点，体积减少到 41%。')] }),
        ],
      },
    ],
  });
  fs.writeFileSync(`${dir}/t.docx`, Buffer.from(await (await Packer.toBlob(doc)).arrayBuffer()));
  log('t.docx ok');
}

// ---- 真表格 PDF：每个单元格独立 drawText，列才有 x 起点可聚 ----
if (!has('table.pdf', 2000)) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const heads = ['ID', 'Name', 'Class', 'Daily', 'Lab', 'Final', 'Total', 'Note'];
  const xs = [60, 130, 220, 290, 360, 430, 500, 570];
  for (let pg = 0; pg < 2; pg++) {
    const page = doc.addPage([700, 520]);
    heads.forEach((h, i) => page.drawText(h, { x: xs[i], y: 480, size: 11, font: bold }));
    for (let r = 0; r < 14; r++) {
      const y = 458 - r * 22;
      const n = pg * 14 + r;
      const cells = [
        `S${1000 + n}`,
        `Student${n}`,
        `${(n % 4) + 1}A`,
        String(70 + (n % 25)),
        String(65 + ((n * 3) % 30)),
        String(60 + ((n * 7) % 35)),
        String(66 + ((n * 5) % 30)),
        n % 5 === 0 ? 'pending' : 'ok',
      ];
      cells.forEach((c, i) => page.drawText(c, { x: xs[i], y, size: 10, font }));
    }
  }
  fs.writeFileSync(`${dir}/table.pdf`, Buffer.from(await doc.save()));
  log('table.pdf ok');
}

const realDoc = opt('realDoc');
if (!has('cn.docx', 3000)) {
  if (realDoc && fs.existsSync(realDoc)) {
    fs.copyFileSync(realDoc, `${dir}/cn.docx`);
    log('cn.docx <- 本机真实中文文档');
  } else {
    // 没配真实文档时合成一份够长的：跨页排版只有件够长才验得出来
    const children = [];
    for (const t of ['采样率与工频陷波', '电极放置与皮肤预处理', '时域特征提取', '窗口长度与步长', '分类器对照', '端侧推理延迟', '疲劳伪迹抑制', '受试者与知情同意']) {
      children.push(new Paragraph({ text: t, heading: HeadingLevel.HEADING_2 }));
      for (let i = 0; i < 6; i++) {
        children.push(new Paragraph({ children: [new TextRun(`${t}第 ${i + 1} 段：本段用来验证中文字体嵌入、行距换算与分页位置，正文需要长到足以跨页。`.repeat(4))] }));
      }
    }
    fs.writeFileSync(`${dir}/cn.docx`, await Packer.toBuffer(new Document({ sections: [{ children }] })));
    log(`cn.docx 合成 ${(fs.statSync(`${dir}/cn.docx`).size / 1024).toFixed(0)}KB`);
  }
}

// ---- pptx ----
if (!has('t.pptx', 3000)) {
  const p = new PptxGenJS();
  p.defineLayout({ name: 'W', width: 13.33, height: 7.5 });
  p.layout = 'W';
  const s1 = p.addSlide();
  s1.addText('基于表面肌电信号的手势识别', { x: 0.8, y: 2.6, w: 11.7, h: 1.2, fontSize: 36, bold: true });
  s1.addText('中期汇报 · 2026-09', { x: 0.8, y: 4.0, w: 11.7, h: 0.6, fontSize: 20 });
  const s2 = p.addSlide();
  s2.addText('研究内容', { x: 0.6, y: 0.4, w: 12, h: 0.9, fontSize: 30, bold: true });
  s2.addText(
    [
      { text: '搭建 8 通道肌电采集平台', options: { bullet: true } },
      { text: '时域与频域特征工程', options: { bullet: true } },
      { text: '对比 SVM / 随机森林 / 1D-CNN / LSTM', options: { bullet: true } },
      { text: '端侧轻量化部署与实时演示', options: { bullet: true } },
    ],
    { x: 0.8, y: 1.5, w: 11.5, h: 4.5, fontSize: 22 },
  );
  const s3 = p.addSlide();
  s3.addText('实验结果', { x: 0.6, y: 0.4, w: 12, h: 0.9, fontSize: 30, bold: true });
  s3.addTable(
    [
      [
        { text: '模型', options: { bold: true } },
        { text: '准确率', options: { bold: true } },
        { text: '延迟', options: { bold: true } },
      ],
      ['SVM', '87.4%', '12ms'],
      ['随机森林', '89.1%', '15ms'],
      ['1D-CNN', '93.6%', '31ms'],
    ],
    { x: 1, y: 1.6, w: 11, colW: [4, 4, 3], fontSize: 20 },
  );
  const out = await p.write({ outputType: 'nodebuffer' });
  fs.writeFileSync(`${dir}/t.pptx`, out);
  log('t.pptx ok');
}

// ---- mp3 ----
if (!has('tone.mp3', 20_000)) {
  execFileSync(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12',
    '-af', 'tremolo=f=2:d=0.7',
    '-b:a', '192k', `${dir}/tone.mp3`,
  ]);
  log(`tone.mp3 ${(fs.statSync(`${dir}/tone.mp3`).size / 1024).toFixed(0)}KB`);
}

console.log('[fixtures] 清单：');
for (const f of fs.readdirSync(dir)) log(`  ${f}  ${(fs.statSync(path.join(dir, f)).size / 1024).toFixed(1)}KB`);

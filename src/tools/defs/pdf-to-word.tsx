import { Hint, Panel, Row, Segmented, Toggle } from '../../ui/controls';
import type { ControlsProps, Out, ToolDef } from '../types';
import type { JobCtx } from '../../core/jobs';
import { openPdf, type TextBlock } from '../../core/pdf';
import { pageBlocks } from '../../core/scan';
import { baseName, uniqueName } from '../../core/format';

/** 一行文字（由若干同行文字块拼成）。y 是 PDF 基线坐标，越大越靠上 */
type Line = { text: string; y: number; fh: number; x0: number; x1: number };
type Para = { text: string; fh: number; level: 0 | 1 | 2; pageBreak: boolean };
type DocxLib = {
  Document: any;
  Packer: any;
  Paragraph: any;
  TextRun: any;
  HeadingLevel: any;
};

const CJK = /[\u3000-\u303f\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]/;
const SENT_END = /[。！？；.!?;]+$/;
/** 行末连字符 + 下行小写开头 = 英文断词，接回去时去掉连字符 */
const HYPHEN = /[-‐‑‒–]+$/;

function median(xs: number[]): number {
  const a = xs.filter((v) => Number.isFinite(v)).sort((p, q) => p - q);
  return a.length ? a[Math.floor(a.length / 2)] : 0;
}

function displayLen(s: string): number {
  let n = 0;
  for (const ch of s) n += CJK.test(ch) ? 2 : 1;
  return n;
}

/**
 * 文字块 → 行。同一行的条件：基线 y 差 <= 0.6 × 两者较小字号（下限 1.2pt），
 * 且字号差不超过较大字号的 45%（否则大标题会把同行的小字吞进去）。
 * 行内按 x 升序拼接，块间空隙 > 0.28 倍字号才补一个空格。
 */
function toLines(blocks: TextBlock[]): Line[] {
  const mh = median(blocks.map((b) => b.fontHeight)) || 10;
  type Raw = { y: number; fh: number; items: TextBlock[] };
  const rows: Raw[] = [];
  for (const b of [...blocks].sort((p, q) => q.y - p.y || p.x - q.x)) {
    const fh = b.fontHeight > 0 ? b.fontHeight : mh;
    let hit: Raw | undefined;
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i];
      if (r.y - b.y > 3 * mh) break; // 更早的行都在上方很远处，不必再扫
      if (
        Math.abs(b.y - r.y) <= Math.max(1.2, 0.6 * Math.min(r.fh, fh)) &&
        Math.abs(fh - r.fh) <= 0.45 * Math.max(fh, r.fh)
      ) {
        hit = r;
        break;
      }
    }
    if (hit) hit.items.push(b);
    else rows.push({ y: b.y, fh, items: [b] });
  }

  const out: Line[] = [];
  for (const r of rows) {
    let text = '';
    let x0 = r.items[0]?.x ?? 0;
    let right = x0;
    for (const it of r.items.sort((a, b) => a.x - b.x)) {
      const t = it.str.replace(/\s+/g, ' ').trim();
      if (!t) continue;
      if (!text) {
        x0 = it.x;
        text = t;
      } else {
        // 块间空隙 > 0.28 倍字号才补空格；中文之间不加，免得把汉字隔开
        const gap = it.x - right;
        const bothCJK = CJK.test(text.slice(-1)) && CJK.test(t.charAt(0));
        if (gap > 0.28 * r.fh && !/\s$/.test(text) && !bothCJK) text += ' ';
        text += t;
      }
      right = Math.max(right, it.x + (it.w || displayLen(t) * r.fh * 0.5));
    }
    if (text.trim()) out.push({ text: text.trim(), y: r.y, fh: r.fh, x0, x1: right });
  }
  return out.sort((a, b) => b.y - a.y || a.x0 - b.x0);
}

/** 上下两行是否算同一段 */
function keepMerge(prev: Line, cur: Line, left: number, right: number, o: any): boolean {
  if (!o.mergeWrap) return false;
  if (Math.abs(cur.fh - prev.fh) > Math.max(0.8, 0.18 * cur.fh)) return false; // 字号不同
  const step = prev.y - cur.y;
  if (step <= 0) return false;
  if (step > 1.9 * Math.max(prev.fh, cur.fh)) return false; // 行距过大 = 换段
  if (cur.x0 - left > 0.9 * cur.fh && prev.x0 - left <= 0.2 * cur.fh) return false; // 当前行首行缩进
  const width = Math.max(1, right - left);
  if (SENT_END.test(prev.text) && prev.x1 < left + 0.86 * width) return false; // 上一行没写满就收了句
  return true;
}

function joinLines(a: string, b: string): string {
  if (HYPHEN.test(a) && /^[a-z]/.test(b)) return a.replace(HYPHEN, '') + b;
  const t1 = a.slice(-1);
  const t2 = b.charAt(0);
  return CJK.test(t1) || CJK.test(t2) ? a + b : `${a} ${b}`;
}

/** 行 → 段落（含标题判定），按页返回 */
function buildParas(pages: Line[][], o: any, bodyFH: number): Para[][] {
  return pages.map((lines) => {
    const left = lines.length ? Math.min(...lines.map((l) => l.x0)) : 0;
    const right = lines.length ? Math.max(...lines.map((l) => l.x1)) : 1;
    const out: Para[] = [];
    let cur: Line | null = null;
    const flush = () => {
      if (cur) out.push({ text: cur.text, fh: cur.fh, level: 0, pageBreak: false });
      cur = null;
    };
    for (const l of lines) {
      const ratio = bodyFH > 0 ? l.fh / bodyFH : 1;
      const head =
        o.detectHeading &&
        ratio >= 1.12 &&
        l.text.length <= 80 &&
        !SENT_END.test(l.text) &&
        !/[，,、]$/.test(l.text);
      if (head) {
        flush();
        out.push({ text: l.text, fh: l.fh, level: ratio >= 1.45 ? 1 : 2, pageBreak: false });
        continue;
      }
      if (cur && keepMerge(cur, l, left, right, o)) {
        // 几何量取「最近一行」，否则长段落会把行距越算越大后断开
        cur = { text: joinLines(cur.text, l.text), y: l.y, fh: cur.fh, x0: l.x0, x1: l.x1 };
        continue;
      }
      flush();
      cur = l;
    }
    flush();
    if (!out.length) out.push({ text: '（本页未提取到文字）', fh: bodyFH, level: 0, pageBreak: false });
    out[0] = { ...out[0], pageBreak: true };
    return out;
  });
}

/** 正文中位字号：按字数加权，避免少数大字行把基准抬高 */
function bodyFontSize(pages: Line[][]): number {
  const pool: number[] = [];
  for (const lines of pages) for (const l of lines) for (let i = 0; i < Math.max(1, Math.round(l.text.length / 8)); i++) pool.push(l.fh);
  return median(pool) || 10.5;
}

async function makeDocx(groups: Para[][], bodyFH: number, lib: DocxLib): Promise<Blob> {
  const size = Math.max(16, Math.min(56, Math.round(bodyFH * 2) || 22));
  const paras: Para[] = [];
  groups.forEach((g, i) =>
    g.forEach((p, j) => {
      if (i === 0 && j === 0) paras.push({ ...p, pageBreak: false });
      else paras.push(j === 0 ? { ...p, pageBreak: true } : p);
    }),
  );
  const children = paras.map((p) => {
    const opt: any = {
      children: [new lib.TextRun({ text: p.text, size: p.level ? Math.max(size, Math.round(p.fh * 2)) : size })],
      pageBreakBefore: p.pageBreak,
      spacing: { after: p.level ? 140 : 40, line: 276 },
    };
    if (p.level === 1) opt.heading = lib.HeadingLevel.HEADING_1;
    if (p.level === 2) opt.heading = lib.HeadingLevel.HEADING_2;
    return new lib.Paragraph(opt);
  });
  const doc = new lib.Document({
    styles: { default: { document: { run: { size, font: { ascii: 'Times New Roman', eastAsia: '宋体' } } } } },
    sections: [{ properties: {}, children }],
  });
  return await lib.Packer.toBlob(doc);
}

async function run(files: File[], o: any, ctx: any): Promise<Out[]> {
  return localRun(files, o, ctx);
}

function Controls({ value, patch }: ControlsProps) {
  return (
    <Panel>
      <Row label="合并段内换行" hint="把同一段被拆开的行接回去">
        <Toggle
          value={value.mergeWrap}
          onChange={(v) => patch({ mergeWrap: v })}
          label={value.mergeWrap ? '合并' : '一行一段'}
        />
      </Row>
      <Row label="识别标题" hint="按字号分两级">
        <Toggle
          value={value.detectHeading}
          onChange={(v) => patch({ detectHeading: v })}
          label={value.detectHeading ? '开' : '关'}
        />
      </Row>
      <Row label="文件拆分">
        <Segmented
          value={value.splitEvery}
          onChange={(v) => patch({ splitEvery: v })}
          options={[
            { value: 0, label: '整份一个' },
            { value: 5, label: '每 5 页一个' },
            { value: 10, label: '每 10 页一个' },
            { value: 20, label: '每 20 页一个' },
          ]}
        />
      </Row>
      <Row label="识别扫描页" hint="没有文字层的页自动做 OCR">
        <Toggle value={value.ocr} onChange={(v) => patch({ ocr: v })} label={value.ocr ? '开' : '关'} />
      </Row>
      {value.ocr && (
        <>
          <Row label="识别语言">
            <Segmented
              value={value.langs}
              onChange={(v) => patch({ langs: v })}
              options={[
                { value: 'chi_sim+eng', label: '简中 + 英文' },
                { value: 'eng', label: '纯英文' },
              ]}
            />
          </Row>
          <Row label="识别清晰度" hint="越高越准也越慢">
            <Segmented
              value={value.ocrDpi}
              onChange={(v) => patch({ ocrDpi: v })}
              options={[
                { value: 150, label: '标准' },
                { value: 200, label: '较高' },
                { value: 260, label: '最高' },
              ]}
            />
          </Row>
        </>
      )}
      <Hint>表格与图片只出文字，不还原位置。</Hint>
    </Panel>
  );
}

async function localRun(files: File[], o: any, ctx: JobCtx): Promise<Out[]> {
  const taken = new Set<string>();
  const outs: Out[] = [];
  const mod: any = await import('docx');
  const lib: DocxLib = {
    Document: mod.Document,
    Packer: mod.Packer,
    Paragraph: mod.Paragraph,
    TextRun: mod.TextRun,
    HeadingLevel: mod.HeadingLevel,
  };

  for (let k = 0; k < files.length; k++) {
    ctx.tick();
    const file = files[k];
    const tag = files.length > 1 ? `${baseName(file.name)} · ` : '';
    const doc = await openPdf(file);
    const n = doc.numPages;
    const pages: Line[][] = [];
    let ocrPages = 0;
    try {
      for (let p = 1; p <= n; p++) {
        ctx.tick();
        ctx.progress({ done: p - 1, total: n, label: `${tag}读取第 ${p}/${n} 页` });
        const { blocks, viaOcr } = await pageBlocks(doc, p, { ocr: !!o.ocr, langs: o.langs, dpi: o.ocrDpi }, ctx);
        if (viaOcr) ocrPages++;
        pages.push(toLines(blocks));
        await ctx.breathe();
      }
    } finally {
      await doc.destroy();
    }

    const pageChars = pages.map((ls) => ls.reduce((s, l) => s + l.text.length, 0));
    const chars = pageChars.reduce((s, c) => s + c, 0);
    if (!chars)
      throw new Error(
        o.ocr
          ? `${tag}没认出文字。扫描件可以提高「识别清晰度」或换清晰点的图再试`
          : `${tag}这个 PDF 没有文字层，打开「识别扫描页」再试一次`,
      );

    ctx.progress({ done: 0, total: 1, label: `${tag}生成 Word` });
    const bodyFH = bodyFontSize(pages);
    const paras = buildParas(pages, o, bodyFH);

    const step = Math.max(1, o.splitEvery > 0 ? o.splitEvery : n);
    const base = baseName(file.name);
    for (let a = 0; a < n; a += step) {
      ctx.tick();
      const count = Math.min(step, n - a);
      const blob = await makeDocx(paras.slice(a, a + count), bodyFH, lib);
      const name = count < n ? `${base}-第${a + 1}至${a + count}页.docx` : `${base}.docx`;
      outs.push({
        name: uniqueName(name, taken),
        blob,
        kind: 'doc',
        note: `${count} 页 · 约 ${pageChars.slice(a, a + count).reduce((s, c) => s + c, 0)} 字${
          ocrPages ? ` · ${ocrPages} 页走识别` : ''
        }`,
      });
      await ctx.breathe();
    }
  }
  return outs;
}

const tool: ToolDef = {
  id: 'pdf-to-word',
  name: 'PDF 转 Word',
  desc: '抽取文字生成可编辑 docx',
  zone: 'convert',
  icon: '📝',
  accept: 'application/pdf,.pdf',
  multiple: true,
  inputHint: '有文字层的页直接抽；扫描页自动走识别',
  defaults: { mergeWrap: true, detectHeading: true, splitEvery: 0, ocr: true, langs: 'chi_sim+eng', ocrDpi: 200 },
  Controls,
  run,
  serverHint: '只抽文字成段落，版式与图片不保留。',
};

export default tool;

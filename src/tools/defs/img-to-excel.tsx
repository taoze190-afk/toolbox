import { Hint, Panel, Row, Segmented, Toggle } from '../../ui/controls';
import type { ControlsProps, Out, ToolDef } from '../types';
import type { JobCtx } from '../../core/jobs';
import { ocrImage, disposeOcr, stripGridLines, type OcrResult } from '../../core/ocr';
import { decode, flatten, ih, iw, resize } from '../../core/images';
import { baseName, uniqueName } from '../../core/format';

const CJK = /[\u3000-\u303f\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]/;
const NUM = /^[+-]?(\d[\d,]*\.?\d*|\.\d+)(e[+-]?\d+)?$/i;
const MAX_SIDE = 3000;

/** 列间距容差档位（px），以中位字高为标尺，图越大阈值自动放大 */
const GAP = {
  narrow: (mh: number) => Math.max(4, 0.8 * mh),
  std: (mh: number) => Math.max(8, 1.6 * mh),
  wide: (mh: number) => Math.max(16, 3.2 * mh),
} as const;

type Word = { text: string; x: number; y: number; w: number; h: number; cx: number; cy: number };
type Sheet = { name: string; grid: string[][] };

function median(xs: number[]): number {
  const a = xs.filter((v) => Number.isFinite(v)).sort((p, q) => p - q);
  return a.length ? a[Math.floor(a.length / 2)] : 0;
}

function displayLen(s: string): number {
  let n = 0;
  for (const ch of s) n += CJK.test(ch) ? 2 : 1;
  return n;
}

function joinText(a: string, b: string): string {
  if (!a) return b;
  const t1 = a.slice(-1);
  const t2 = b.charAt(0);
  return CJK.test(t1) || CJK.test(t2) ? a + b : `${a} ${b}`;
}

/** 词按 y 中心聚成行：中心差 <= 0.7 倍中位字高，且字高差不超过 45% */
function toRows(words: Word[], mh: number): Word[][] {
  type R = { cy: number; h: number; items: Word[] };
  const rows: R[] = [];
  for (const b of [...words].sort((p, q) => p.cy - q.cy || p.x - q.x)) {
    const h = b.h || mh;
    let hit: R | undefined;
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i];
      if (b.cy - r.cy > 3 * mh) break;
      if (Math.abs(b.cy - r.cy) <= 0.7 * mh && Math.abs(h - r.h) <= 0.45 * Math.max(h, r.h)) {
        hit = r;
        break;
      }
    }
    if (hit) hit.items.push(b);
    else rows.push({ cy: b.cy, h, items: [b] });
  }
  return rows
    .sort((a, b) => a.cy - b.cy)
    .map((r) => r.items.sort((a, b) => a.x - b.x));
}

/** 词中心 x 的一维聚类（单连接），得到列锚点 */
function columnAnchors(words: Word[], tol: number): number[] {
  const xs = words.map((w) => w.cx).sort((a, b) => a - b);
  const groups: number[][] = [];
  for (const x of xs) {
    const g = groups[groups.length - 1];
    if (g && x - g[g.length - 1] <= tol) g.push(x);
    else groups.push([x]);
  }
  return groups.map((g) => g.reduce((s, v) => s + v, 0) / g.length);
}

function toGrid(rows: Word[][], anchors: number[]): string[][] {
  return rows.map((items) => {
    const cells: string[] = anchors.map(() => '');
    for (const b of items) {
      let best = 0;
      let bd = Infinity;
      anchors.forEach((a, i) => {
        const d = Math.abs(b.cx - a);
        if (d < bd) {
          bd = d;
          best = i;
        }
      });
      cells[best] = joinText(cells[best], b.text);
    }
    return cells;
  });
}

const PSMS: Record<string, string> = { auto: '3', column: '4', block: '6', sparse: '11' };

function psmFor(o: any): string {
  return PSMS[o.psm] ?? PSMS.auto;
}

function flattenWords(res: OcrResult): Word[] {
  const out: Word[] = [];
  for (const l of res.lines) {
    for (const w of l.words) {
      const text = w.text.trim();
      if (!text) continue;
      out.push({ text, x: w.x, y: w.y, w: w.w, h: w.h, cx: w.x + w.w / 2, cy: w.y + w.h / 2 });
    }
  }
  return out;
}

function toValue(s: string, numeric: boolean): unknown {
  if (!s) return '';
  if (!numeric || CJK.test(s)) return s;
  const t = s.replace(/\s/g, '');
  return NUM.test(t) && /\d/.test(t) ? Number(t.replace(/,/g, '')) : s;
}

function safeSheetName(name: string, fallback: string): string {
  const s = name.replace(/[\\/?*[\]:]/g, ' ').trim();
  return (s || fallback).slice(0, 31);
}

async function readImage(file: File, o: any, ctx: JobCtx, tag: string): Promise<OcrResult> {
  const img = await decode(file);
  const w0 = iw(img);
  const h0 = ih(img);
  let scale = o.scale >= 2 ? 2 : 1;
  const longest = Math.max(w0, h0);
  if (longest * scale > MAX_SIDE) scale = Math.max(1, MAX_SIDE / longest);
  const cv = resize(img, Math.round(w0 * scale), Math.round(h0 * scale));
  if ('close' in img) img.close();
  const work = flatten(cv);
  cv.width = cv.height = 0;
  if (o.stripGrid) stripGridLines(work);
  try {
    return await ocrImage(
      work,
      o.langs,
      (p) => ctx.progress({ done: p.done, total: p.total, label: `${tag}${p.label ?? '识别中'}` }),
    psmFor(o),
    );
  } finally {
    work.width = work.height = 0;
  }
}

async function writeXlsx(sheets: Sheet[], raw: string[], numeric: boolean): Promise<Blob> {
  const mod: any = await import('exceljs');
  const ExcelJS: any = mod.default ?? mod;
  const wb = new ExcelJS.Workbook();
  wb.creator = '全能工具箱';
  const put = (name: string, rows: string[][], wideLast = false) => {
    const ws = wb.addWorksheet(name);
    const cols = rows.reduce((m, r) => Math.max(m, r.length), 0);
    rows.forEach((r, i) => {
      const row = ws.getRow(i + 1);
      row.values = r.map((v) => (wideLast ? v : toValue(v, numeric)));
      row.commit();
    });
    const widths = new Array(Math.max(1, cols)).fill(8);
    rows.forEach((r) => {
      for (let c = 0; c < r.length; c++) widths[c] = Math.max(widths[c], displayLen(r[c]));
    });
    for (let c = 0; c < widths.length; c++) {
      ws.getColumn(c + 1).width = wideLast ? 110 : Math.min(48, widths[c] * 1.15 + 2);
    }
    ws.views = [{ state: 'frozen', xSplit: 0, ySplit: 1 }];
  };
  const used = new Set<string>();
  const uniq = (base: string) => {
    let name = base;
    let i = 2;
    while (used.has(name)) {
      name = `${base.slice(0, 28)}-${i++}`;
    }
    used.add(name);
    return name;
  };
  for (const s of sheets) put(uniq(safeSheetName(s.name, '表格')), s.grid, false);
  if (raw.length) put(uniq('逐行文本'), raw.map((t) => [t]), true);
  const buf = await wb.xlsx.writeBuffer();
  return new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

function Controls({ value, patch }: ControlsProps) {
  return (
    <Panel>
      <Row label="识别语言" hint="离线语言包只有这两种">
        <Segmented
          value={value.langs}
          onChange={(v) => patch({ langs: v })}
          options={[
            { value: 'chi_sim+eng', label: '简中 + 英文' },
            { value: 'eng', label: '纯英文' },
          ]}
        />
      </Row>
      <Row label="列间距" hint="格子被拆得太碎就选宽">
        <Segmented
          value={value.gap}
          onChange={(v) => patch({ gap: v })}
          options={[
            { value: 'narrow', label: '窄' },
            { value: 'std', label: '标准' },
            { value: 'wide', label: '宽' },
          ]}
        />
      </Row>
      <Row label="识别前放大" hint="小图放大后准得多">
        <Segmented
          value={value.scale}
          onChange={(v) => patch({ scale: v })}
          options={[
            { value: 1, label: '不放大' },
            { value: 2, label: '2 倍' },
          ]}
        />
      </Row>
      <Row label="识别模式" hint="拆不出列时换一种">
        <Segmented
          value={value.psm}
          onChange={(v) => patch({ psm: v })}
          options={[
            { value: 'auto', label: '自动' },
            { value: 'column', label: '整列文本' },
            { value: 'block', label: '整块文本' },
            { value: 'sparse', label: '散落文字' },
          ]}
        />
      </Row>
      <Row label="格线处理" hint="格线会被识别成竖线字符">
        <Toggle
          value={value.stripGrid}
          onChange={(v) => patch({ stripGrid: v })}
          label={value.stripGrid ? '识别前抹掉表格线' : '保留原样'}
        />
      </Row>
      <Row label="数字">
        <Toggle
          value={value.numeric}
          onChange={(v) => patch({ numeric: v })}
          label={value.numeric ? '转成数值' : '全按文本'}
        />
      </Row>
      <Row label="逐行文本表" hint="另建一张表方便人工核对">
        <Toggle
          value={value.rawSheet}
          onChange={(v) => patch({ rawSheet: v })}
          label={value.rawSheet ? '输出' : '不输出'}
        />
      </Row>
      <Hint>没有格线可依，列是按字的位置猜的，务必核对。</Hint>
    </Panel>
  );
}

async function run(files: File[], o: any, ctx: JobCtx): Promise<Out[]> {
  const taken = new Set<string>();
  const sheets: Sheet[] = [];
  const raw: string[] = [];
  const failed: string[] = [];
  let confSum = 0;
  let confN = 0;

  try {
    for (let i = 0; i < files.length; i++) {
      ctx.tick();
      const tag = files.length > 1 ? `${i + 1}/${files.length} ` : '';
      ctx.progress({ done: i, total: files.length, label: `${tag}识别 ${files[i].name}` });
      let res: OcrResult;
      try {
        res = await readImage(files[i], o, ctx, tag);
      } catch (e) {
        ctx.tick();
        if ((e as Error).name === 'Cancelled') throw e;
        failed.push(files[i].name);
        continue;
      }
      const words = flattenWords(res);
      if (!words.length) {
        failed.push(files[i].name);
        continue;
      }
      const mh = median(words.map((w) => w.h)) || 20;
      const tolFn = (GAP as any)[o.gap in GAP ? o.gap : 'std'] ?? GAP.std;
      const anchors = columnAnchors(words, tolFn(mh));
      const grid = toGrid(toRows(words, mh), anchors);
      const stem = baseName(files[i].name);
      sheets.push({ name: files.length > 1 ? stem : '识别结果', grid });
      if (o.rawSheet) {
        if (files.length > 1) raw.push(`【${stem}】`);
        for (const l of res.lines) if (l.text.trim()) raw.push(l.text.trim());
      }
      confSum += res.conf;
      confN++;
      await ctx.breathe();
    }

    if (!sheets.length) {
      throw new Error(failed.length ? `都没识别出文字：${failed.slice(0, 2).join('、')}` : '没识别出文字，换张更清晰的图试试');
    }

    const rows = sheets.reduce((s, x) => s + x.grid.length, 0);
    const cols = sheets.reduce((s, x) => Math.max(s, x.grid.reduce((m, r) => Math.max(m, r.length), 0)), 0);
    const conf = Math.round(confSum / Math.max(1, confN));
    ctx.progress({ done: 1, total: 1, label: '生成 Excel' });
    const blob = await writeXlsx(sheets, o.rawSheet ? raw : [], !!o.numeric);
    const outs: Out[] = [
      {
        name: uniqueName(files.length > 1 ? '图片转表格.xlsx' : `${baseName(files[0].name)}.xlsx`, taken),
        blob,
        kind: 'sheet',
        note: `${rows} 行 × ${cols} 列 · 置信度 ${conf}%${conf < 70 ? ' · 识别置信度低，建议提高清晰度或放大后重试' : ''}`,
      },
    ];
    if (failed.length) outs[0].note = `${outs[0].note} · ${failed.length} 张未识别`;
    return outs;
  } finally {
    await disposeOcr();
  }
}

const tool: ToolDef = {
  id: 'img-to-excel',
  name: '图片转 Excel',
  desc: '离线 OCR 重建表格',
  zone: 'convert',
  icon: '🧮',
  accept: 'image/*',
  multiple: true,
  inputHint: '多张图会各生成一个工作表，便于逐张核对',
  defaults: { langs: 'chi_sim+eng', psm: 'block', gap: 'std', scale: 2, stripGrid: true, numeric: true, rawSheet: true },
  Controls,
  run,
  serverHint: '识别后按文字位置重建表格，格线与图片不保留。',
};

export default tool;

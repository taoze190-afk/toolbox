import { Hint, Panel, Row, Segmented, Toggle } from '../../ui/controls';
import type { ControlsProps, Out, ToolDef } from '../types';
import type { JobCtx } from '../../core/jobs';
import { openPdf, type TextBlock } from '../../core/pdf';
import { pageBlocks as blocksWithOcr } from '../../core/scan';
import { baseName, uniqueName } from '../../core/format';

/** 一行的原始文字块，y 是 PDF 基线坐标（越大越靠上） */
type Row = { y: number; fh: number; items: TextBlock[] };

const CJK = /[\u3000-\u303f\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]/;
const NUM = /^[+-]?(\d[\d,]*\.?\d*|\.\d+)(e[+-]?\d+)?$/i;

/** 列聚类容差档位：基于中位字宽，字号自适应 */
const TOL = {
  tight: (cw: number) => Math.max(2.5, 1.2 * cw),
  mid: (cw: number) => Math.max(5, 2.2 * cw),
  loose: (cw: number) => Math.max(10, 4 * cw),
} as const;

function median(xs: number[]): number {
  const a = xs.filter((v) => Number.isFinite(v)).sort((p, q) => p - q);
  return a.length ? a[Math.floor(a.length / 2)] : 0;
}

function displayLen(s: string): number {
  let n = 0;
  for (const ch of s) n += CJK.test(ch) ? 2 : 1;
  return n;
}

/** 文字块按基线聚成行：y 差 <= 0.6 倍较小字号，且字号差不超过 45% */
function toRows(blocks: TextBlock[]): Row[] {
  const mh = median(blocks.map((b) => b.fontHeight)) || 10;
  const rows: Row[] = [];
  for (const b of [...blocks].sort((p, q) => q.y - p.y || p.x - q.x)) {
    const fh = b.fontHeight > 0 ? b.fontHeight : mh;
    let hit: Row | undefined;
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i];
      if (r.y - b.y > 3 * mh) break;
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
  return rows.sort((a, b) => b.y - a.y).map((r) => ({ ...r, items: r.items.sort((a, b) => a.x - b.x) }));
}

/** 用所有块的 x 起点做一维聚类，得到列锚点 */
function columnAnchors(blocks: TextBlock[], tol: number): number[] {
  const xs = blocks.map((b) => b.x).sort((a, b) => a - b);
  const groups: number[][] = [];
  for (const x of xs) {
    const last = groups[groups.length - 1];
    if (last && x - last[last.length - 1] <= tol) last.push(x);
    else groups.push([x]);
  }
  return groups.map((g) => g.reduce((s, v) => s + v, 0) / g.length);
}

function cellText(items: TextBlock[], fh: number): string {
  let text = '';
  let right = items[0]?.x ?? 0;
  for (const it of items) {
    const t = it.str.replace(/\s+/g, ' ').trim();
    if (!t) continue;
    if (!text) text = t;
    else {
      const gap = it.x - right;
      // 中文字块挨着时不插空格，但空隙超过 1.2 倍字号说明是并列内容，要隔开
      const bothCJK = CJK.test(text.slice(-1)) && CJK.test(t.charAt(0));
      if (gap > 0.28 * fh && !/\s$/.test(text) && !(bothCJK && gap <= 1.2 * fh)) text += ' ';
      text += t;
    }
    right = Math.max(right, it.x + (it.w || displayLen(t) * fh * 0.5));
  }
  return text.trim();
}

/** 行 → 二维表（单元格为字符串） */
function grid(rows: Row[], anchors: number[]): string[][] {
  const out: string[][] = [];
  for (const r of rows) {
    const cells: TextBlock[][] = anchors.map(() => []);
    for (const b of r.items) {
      let best = 0;
      let bd = Infinity;
      anchors.forEach((a, i) => {
        const d = Math.abs(b.x - a);
        if (d < bd) {
          bd = d;
          best = i;
        }
      });
      cells[best].push(b);
    }
    out.push(cells.map((c) => (c.length ? cellText(c, r.fh) : '')));
  }
  return out;
}

function toValue(s: string, numeric: boolean): unknown {
  if (!s) return '';
  if (!numeric) return s;
  if (CJK.test(s)) return s;
  const t = s.replace(/\s/g, '');
  return NUM.test(t) && /\d/.test(t) ? Number(t.replace(/,/g, '')) : s;
}

async function writeXlsx(
  sheets: { name: string; rows: string[][] }[],
  numeric: boolean,
  ExcelJS: any,
): Promise<Blob> {
  const wb = new ExcelJS.Workbook();
  wb.creator = '全能工具箱';
  wb.created = new Date();
  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name.slice(0, 31) || '表');
    const cols = s.rows.reduce((m, r) => Math.max(m, r.length), 0);
    s.rows.forEach((r, i) => {
      const row = ws.getRow(i + 1);
      row.values = r.map((v) => toValue(v, numeric));
      row.commit();
    });
    const widths = new Array(cols).fill(8);
    s.rows.forEach((r) => {
      for (let c = 0; c < r.length; c++) widths[c] = Math.max(widths[c], displayLen(r[c]));
    });
    for (let c = 0; c < cols; c++) ws.getColumn(c + 1).width = Math.min(48, widths[c] * 1.15 + 2);
    ws.views = [{ state: 'frozen', xSplit: 0, ySplit: 1 }];
  }
  const buf = await wb.xlsx.writeBuffer();
  return new Blob([buf], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

async function run(files: File[], o: any, ctx: any): Promise<Out[]> {
  return localRun(files, o, ctx);
}

function Controls({ value, patch }: ControlsProps) {
  return (
    <Panel>
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
      <Row label="列容差" hint="越大越容易把相邻列并成一列">
        <Segmented
          value={value.colTol}
          onChange={(v) => patch({ colTol: v })}
          options={[
            { value: 'tight', label: '紧' },
            { value: 'mid', label: '中' },
            { value: 'loose', label: '松' },
          ]}
        />
      </Row>
      <Row label="表结构">
        <Segmented
          value={value.layout}
          onChange={(v) => patch({ layout: v })}
          options={[
            { value: 'page', label: '每页一张表' },
            { value: 'single', label: '全部并到一张' },
          ]}
        />
      </Row>
      <Row label="跨页表头" hint="与上一页首行相同则删掉">
        <Toggle
          value={value.dedupHead}
          onChange={(v) => patch({ dedupHead: v })}
          label={value.dedupHead ? '去重' : '保留'}
        />
      </Row>
      <Row label="数字">
        <Toggle
          value={value.numeric}
          onChange={(v) => patch({ numeric: v })}
          label={value.numeric ? '转成数值' : '全按文本'}
        />
      </Row>
      <Hint>跨列的长文字会被塞进它起始位置所在的那一格。</Hint>
    </Panel>
  );
}

async function localRun(files: File[], o: any, ctx: JobCtx): Promise<Out[]> {
  const taken = new Set<string>();
  const outs: Out[] = [];
  const mod: any = await import('exceljs');
  const ExcelJS: any = mod.default ?? mod;

  for (let k = 0; k < files.length; k++) {
    ctx.tick();
    const file = files[k];
    const tag = files.length > 1 ? `${baseName(file.name)} · ` : '';
    const doc = await openPdf(file);
    const n = doc.numPages;
    const pageRows: Row[][] = [];
    const pageBlocks: TextBlock[][] = [];
    let ocrPages = 0;
    try {
      for (let p = 1; p <= n; p++) {
        ctx.tick();
        ctx.progress({ done: p - 1, total: n, label: `${tag}读取第 ${p}/${n} 页` });
        const { blocks, viaOcr } = await blocksWithOcr(doc, p, { ocr: !!o.ocr, langs: o.langs, dpi: o.ocrDpi, stripGrid: true }, ctx);
        if (viaOcr) ocrPages++;
        pageBlocks.push(blocks);
        pageRows.push(toRows(blocks));
        await ctx.breathe();
      }
    } finally {
      await doc.destroy();
    }

    const total = pageRows.reduce((s, r) => s + r.length, 0);
    if (!total)
      throw new Error(
        o.ocr
          ? `${tag}没认出可成表的文字。扫描件可以提高「识别清晰度」或换清晰的图再试`
          : `${tag}这个 PDF 没有文字层，打开「识别扫描页」再试一次`,
      );

    ctx.progress({ done: 0, total: 1, label: `${tag}还原表格` });
    const tolOf = (blocks: TextBlock[]) => {
      const cw =
        median(
          blocks.map((b) => {
            const len = b.str.replace(/\s/g, '').length || 1;
            return b.w > 0 ? b.w / len : b.fontHeight * 0.5;
          }),
        ) || 5;
      return (TOL as any)[o.colTol in TOL ? o.colTol : 'mid'](cw);
    };

    const sheets: { name: string; rows: string[][] }[] = [];
    let prevHead = '';
    let rowsAll = 0;
    let colsAll = 0;

    const count = (rows: string[][]) => {
      rowsAll += rows.length;
      colsAll = Math.max(colsAll, rows.reduce((m, r) => Math.max(m, r.length), 0));
    };

    if (o.layout === 'single') {
      const all = pageBlocks.flat();
      const anchors = columnAnchors(all, tolOf(all));
      let merged: string[][] = [];
      pageRows.forEach((rows) => {
        let g = grid(rows, anchors);
        if (o.dedupHead && g.length) {
          const head = g[0].join('\u0001');
          if (head === prevHead) g = g.slice(1);
          else prevHead = head;
        }
        merged = merged.concat(g);
      });
      if (merged.length) {
        sheets.push({ name: '识别结果', rows: merged });
        count(merged);
      }
    } else {
      for (let p = 0; p < n; p++) {
        const anchors = columnAnchors(pageBlocks[p], tolOf(pageBlocks[p]));
        let g = grid(pageRows[p], anchors);
        if (o.dedupHead && g.length) {
          const head = g[0].join('\u0001');
          if (head === prevHead) g = g.slice(1);
          else prevHead = head;
        }
        if (g.length) {
          sheets.push({ name: `第${p + 1}页`, rows: g });
          count(g);
        }
      }
    }

    if (!sheets.length) throw new Error(`${tag}没还原出可用的行`);
    const blob = await writeXlsx(sheets, !!o.numeric, ExcelJS);
    outs.push({
      name: uniqueName(`${baseName(file.name)}.xlsx`, taken),
      blob,
      kind: 'sheet',
      note: `${rowsAll} 行 × ${colsAll} 列${ocrPages ? ` · ${ocrPages} 页走识别` : ''}`,
    });
    await ctx.breathe();
  }
  return outs;
}

const tool: ToolDef = {
  id: 'pdf-to-excel',
  name: 'PDF 转 Excel',
  desc: '按文字坐标重建表格',
  zone: 'convert',
  icon: '🗂️',
  accept: 'application/pdf,.pdf',
  multiple: true,
  inputHint: '排版规整的表格式 PDF 最好；扫描表格会自动走识别',
  defaults: { colTol: 'mid', layout: 'page', dedupHead: true, numeric: true, ocr: true, langs: 'chi_sim+eng', ocrDpi: 200 },
  Controls,
  run,
  serverHint: '只按坐标重建表格，版式与图片不保留。',
};

export default tool;

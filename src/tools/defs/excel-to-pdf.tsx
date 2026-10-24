import { Panel, Row, Segmented, Toggle, Hint } from '../../ui/controls';
import type { ControlsProps, Out, ToolDef } from '../types';
import type { JobCtx } from '../../core/jobs';
import { newPdfDoc, PAGE_SIZES, pdfBlob } from '../../core/pdf';
import { encode, makeCanvas } from '../../core/images';
import { baseName, uniqueName } from '../../core/format';

/* ---------------- 排版基础设施（本文件私有：画布 + 分页） ---------------- */

const S = 2.5; // 每 pt 的像素（≈180dpi）
const PT = 0.75; // 96dpi 像素 -> pt
const FONT = '"Noto Sans SC","Noto Sans CJK SC","PingFang SC","Microsoft YaHei",system-ui,sans-serif';
const CJK = /[\u2E80-\u2EFF\u3000-\u303F\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/;
const MARGIN = 24; // 页边距 pt

function tokenize(s: string): string[] {
  const toks: string[] = [];
  let cur = '';
  for (const ch of s) {
    if (CJK.test(ch)) {
      if (cur) toks.push(cur);
      cur = '';
      toks.push(ch);
    } else if (ch === ' ') {
      if (cur) toks.push(cur);
      cur = '';
      toks.push(' ');
    } else cur += ch;
  }
  if (cur) toks.push(cur);
  return toks;
}

/** 只用于测宽/换行的离屏上下文 */
const MCTX = makeCanvas(2048, 64).getContext('2d')!;

function textW(size: number, bold: boolean, text: string): number {
  MCTX.font = `${bold ? 'bold ' : ''}${Math.max(5, Math.round(size))}px ${FONT}`;
  return MCTX.measureText(text).width;
}

/** 中文按字断、英文按空格断，行宽不超过 maxW */
function wrap(size: number, bold: boolean, text: string, maxW: number): string[] {
  const out: string[] = [];
  textW(size, bold, '');
  for (const raw of String(text).split('\n')) {
    const para = raw.replace(/[ \t]+/g, ' ').trim();
    if (!para) continue;
    let line = '';
    let lw = 0;
    for (const t of tokenize(para)) {
      const tw = textW(size, bold, t);
      if (!line) {
        if (t === ' ') continue;
        line = t;
        lw = tw;
        continue;
      }
      if (lw + tw <= maxW) {
        line += t;
        lw += tw;
      } else {
        out.push(line);
        line = t === ' ' ? '' : t;
        lw = t === ' ' ? 0 : tw;
      }
    }
    if (line) out.push(line);
  }
  return out;
}

/** 一页画布 */
class Page {
  readonly cv: HTMLCanvasElement;
  readonly g: CanvasRenderingContext2D;
  readonly W: number;
  readonly H: number;
  readonly M: number;

  constructor(pageW: number, pageH: number) {
    this.W = Math.round(pageW * S);
    this.H = Math.round(pageH * S);
    this.M = Math.round(MARGIN * S);
    this.cv = makeCanvas(this.W, this.H);
    this.g = this.cv.getContext('2d', { alpha: false })!;
    this.g.fillStyle = '#ffffff';
    this.g.fillRect(0, 0, this.W, this.H);
    this.g.textBaseline = 'top';
  }

  rect(x: number, y: number, w: number, h: number, color: string): void {
    this.g.fillStyle = color;
    this.g.fillRect(x, y, w, h);
  }

  text(s: string, x: number, y: number, size: number, bold: boolean, color: string, right: boolean, w: number): void {
    this.g.font = `${bold ? 'bold ' : ''}${Math.max(5, Math.round(size))}px ${FONT}`;
    this.g.fillStyle = color;
    this.g.textAlign = right ? 'right' : 'left';
    this.g.fillText(s, right ? x + w : x, y, Math.max(8, w));
    this.g.textAlign = 'left';
  }

  line(x1: number, y1: number, x2: number, y2: number, color: string, lw: number): void {
    this.g.strokeStyle = color;
    this.g.lineWidth = Math.max(1, lw);
    this.g.beginPath();
    this.g.moveTo(Math.round(x1) + 0.5, Math.round(y1) + 0.5);
    this.g.lineTo(Math.round(x2) + 0.5, Math.round(y2) + 0.5);
    this.g.stroke();
  }
}

/* ---------------- xlsx 读取 ---------------- */

function l2n(s: string): number {
  let n = 0;
  for (const ch of s.toUpperCase()) {
    if (ch < 'A' || ch > 'Z') break;
    n = n * 26 + (ch.charCodeAt(0) - 64);
  }
  return n;
}

function numStr(v: number): string {
  if (!Number.isFinite(v)) return '';
  if (Number.isInteger(v)) return String(v);
  return String(parseFloat(v.toPrecision(12)));
}

/** exceljs 的 value 可能是 Date / {richText} / {text} / {result} / {error} / 布尔 / 数字 */
function cellText(v: any): { text: string; right: boolean } {
  if (v === null || v === undefined || v === '') return { text: '', right: false };
  if (v instanceof Date) return { text: isNaN(v.getTime()) ? '' : v.toLocaleDateString('zh-CN'), right: false };
  if (typeof v === 'number') return { text: numStr(v), right: true };
  if (typeof v === 'boolean') return { text: v ? 'TRUE' : 'FALSE', right: true };
  if (typeof v === 'string') return { text: v.replace(/\r/g, '').trim(), right: false };
  if (Array.isArray(v)) return { text: v.map((x) => cellText(x).text).join(' '), right: false };
  if (v instanceof Uint8Array) return { text: '', right: false };
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return { text: v.richText.map((t: any) => String(t?.text ?? '')).join('').trim(), right: false };
    if ('result' in v) return cellText(v.result);
    if ('sharedFormula' in v) return { text: '', right: false };
    if ('text' in v) return { text: String(v.text ?? '').trim(), right: false };
    if ('error' in v) return { text: String(v.error ?? ''), right: false };
    if ('value' in v) return cellText(v.value);
    if ('hyperlink' in v) return { text: String(v.hyperlink ?? ''), right: false };
    try {
      return { text: String(v).trim(), right: false };
    } catch {
      return { text: '', right: false };
    }
  }
  return { text: String(v), right: false };
}

type Merge = { r0: number; c0: number; r1: number; c1: number }; // 0-based

type Grid = {
  nR: number;
  nC: number;
  text: string[][];
  right: boolean[][];
  rowH: number[]; // 声明行高 pt，0 = 未设置
  colW: number[]; // 声明列宽（Excel 字符宽度），0 = 未设置
  merges: Merge[];
  over: number;
};

const MAX_ROWS = 4000;
const MAX_COLS = 60;

function readGrid(ws: any): Grid {
  const nR = Math.max(0, Math.min(Number(ws.rowCount) || 0, MAX_ROWS));
  const nC = Math.max(0, Math.min(Number(ws.columnCount) || 0, MAX_COLS));
  const colW: number[] = [];
  for (let c = 1; c <= nC; c++) {
    const w = Number(ws.getColumn(c)?.width);
    colW.push(Number.isFinite(w) && w > 0 ? w : 0);
  }
  // 合并单元格：exceljs 读取后只保留在运行时 ws._merges（master 地址 -> Range 对象）
  const raw: Merge[] = [];
  const ms = ws._merges;
  if (ms && typeof ms === 'object') {
    for (const key of Object.keys(ms)) {
      const r = ms[key];
      if (r && Number.isFinite(r.top)) raw.push({ r0: r.top - 1, c0: r.left - 1, r1: r.bottom - 1, c1: r.right - 1 });
    }
  }
  if (!raw.length && ws._merges === undefined && Array.isArray(ws.model?.merges)) {
    // 注意：model 上没有 mergeCells 字段（那是解析期的临时模型），运行时字段叫 merges；
    // 取 model 代价很高，只在拿不到 _merges 的构建里才走这条路
    for (const s of ws.model.merges as string[]) {
      const g = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(String(s).trim().toUpperCase());
      if (g) raw.push({ r0: Number(g[2]) - 1, c0: l2n(g[1]) - 1, r1: Number(g[4]) - 1, c1: l2n(g[3]) - 1 });
    }
  }
  const merges = raw
    .map((m) => ({
      r0: Math.max(0, m.r0),
      c0: Math.max(0, m.c0),
      r1: Math.min(nR - 1, m.r1),
      c1: Math.min(nC - 1, m.c1),
    }))
    .filter((m) => m.r0 <= m.r1 && m.c0 <= m.c1);
  const slave = new Set<string>();
  for (const m of merges) {
    for (let r = m.r0; r <= m.r1; r++) for (let c = m.c0; c <= m.c1; c++) if (r !== m.r0 || c !== m.c0) slave.add(`${r},${c}`);
  }
  const text: string[][] = [];
  const right: boolean[][] = [];
  const rowH: number[] = [];
  for (let r = 1; r <= nR; r++) {
    const row = typeof ws.findRow === 'function' ? ws.findRow(r) : undefined;
    const ts: string[] = [];
    const rs: boolean[] = [];
    for (let c = 1; c <= nC; c++) {
      if (slave.has(`${r - 1},${c - 1}`)) {
        ts.push('');
        rs.push(false);
        continue;
      }
      const cell = row && typeof row.findCell === 'function' ? row.findCell(c) : undefined;
      const v = cell ? cellText(cell.value) : { text: '', right: false };
      ts.push(v.text);
      rs.push(v.right);
    }
    text.push(ts);
    right.push(rs);
    const h = Number(row?.height);
    rowH.push(Number.isFinite(h) && h > 0 ? h : 0);
  }
  const over = Math.max(0, (Number(ws.rowCount) || 0) - nR) + Math.max(0, (Number(ws.columnCount) || 0) - nC);
  return { nR, nC, text, right, rowH, colW, merges, over };
}

/* ---------------- 列宽方案 ---------------- */

type Plan = { c0: number; c1: number; w: number[]; font: number };

/** 列宽：优先声明宽度，否则按内容实测；总宽超页时按模式处理 */
function planColumns(g: Grid, availW: number, baseFont: number, mode: string): Plan[] {
  const measure = (font: number): number[] => {
    const pad = Math.max(3, font * 0.22);
    const one = textW(font, false, '国');
    const nat: number[] = [];
    // 大表逐格实测太慢：按步长抽样，够定比例即可
    const step = Math.max(1, Math.ceil(g.nR / 300));
    for (let c = 0; c < g.nC; c++) {
      // Excel 的 width 单位是"字符数"，1 字符 ≈ 7px@96dpi；不换算就会窄到放不下一个汉字
      const declared = g.colW[c] > 0 ? (g.colW[c] * 7 + 5) * PT * S : 0;
      let content = one + pad * 2;
      for (let r = 0; r < g.nR; r += step) {
        const t = g.text[r][c];
        if (!t) continue;
        for (const ln of t.split('\n')) content = Math.max(content, textW(font, false, ln) + pad * 2);
      }
      nat.push(Math.max(one, declared > 0 ? Math.min(declared, availW * 0.6) : Math.min(content, availW * 0.5)));
    }
    return nat;
  };
  let font = baseFont;
  let nat = g.nC ? measure(font) : [];
  let total = nat.reduce((a, b) => a + b, 0);
  if (!g.nC) return [{ c0: 0, c1: 0, w: [], font }];
  if (total <= availW) return [{ c0: 0, c1: g.nC - 1, w: nat, font }];
  if (mode === 'clip') {
    const w: number[] = [];
    let acc = 0;
    for (const v of nat) {
      if (acc + v > availW) break;
      w.push(v);
      acc += v;
    }
    if (!w.length) w.push(availW);
    return [{ c0: 0, c1: w.length - 1, w, font }];
  }
  if (mode === 'shrink') {
    font = Math.max(baseFont * 0.6, baseFont * Math.min(1, (availW / total) * 1.2));
    nat = measure(font);
    const k = Math.min(1, availW / nat.reduce((a, b) => a + b, 0));
    return [{ c0: 0, c1: g.nC - 1, w: nat.map((v) => v * k), font }];
  }
  // split：按列切成多个横向分页块
  const blocks: Plan[] = [];
  let cur: number[] = [];
  let acc = 0;
  let c0 = 0;
  for (let c = 0; c < nat.length; c++) {
    if (acc + nat[c] > availW && cur.length) {
      blocks.push({ c0, c1: c - 1, w: cur, font });
      c0 = c;
      cur = [];
      acc = 0;
    }
    cur.push(nat[c]);
    acc += nat[c];
  }
  if (cur.length) blocks.push({ c0, c1: nat.length - 1, w: cur, font });
  return blocks.length ? blocks : [{ c0: 0, c1: nat.length - 1, w: nat, font }];
}

/** 行高（含跨行合并的均摊） */
function rowHeights(g: Grid, plan: Plan, rows: number[]): Map<number, number> {
  const pad = Math.max(3, plan.font * 0.22);
  const lh = plan.font * 1.4;
  const xs: number[] = [0];
  for (const w of plan.w) xs.push(xs[xs.length - 1] + w);
  const xOf = (c: number): number => xs[Math.max(0, Math.min(c - plan.c0, xs.length - 1))];
  const member = new Map<string, Merge>();
  for (const m of g.merges) {
    if (m.c1 < plan.c0 || m.c0 > plan.c1) continue;
    for (let r = m.r0; r <= m.r1; r++) for (let c = m.c0; c <= m.c1; c++) member.set(`${r},${c}`, m);
  }
  const widthOf = (r: number, c: number): number => {
    const m = member.get(`${r},${c}`);
    if (!m) return xOf(c + 1) - xOf(c);
    return xOf(Math.min(m.c1, plan.c1) + 1) - xOf(Math.max(m.c0, plan.c0));
  };
  const h = new Map<number, number>();
  const linesOf = new Map<number, number>();
  for (const r of rows) {
    let lines = 1;
    for (let c = plan.c0; c <= plan.c1; c++) {
      const t = g.text[r]?.[c];
      if (!t) continue;
      lines = Math.max(lines, wrap(plan.font, false, t, Math.max(12, widthOf(r, c) - pad * 2)).length);
    }
    linesOf.set(r, lines);
    h.set(r, Math.max(lines * lh + pad * 2, g.rowH[r] > 0 ? g.rowH[r] * S : 0));
  }
  for (const m of g.merges) {
    if (m.c1 < plan.c0 || m.c0 > plan.c1) continue;
    const t = g.text[m.r0]?.[m.c0];
    if (!t) continue;
    const inRows = rows.filter((r) => r >= m.r0 && r <= m.r1);
    if (inRows.length < 2) continue;
    const lines = wrap(plan.font, false, t, Math.max(12, widthOf(m.r0, m.c0) - pad * 2)).length;
    const want = (lines * lh + pad * 2) / inRows.length;
    for (const r of inRows) h.set(r, Math.max(h.get(r) || 0, want));
  }
  return h;
}

type Chunk = { rows: number[]; y0: number };

/** 按页面可用高度把行切成一页一页；换页时重复表头；startY 允许续排在当前页余量上 */
function chunkRows(rows: number[], h: Map<number, number>, page: { M: number; H: number }, header: number | null, startY: number): Chunk[] {
  const bottom = page.H - page.M;
  const single = bottom - page.M;
  const chunks: Chunk[] = [];
  let cur: number[] = [];
  let y = startY;
  let y0 = startY;
  for (const r of rows) {
    const rh = Math.min(h.get(r) || 0, single);
    if (cur.length && y + rh > bottom) {
      chunks.push({ rows: cur, y0 });
      cur = [];
      y0 = page.M;
      y = page.M;
      if (header !== null && header !== r) {
        cur.push(header);
        y += Math.min(h.get(header) || 0, single);
      }
    }
    cur.push(r);
    y += rh;
  }
  if (cur.length) chunks.push({ rows: cur, y0 });
  if (!chunks.length) chunks.push({ rows: [], y0: startY });
  return chunks;
}

/* ---------------- 单页绘制 ---------------- */

function drawSheet(p: Page, g: Grid, plan: Plan, rows: number[], h: Map<number, number>, y0: number, header: number | null): number {
  const pad = Math.max(3, plan.font * 0.22);
  const lh = plan.font * 1.4;
  const x0 = p.M;
  const xs: number[] = [0];
  for (const w of plan.w) xs.push(xs[xs.length - 1] + w);
  const offs: number[] = [0];
  for (const r of rows) offs.push(offs[offs.length - 1] + (h.get(r) || lh));
  const totalH = offs[offs.length - 1];
  const idx = new Map<number, number>();
  rows.forEach((r, i) => idx.set(r, i));
  const member = new Map<string, Merge>();
  for (const m of g.merges) {
    if (m.c1 < plan.c0 || m.c0 > plan.c1) continue;
    for (let r = m.r0; r <= m.r1; r++) for (let c = m.c0; c <= m.c1; c++) member.set(`${r},${c}`, m);
  }

  const boxOf = (r: number, c: number): { x: number; y: number; w: number; hgt: number } | null => {
    const m = member.get(`${r},${c}`);
    if (m && (m.r0 !== r || m.c0 !== c)) return null;
    const cc0 = Math.max(m ? m.c0 : c, plan.c0);
    const cc1 = Math.min(m ? m.c1 : c, plan.c1);
    let rr1 = m ? m.r1 : r;
    while (rr1 > r && !idx.has(rr1)) rr1--;
    const x = x0 + xs[cc0 - plan.c0];
    const w = x0 + xs[Math.min(cc1 - plan.c0 + 1, xs.length - 1)] - x;
    const y = y0 + offs[idx.get(r) ?? 0];
    const end = Math.min((idx.get(rr1) ?? idx.get(r) ?? 0) + 1, offs.length - 1);
    return { x, y, w, hgt: y0 + offs[end] - y };
  };

  if (header !== null && rows[0] === header) {
    p.rect(x0, y0, xs[xs.length - 1], offs[1], '#eef1f5');
  }
  for (const r of rows) {
    const isHead = header !== null && r === header;
    for (let c = plan.c0; c <= plan.c1; c++) {
      const t = g.text[r]?.[c];
      if (!t) continue;
      const box = boxOf(r, c);
      if (!box) continue;
      const lines = wrap(plan.font, isHead, t, Math.max(12, box.w - pad * 2));
      if (!lines.length) continue;
      let widest = 0;
      for (const ln of lines) widest = Math.max(widest, textW(plan.font, isHead, ln));
      const avail = Math.max(12, box.w - pad * 2);
      const size = widest > avail ? Math.max(plan.font * 0.7, (plan.font * avail) / widest) : plan.font;
      const blockH = lines.length * lh;
      let ty = box.y + Math.max(pad * 0.4, (box.hgt - blockH) / 2);
      const right = !!g.right[r]?.[c];
      for (const ln of lines) {
        p.text(ln, box.x + pad, ty, size, isHead, isHead ? '#12233d' : '#161616', right, box.w - pad * 2);
        ty += lh;
      }
    }
  }
  // 边框：逐格画，落在同一个合并区里的内部线跳过
  const lw = plan.font * 0.04;
  const last = rows.length - 1;
  for (let i = 0; i <= last; i++) {
    const r = rows[i];
    const y = y0 + offs[i];
    const yb = y + (h.get(r) || lh);
    for (let c = plan.c0; c <= plan.c1; c++) {
      const pos = c - plan.c0;
      const x = x0 + xs[pos];
      const w = xs[pos + 1] - xs[pos];
      const mine = member.get(`${r},${c}`);
      const above = i > 0 ? member.get(`${rows[i - 1]},${c}`) : undefined;
      const left = member.get(`${r},${c - 1}`);
      const edge = c === plan.c0 || i === 0 || i === rows.length - 1 || c === plan.c1;
      const color = edge ? '#98a2ad' : '#dadfe4';
      if (!(above && mine && above === mine)) p.line(x, y, x + w, y, color, lw);
      if (!(left && mine && left === mine)) p.line(x, y, x, yb, color, lw);
      if (c === plan.c1) p.line(x + w, y, x + w, yb, color, lw);
      if (i === last) p.line(x, yb, x + w, yb, color, lw);
    }
  }
  return totalH;
}

/* ---------------- 参数面板 ---------------- */

function Controls({ value, patch }: ControlsProps) {
  return (
    <Panel>
      <Row label="纸张">
        <Segmented
          value={value.paper}
          onChange={(v) => patch({ paper: v })}
          options={[
            { value: 'a4', label: 'A4' },
            { value: 'letter', label: '信纸' },
          ]}
        />
      </Row>
      <Row label="方向">
        <Segmented
          value={value.orient}
          onChange={(v) => patch({ orient: v })}
          options={[
            { value: 'auto', label: '自动' },
            { value: 'l', label: '横向' },
            { value: 'p', label: '纵向' },
          ]}
        />
      </Row>
      <Row label="表格超宽">
        <Segmented
          value={value.overflow}
          onChange={(v) => patch({ overflow: v })}
          options={[
            { value: 'shrink', label: '缩小字号' },
            { value: 'split', label: '横向分页' },
            { value: 'clip', label: '裁掉超宽列' },
          ]}
        />
      </Row>
      <Row label="工作表">
        <Segmented
          value={value.sheets}
          onChange={(v) => patch({ sheets: v })}
          options={[
            { value: 'all', label: '全部' },
            { value: 'first', label: '仅第一个' },
            { value: 'pick', label: '指定序号' },
          ]}
        />
      </Row>
      {value.sheets === 'pick' && (
        <Row label="序号" hint="从 1 开始">
          <Segmented
            value={value.sheetIndex}
            onChange={(v) => patch({ sheetIndex: v })}
            options={[1, 2, 3, 4, 5, 6].map((n) => ({ value: n, label: String(n) }))}
          />
        </Row>
      )}
      <Row label="其它">
        <div className="flex flex-col gap-2">
          <Toggle value={value.header} onChange={(v) => patch({ header: v })} label="首行当表头（加粗、跨页重复）" />
          <Toggle value={value.blank} onChange={(v) => patch({ blank: v })} label="包含空白行" />
          <Toggle value={value.newPage} onChange={(v) => patch({ newPage: v })} label="每个表另起一页" />
        </div>
      </Row>
      <Hint>不还原底纹、字体颜色、条件格式与图表；隐藏表跳过。</Hint>
    </Panel>
  );
}

/* ---------------- 主流程 ---------------- */

async function localRun(files: File[], o: any, ctx: JobCtx): Promise<Out[]> {
  const taken = new Set<string>();
  const outs: Out[] = [];
  const errs: string[] = [];
  const warns = new Set<string>();
  const raw: any = await import('exceljs' as unknown as string);
  const ExcelJS: any = raw.default ?? raw;
  const base = PAGE_SIZES[o.paper === 'letter' ? 'letter' : 'a4'];
  const tall: [number, number] = [Math.min(base[0], base[1]), Math.max(base[0], base[1])];
  const wide: [number, number] = [Math.max(base[0], base[1]), Math.min(base[0], base[1])];

  for (let k = 0; k < files.length; k++) {
    ctx.tick();
    ctx.progress({ done: k, total: files.length, label: files[k].name });
    try {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(await files[k].arrayBuffer());
      let sheets: any[] = (wb.worksheets || []).filter((w: any) => w && w.state !== 'hidden');
      if (!sheets.length) sheets = wb.worksheets || [];
      if (o.sheets === 'first') sheets = sheets.slice(0, 1);
      else if (o.sheets === 'pick') {
        const n = Math.max(1, Number(o.sheetIndex) || 1);
        sheets = sheets.slice(n - 1, n);
      }
      if (!sheets.length) {
        errs.push(`${files[k].name}（没有工作表）`);
        continue;
      }
      const doc = await newPdfDoc();
      let pages = 0;
      let cur: Page | null = null;
      let curY = 0;
      let geo: [number, number] = tall;
      const flush = async (label: string, done: number, total: number): Promise<void> => {
        if (!cur) return;
        const blob = await encode(cur.cv, 'image/jpeg', 0.9);
        const jpg = await doc.embedJpg(new Uint8Array(await blob.arrayBuffer()));
        const page = doc.addPage([geo[0], geo[1]]);
        page.drawImage(jpg, { x: 0, y: 0, width: geo[0], height: geo[1] });
        cur.cv.width = cur.cv.height = 0;
        cur = null;
        curY = 0;
        pages++;
        ctx.progress({ done, total, label: `${label} · 已画 ${pages} 页` });
        await ctx.breathe();
      };
      const baseFont = 10 * S;
      for (let si = 0; si < sheets.length; si++) {
        ctx.tick();
        const ws = sheets[si];
        const sheetName = String(ws.name || `表 ${si + 1}`);
        ctx.progress({ done: si, total: sheets.length, label: `${files[k].name} · ${sheetName}` });
        await ctx.breathe();
        const g = readGrid(ws);
        if (g.over) warns.add('超 4000 行/60 列部分已忽略');
        const rowsAll: number[] = [];
        for (let r = 0; r < g.nR; r++) {
          if (!o.blank && g.text[r].every((t) => !t)) continue;
          rowsAll.push(r);
        }
        if (!rowsAll.length || !g.nC) continue;
        const fl = (l: string) => flush(l, si + 1, sheets.length);
        // 方向：取横向分页块最少的；平手用纵向
        const cands: [number, number][] = o.orient === 'l' ? [wide] : o.orient === 'p' ? [tall] : [tall, wide];
        let best: { geo: [number, number]; plans: Plan[] } | null = null;
        for (const cg of cands) {
          const plans = planColumns(g, (cg[0] - MARGIN * 2) * S, baseFont, String(o.overflow));
          if (!best || plans.length < best.plans.length) best = { geo: cg, plans };
          if (best.plans.length <= 1) break;
        }
        if (!best) continue;
        const chosen = best;
        const MPX = Math.round(MARGIN * S);
        const sameSize = !!cur && cur.W === Math.round(chosen.geo[0] * S) && cur.H === Math.round(chosen.geo[1] * S);
        if (cur && (!sameSize || o.newPage)) await fl(sheetName);
        geo = chosen.geo;
        if (!cur) {
          cur = new Page(geo[0], geo[1]);
          curY = MPX;
        }
        const header = o.header ? rowsAll[0] : null;
        for (let pi = 0; pi < chosen.plans.length; pi++) {
          if (pi > 0) {
            await fl(sheetName);
            cur = new Page(geo[0], geo[1]);
            curY = MPX;
          }
          const plan = chosen.plans[pi];
          const rows = rowsAll.slice();
          if (header !== null && rows[0] !== header) rows.unshift(header);
          const h = rowHeights(g, plan, rows);
          const chunks = chunkRows(rows, h, { M: MPX, H: Math.round(geo[1] * S) }, header, curY);
          for (let ci = 0; ci < chunks.length; ci++) {
            ctx.tick();
            const ch = chunks[ci];
            if (!ch.rows.length) continue;
            if (!cur) cur = new Page(geo[0], geo[1]);
            const used = drawSheet(cur, g, plan, ch.rows, h, ch.y0, header);
            curY = ch.y0 + used + plan.font * 0.6;
            // 关掉「每个表另起一页」时，本表最后一页留着给下个表续排
            if (o.newPage || ci < chunks.length - 1 || pi < chosen.plans.length - 1) await fl(sheetName);
          }
        }
      }
      await flush('', 1, 1);
      if (!pages) {
        errs.push(`${files[k].name}（没有内容）`);
        continue;
      }
      const bytes = await doc.save({ useObjectStreams: true });
      let note = `${pages} 页 · ${sheets.length} 个表`;
      if (warns.size) note += ` · ${[...warns][0]}`;
      outs.push({ name: uniqueName(`${baseName(files[k].name)}.pdf`, taken), blob: pdfBlob(bytes), kind: 'pdf', note });
    } catch (e) {
      errs.push(`${files[k].name}（${e instanceof Error ? e.message : '解析失败'}）`);
    }
  }
  if (!outs.length) throw new Error(errs.length ? `转换失败：${errs.join('、')}` : '没有可转换的内容');
  if (errs.length) outs[outs.length - 1].note = `${outs[outs.length - 1].note} · ${errs.length} 个文件失败`;
  return outs;
}

const tool: ToolDef = {
  id: 'excel-to-pdf',
  name: 'Excel 转 PDF',
  desc: 'xlsx 工作表按网格画成 PDF',
  zone: 'convert',
  icon: '📊',
  accept: '.xlsx',
  multiple: true,
  inputHint: '可多选，每个文件单独出一个 PDF；不支持老式 .xls',
  defaults: {
    paper: 'a4',
    orient: 'auto',
    overflow: 'shrink',
    sheets: 'all',
    sheetIndex: 1,
    header: true,
    blank: false,
    newPage: true,
  },
  Controls,
  run,
  serverHint: '本地只按网格重画数值与边框，底纹/字体颜色/条件格式/图表不还原，要打印级效果请接服务器跑 LibreOffice。',
};

export default tool;

async function run(files: File[], o: any, ctx: JobCtx): Promise<Out[]> {
  const { runWithFallback } = await import('../../core/remote');
  return runWithFallback('xlsx>pdf', files, ctx, (fl, c) => localRun(fl, o, c));
}

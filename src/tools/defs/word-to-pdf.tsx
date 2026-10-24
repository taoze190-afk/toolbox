import { Panel, Row, Segmented, Toggle, Hint } from '../../ui/controls';
import type { ControlsProps, Out, ToolDef } from '../types';
import type { JobCtx } from '../../core/jobs';
import { newPdfDoc, PAGE_SIZES, pdfBlob } from '../../core/pdf';
import { encode, makeCanvas } from '../../core/images';
import { baseName, uniqueName } from '../../core/format';

/* ---------------- 内容块 ---------------- */

type Blk =
  | { k: 'h'; lv: number; text: string }
  | { k: 'p'; text: string }
  | { k: 'list'; ordered: boolean; items: { text: string; lv: number }[] }
  | { k: 'tbl'; rows: string[][] }
  | { k: 'img'; src: string };

const CJK = /[\u2E80-\u2EFF\u3000-\u303F\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/;

/** 中文按字断、英文按空格断 */
function tokenize(s: string): string[] {
  const toks: string[] = [];
  let cur = '';
  for (const ch of s) {
    if (CJK.test(ch)) {
      if (cur) toks.push(cur);
      cur = '';
      toks.push(ch);
    } else if (ch === ' ' || ch === '\t') {
      if (cur) toks.push(cur);
      cur = '';
      toks.push(' ');
    } else {
      cur += ch;
    }
  }
  if (cur) toks.push(cur);
  return toks;
}

/* ---------------- 分页排版器 ---------------- */

const PX = 2.5; // 每 pt 的像素数（约 180dpi）
const FONT = '"Noto Sans SC","Noto Sans CJK SC","PingFang SC","Microsoft YaHei",system-ui,sans-serif';

class Pager {
  readonly pages: HTMLCanvasElement[] = [];
  readonly W: number;
  readonly H: number;
  readonly M: number;
  readonly body: number;
  private cv!: HTMLCanvasElement;
  private g!: CanvasRenderingContext2D;
  private y = 0;

  constructor(pageW: number, pageH: number, margin: number, bodyPt: number) {
    this.W = Math.round(pageW * PX);
    this.H = Math.round(pageH * PX);
    this.M = Math.round(margin * PX);
    this.body = bodyPt * PX;
    this.open();
  }

  /** 版心宽度 */
  get cw(): number {
    return this.W - this.M * 2;
  }

  private open(): void {
    this.cv = makeCanvas(this.W, this.H);
    this.g = this.cv.getContext('2d', { alpha: false })!;
    this.g.fillStyle = '#ffffff';
    this.g.fillRect(0, 0, this.W, this.H);
    this.g.textBaseline = 'top';
    this.pages.push(this.cv);
    this.y = this.M;
  }

  top(): number {
    return this.y;
  }

  moveTo(y: number): void {
    this.y = y;
  }

  space(h: number): void {
    this.y += h;
  }

  fits(h: number): boolean {
    return this.y + h <= this.H - this.M + 0.5;
  }

  /** 放不下就换页 */
  need(h: number): void {
    if (this.y > this.M + 1 && !this.fits(h)) this.open();
  }

  forceBreak(): void {
    if (this.y > this.M + 2) this.open();
  }

  font(size: number, bold = false, italic = false): void {
    this.g.font = `${italic ? 'italic ' : ''}${bold ? 'bold ' : ''}${Math.max(6, Math.round(size))}px ${FONT}`;
  }

  measure(size: number, bold: boolean, text: string): number {
    this.font(size, bold);
    return this.g.measureText(text).width;
  }

  /** 排成若干行，行宽不超过 maxW；text 里的 \n 强制换行 */
  wrap(size: number, bold: boolean, text: string, maxW: number): string[] {
    this.font(size, bold);
    const out: string[] = [];
    for (const raw of text.split('\n')) {
      const para = raw.replace(/\s+$/, '');
      if (!para.trim()) {
        out.push('');
        continue;
      }
      let line = '';
      let lw = 0;
      for (const t of tokenize(para)) {
        const tw = this.g.measureText(t).width;
        if (!line) {
          if (t === ' ') continue;
          if (tw > maxW) {
            // 超长英文单词硬切
            let rest = t;
            while (this.g.measureText(rest).width > maxW) {
              let cut = rest.length;
              while (cut > 1 && this.g.measureText(rest.slice(0, cut)).width > maxW) cut--;
              out.push(rest.slice(0, cut));
              rest = rest.slice(cut);
            }
            line = rest;
            lw = this.g.measureText(rest).width;
            continue;
          }
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
    return out.length ? out : [''];
  }

  /** 画一行（不动光标） */
  at(size: number, text: string, x: number, y: number, bold = false, italic = false, color = '#111111'): void {
    this.font(size, bold, italic);
    this.g.fillStyle = color;
    this.g.fillText(text, x, y);
  }

  /** 逐行绘制并推进光标 */
  lines(size: number, text: string[], x: number, bold = false, italic = false, color = '#111111'): number {
    const lh = size * 1.6;
    for (const ln of text) {
      this.font(size, bold, italic);
      const w = this.g.measureText(ln).width;
      const maxW = this.W - this.M - x;
      if (w > maxW && maxW > 10) {
        const s = Math.max(size * 0.7, (size * maxW) / w);
        this.font(s, bold, italic);
      }
      this.g.fillStyle = color;
      this.g.fillText(ln, x, this.y);
      this.y += lh;
    }
    return lh;
  }

  fill(x: number, y: number, w: number, h: number, color: string): void {
    this.g.fillStyle = color;
    this.g.fillRect(x, y, w, h);
  }

  hline(x1: number, x2: number, y: number, color = '#b9b9b9'): void {
    this.g.strokeStyle = color;
    this.g.lineWidth = Math.max(1, PX * 0.5);
    this.g.beginPath();
    this.g.moveTo(Math.round(x1) + 0.5, Math.round(y) + 0.5);
    this.g.lineTo(Math.round(x2) + 0.5, Math.round(y) + 0.5);
    this.g.stroke();
  }

  vline(x: number, y1: number, y2: number, color = '#b9b9b9'): void {
    this.g.strokeStyle = color;
    this.g.lineWidth = Math.max(1, PX * 0.5);
    this.g.beginPath();
    this.g.moveTo(Math.round(x) + 0.5, Math.round(y1) + 0.5);
    this.g.lineTo(Math.round(x) + 0.5, Math.round(y2) + 0.5);
    this.g.stroke();
  }

  image(img: CanvasImageSource, w: number, h: number): void {
    this.g.drawImage(img, this.M + (this.cw - w) / 2, this.y, w, h);
    this.y += h;
  }
}

/* ---------------- HTML -> 内容块 ---------------- */

function collapse(s: string): string {
  return s
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .trim();
}

type Inline = { text: string; imgs: string[] };

/** 收集行内文字：<br> 转 \n，<img> 的 dataURL 收进 imgs */
function inline(node: Node, out: Inline): void {
  node.childNodes.forEach((ch) => {
    if (ch.nodeType === 3) {
      out.text += (ch.textContent || '').replace(/\s+/g, ' ');
      return;
    }
    if (ch.nodeType !== 1) return;
    const el = ch as Element;
    const tag = el.tagName.toLowerCase();
    if (tag === 'br') {
      out.text += '\n';
      return;
    }
    if (tag === 'img') {
      const src = el.getAttribute('src') || '';
      if (src.startsWith('data:')) out.imgs.push(src);
      else out.text += '[图片]';
      return;
    }
    if (tag === 'script' || tag === 'style') return;
    inline(el, out);
  });
}

function pushBlk(b: Blk[], o: Inline): void {
  const t = collapse(o.text);
  if (t) b.push({ k: 'p', text: t });
  for (const src of o.imgs) b.push({ k: 'img', src });
  o.text = '';
  o.imgs.length = 0;
}

function listInto(b: Blk[], ul: Element, ordered: boolean, lv: number, items: { text: string; lv: number }[]): void {
  Array.from(ul.children).forEach((li) => {
    if (li.tagName.toLowerCase() !== 'li') return;
    const sub: Element[] = [];
    const box = document.createElement('div');
    Array.from(li.childNodes).forEach((n) => {
      const tag = (n as Element).tagName?.toLowerCase();
      if (tag === 'ul' || tag === 'ol') sub.push(n as Element);
      else box.appendChild(n.cloneNode(true));
    });
    const o: Inline = { text: '', imgs: [] };
    inline(box, o);
    const t = collapse(o.text);
    if (t) items.push({ text: t, lv });
    for (const src of o.imgs) b.push({ k: 'img', src });
    sub.forEach((s) => listInto(b, s, s.tagName.toLowerCase() === 'ol', lv + 1, items));
  });
}

function tableRows(tbl: Element): string[][] {
  const rows: string[][] = [];
  Array.from(tbl.querySelectorAll('tr')).forEach((tr) => {
    const cells: string[] = [];
    Array.from(tr.children).forEach((td) => {
      const tag = td.tagName.toLowerCase();
      if (tag !== 'td' && tag !== 'th') return;
      const ps = Array.from(td.querySelectorAll('p, h1, h2, h3, h4, h5, h6'));
      const parts: string[] = [];
      if (ps.length) {
        ps.forEach((p) => {
          const o: Inline = { text: '', imgs: [] };
          inline(p, o);
          const t = collapse(o.text);
          if (t) parts.push(t);
        });
      } else {
        const o: Inline = { text: '', imgs: [] };
        inline(td, o);
        const t = collapse(o.text);
        if (t) parts.push(t);
      }
      cells.push(parts.join('\n'));
    });
    if (cells.some((c) => c !== '')) rows.push(cells);
  });
  return rows;
}

function htmlToBlocks(html: string): Blk[] {
  const dom = new DOMParser().parseFromString(html, 'text/html');
  const blocks: Blk[] = [];
  const walk = (el: Element): void => {
    Array.from(el.children).forEach((n) => {
      const tag = n.tagName.toLowerCase();
      if (/^h[1-6]$/.test(tag)) {
        const o: Inline = { text: '', imgs: [] };
        inline(n, o);
        const t = collapse(o.text);
        if (t) blocks.push({ k: 'h', lv: Number(tag[1]), text: t });
        for (const src of o.imgs) blocks.push({ k: 'img', src });
        return;
      }
      if (tag === 'p' || tag === 'blockquote') {
        const o: Inline = { text: '', imgs: [] };
        inline(n, o);
        pushBlk(blocks, o);
        return;
      }
      if (tag === 'ul' || tag === 'ol') {
        const items: { text: string; lv: number }[] = [];
        listInto(blocks, n, tag === 'ol', 0, items);
        if (items.length) blocks.push({ k: 'list', ordered: tag === 'ol', items });
        return;
      }
      if (tag === 'table') {
        const rows = tableRows(n);
        if (rows.length) blocks.push({ k: 'tbl', rows });
        return;
      }
      if (tag === 'hr') {
        blocks.push({ k: 'p', text: '— — — — — — — — — —' });
        return;
      }
      if (tag === 'img') {
        const src = (n as HTMLImageElement).getAttribute('src') || '';
        if (src.startsWith('data:')) blocks.push({ k: 'img', src });
        return;
      }
      if (tag === 'pre') {
        const o: Inline = { text: '', imgs: [] };
        inline(n, o);
        if (o.text.trim()) blocks.push({ k: 'p', text: collapse(o.text) });
        return;
      }
      // div/section/figure 等容器继续下钻；纯行内内容当段落
      const container = n.children.length > 0 && !/^(a|span|strong|em|b|i|u|small|sub|sup|code|font)$/.test(tag);
      if (container) walk(n);
      else {
        const o: Inline = { text: '', imgs: [] };
        inline(n, o);
        pushBlk(blocks, o);
      }
    });
  };
  walk(dom.body);
  return blocks;
}

/* ---------------- 表格绘制 ---------------- */

function drawTable(p: Pager, rows: string[][]): void {
  const cols = rows.reduce((m, r) => Math.max(m, r.length), 0);
  if (!cols) return;
  // 列宽按各列最长内容比例分配；整体过宽时缩字号
  let size = p.body * 0.95;
  const widthsOf = (s: number): { w: number[]; total: number } => {
    const nat: number[] = [];
    for (let c = 0; c < cols; c++) {
      let w = p.measure(s, false, '国');
      for (const r of rows) {
        for (const ln of (r[c] || '').split('\n')) w = Math.max(w, p.measure(s, false, ln) + 2 * Math.max(3, s * 0.2));
      }
      nat.push(Math.max(p.measure(s, false, '国国国'), Math.min(w, p.cw * 0.6)));
    }
    const total = nat.reduce((a, b) => a + b, 0);
    return { w: nat.map((v) => (v / total) * p.cw), total };
  };
  let calc = widthsOf(size);
  if (calc.total > p.cw * 2.2) {
    size = Math.max(p.body * 0.78, size * 0.82);
    calc = widthsOf(size);
  }
  const widths = calc.w;
  const pad = Math.max(3, size * 0.2);
  const lh = size * 1.45;
  const x0 = p.M;
  const head = rows[0];

  const heightOf = (r: string[]): { lines: string[][]; h: number } => {
    const cellLines: string[][] = [];
    let h = lh;
    for (let c = 0; c < cols; c++) {
      const ls = p.wrap(size, false, r[c] || '', Math.max(14, widths[c] - pad * 2));
      cellLines.push(ls);
      h = Math.max(h, ls.length * lh);
    }
    return { lines: cellLines, h };
  };

  const renderRow = (r: string[], bold: boolean, fill?: string): void => {
    const { lines, h } = heightOf(r);
    const y = p.top();
    if (fill) p.fill(x0, y, p.cw, h, fill);
    for (let c = 0; c < cols; c++) {
      const x = x0 + widths.slice(0, c).reduce((a, b) => a + b, 0);
      const yy = y + (h - lines[c].length * lh) / 2;
      p.moveTo(yy);
      p.lines(size, lines[c], x + pad, bold);
    }
    p.moveTo(y + h);
    p.hline(x0, x0 + p.cw, y + h, bold ? '#8f8f8f' : '#c6c6c6');
    let vx = x0;
    for (let c = 0; c <= cols; c++) {
      p.vline(vx, y, y + h, c === 0 || c === cols ? '#8f8f8f' : '#d5d5d5');
      vx += widths[c] || 0;
    }
  };

  const headH = heightOf(head).h;
  renderRow(head, true, '#f1f1f1');
  for (let i = 1; i < rows.length; i++) {
    const h = Math.min(heightOf(rows[i]).h, p.H - p.M * 2);
    const before = p.pages.length;
    p.need(Math.max(h, headH));
    if (p.pages.length > before) renderRow(head, true, '#f1f1f1'); // 换页后重复表头
    renderRow(rows[i], false);
  }
  p.space(size * 0.2);
}

/* ---------------- 主流程 ---------------- */

async function loadImg(src: string): Promise<HTMLImageElement | null> {
  // 只认文档内嵌的 data: 图片。外链一律不加载，否则打开一份 docx 就会悄悄去访问别人的服务器
  if (!src.startsWith('data:')) return null;
  try {
    const img = new Image();
    img.src = src;
    await img.decode();
    return img.naturalWidth > 0 ? img : null;
  } catch {
    return null;
  }
}

async function run(files: File[], o: any, ctx: any): Promise<Out[]> {
  const { runWithFallback } = await import('../../core/remote');
  return runWithFallback('docx>pdf', files, ctx as JobCtx, (f, c) => localRun(f, o, c));
}

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
      <Row label="页边距">
        <Segmented
          value={value.margin}
          onChange={(v) => patch({ margin: v })}
          options={[
            { value: 'narrow', label: '窄' },
            { value: 'normal', label: '标准' },
            { value: 'wide', label: '宽' },
          ]}
        />
      </Row>
      <Row label="正文字号">
        <Segmented
          value={value.fontSize}
          onChange={(v) => patch({ fontSize: v })}
          options={[
            { value: 9, label: '9' },
            { value: 10.5, label: '10.5' },
            { value: 12, label: '12' },
          ]}
        />
      </Row>
      <Row label="图片">
        <Toggle value={value.skipImage} onChange={(v) => patch({ skipImage: v })} label="跳过图片（体积明显变小）" />
      </Row>
      <Hint>分栏、页眉页脚、目录域、脚注不参与转换。</Hint>
    </Panel>
  );
}

const MARGIN: Record<string, number> = { narrow: 36, normal: 72, wide: 100 };
const HSCALE = [1.7, 1.45, 1.28, 1.15, 1.05, 1];

async function localRun(files: File[], o: any, ctx: JobCtx): Promise<Out[]> {
  const taken = new Set<string>();
  const outs: Out[] = [];
  const errs: string[] = [];
  const [pw, ph] = PAGE_SIZES[o.paper === 'letter' ? 'letter' : 'a4'];
  const margin = MARGIN[String(o.margin)] ?? 72;

  for (let k = 0; k < files.length; k++) {
    ctx.tick();
    ctx.progress({ done: k, total: files.length, label: files[k].name });
    try {
      const mam: any = await import('mammoth/mammoth.browser' as unknown as string);
      const mammoth: any = mam.default ?? mam;
      const res = await mammoth.convertToHtml({ arrayBuffer: await files[k].arrayBuffer() });
      const blocks = htmlToBlocks(String(res?.value || ''));
      if (!blocks.length) {
        errs.push(`${files[k].name}（没读到正文）`);
        continue;
      }
      const p = new Pager(pw, ph, margin, Number(o.fontSize) || 10.5);
      for (let i = 0; i < blocks.length; i++) {
        ctx.tick();
        if (i % 10 === 0) {
          ctx.progress({ done: i, total: blocks.length, label: `${files[k].name} · 排版 ${i + 1}/${blocks.length}` });
          await ctx.breathe();
        }
        const b = blocks[i];
        if (b.k === 'h') {
          const size = p.body * HSCALE[Math.min(5, Math.max(0, b.lv - 1))];
          const lines = p.wrap(size, true, b.text, p.cw);
          p.need(lines.length * size * 1.6 + size);
          p.space(size * (b.lv <= 2 ? 0.45 : 0.25));
          p.lines(size, lines, p.M, true);
          p.space(size * 0.5);
        } else if (b.k === 'p') {
          const lines = p.wrap(p.body, false, b.text, p.cw);
          p.need(lines.length * p.body * 1.6);
          p.lines(p.body, lines, p.M);
          p.space(p.body * 0.6);
        } else if (b.k === 'list') {
          let idx = 0;
          for (const it of b.items) {
            const mark = b.ordered ? `${++idx}.` : '•';
            const indent = p.M + p.body * (1.1 + it.lv * 1.3);
            const lines = p.wrap(p.body, false, it.text, p.W - p.M - indent);
            p.need(lines.length * p.body * 1.6);
            const y = p.top();
            p.at(p.body * 0.95, mark, indent - p.body * 1.05, y, false, false, '#3a6ea5');
            p.moveTo(y);
            p.lines(p.body, lines, indent);
            p.space(p.body * 0.18);
          }
          p.space(p.body * 0.5);
        } else if (b.k === 'tbl') {
          p.space(p.body * 0.3);
          p.need(p.body * 3);
          drawTable(p, b.rows);
          p.space(p.body * 0.7);
        } else if (b.k === 'img') {
          if (o.skipImage) continue;
          const img = await loadImg(b.src);
          if (!img) continue;
          const iw = img.naturalWidth || 100;
          const ih = img.naturalHeight || 100;
          const maxW = p.cw;
          const maxH = (p.H - p.M * 2) * 0.75;
          const s = Math.min(maxW / iw, maxH / ih);
          const w = Math.max(24, Math.round(iw * s));
          const h = Math.max(24, Math.round(ih * s));
          p.need(h + p.body);
          p.image(img, w, h);
          p.space(p.body * 0.5);
        }
      }

      const doc = await newPdfDoc();
      for (let i = 0; i < p.pages.length; i++) {
        ctx.tick();
        ctx.progress({ done: i, total: p.pages.length, label: `${files[k].name} · 第 ${i + 1}/${p.pages.length} 页` });
        const cv = p.pages[i];
        const blob = await encode(cv, 'image/jpeg', 0.9);
        const jpg = await doc.embedJpg(new Uint8Array(await blob.arrayBuffer()));
        const page = doc.addPage([pw, ph]);
        page.drawImage(jpg, { x: 0, y: 0, width: pw, height: ph });
        cv.width = cv.height = 0;
        await ctx.breathe();
      }
      const bytes = await doc.save({ useObjectStreams: true });
      outs.push({
        name: uniqueName(`${baseName(files[k].name)}.pdf`, taken),
        blob: pdfBlob(bytes),
        kind: 'pdf',
        note: `${p.pages.length} 页`,
      });
    } catch (e) {
      errs.push(`${files[k].name}（${e instanceof Error ? e.message : '解析失败'}）`);
    }
  }
  if (!outs.length) throw new Error(errs.length ? `转换失败：${errs.join('、')}` : '没有可转换的内容');
  if (errs.length) outs[outs.length - 1].note = `${outs[outs.length - 1].note} · ${errs.length} 个文件失败`;
  return outs;
}

const tool: ToolDef = {
  id: 'word-to-pdf',
  name: 'Word 转 PDF',
  desc: 'docx 本地重新排版成 PDF',
  zone: 'convert',
  icon: '📄',
  accept: '.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  multiple: true,
  inputHint: '可多选，每个文件单独出一个 PDF；不支持老式 .doc',
  defaults: { paper: 'a4', margin: 'normal', fontSize: 10.5, skipImage: false },
  Controls,
  run,
  serverHint: '本地按近似规则重排版面，不保留原文样式与分页；要原样还原请接服务器跑 LibreOffice。',
};

export default tool;

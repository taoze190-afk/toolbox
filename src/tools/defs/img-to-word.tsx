import { Hint, Panel, Row, Segmented, Toggle } from '../../ui/controls';
import type { ControlsProps, Out, ToolDef } from '../types';
import type { JobCtx } from '../../core/jobs';
import { ocrImage, disposeOcr, type OcrLine, type OcrResult } from '../../core/ocr';
import { decode, flatten, ih, iw, resize } from '../../core/images';
import { baseName, uniqueName } from '../../core/format';

const CJK = /[\u3000-\u303f\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]/;
const HYPHEN = /[-‐‑‒–]+$/;
/** 放大后最长边上限，再大 WebView 内存吃紧 */
const MAX_SIDE = 3000;

type Box = { text: string; x0: number; x1: number; y0: number; y1: number; h: number };
type Para = { text: string; heading: boolean; pageBreak: boolean };
type Chunk = { name: string; paras: Para[]; conf: number; units: number };

function median(xs: number[]): number {
  const a = xs.filter((v) => Number.isFinite(v)).sort((p, q) => p - q);
  return a.length ? a[Math.floor(a.length / 2)] : 0;
}

function boxOf(l: OcrLine): Box {
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const w of l.words) {
    x0 = Math.min(x0, w.x);
    x1 = Math.max(x1, w.x + w.w);
    y0 = Math.min(y0, w.y);
    y1 = Math.max(y1, w.y + w.h);
  }
  if (!l.words.length) {
    x0 = 0;
    x1 = 0;
    y0 = l.y;
    y1 = l.y + l.h;
  }
  return { text: l.text.trim(), x0, x1, y0, y1, h: l.h || Math.max(1, y1 - y0) };
}

function joinText(a: string, b: string): string {
  if (HYPHEN.test(a) && /^[a-z]/.test(b)) return a.replace(HYPHEN, '') + b;
  const t1 = a.slice(-1);
  const t2 = b.charAt(0);
  return CJK.test(t1) || CJK.test(t2) ? a + b : `${a} ${b}`;
}

/**
 * OCR 行 → 段落。像素坐标，原点左上，y 越大越靠下。
 * 断开条件：上下留白 > 0.9 倍中位行高、行高差 > 45%、当前行左侧明显缩进、
 * 上一行右侧没写满（不到文本宽度的 72%）。
 */
function toParas(lines: OcrLine[], merge: boolean): Para[] {
  const boxes = lines.map(boxOf).filter((b) => b.text);
  const mh = median(boxes.map((b) => b.h)) || 20;
  const left = boxes.length ? Math.min(...boxes.map((b) => b.x0)) : 0;
  const right = boxes.length ? Math.max(...boxes.map((b) => b.x1)) : 1;
  const width = Math.max(1, right - left);
  const out: Para[] = [];
  let cur: Box | null = null;
  const flush = () => {
    if (cur) out.push({ text: cur.text, heading: false, pageBreak: false });
    cur = null;
  };
  for (const b of boxes) {
    if (
      cur &&
      merge &&
      b.y0 - cur.y1 <= 0.9 * mh &&
      b.y0 - cur.y1 >= -0.6 * mh &&
      Math.abs(b.h - cur.h) <= 0.45 * Math.max(b.h, cur.h) &&
      !(b.x0 - left > 1.2 * mh && cur.x0 - left <= 0.3 * mh) &&
      cur.x1 >= left + 0.72 * width
    ) {
      cur = { ...b, text: joinText(cur.text, b.text) }; // 几何量取最近一行，判断下一行才准
      continue;
    }
    flush();
    cur = b;
  }
  flush();
  return out;
}

async function readImage(file: File, o: any, ctx: JobCtx, tag: string) {
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
  try {
    return await ocrImage(work, o.langs, (p) =>
      ctx.progress({ done: p.done, total: p.total, label: `${tag}${p.label ?? '识别中'}` }),
    );
  } finally {
    work.width = work.height = 0;
  }
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
      <Row label="合并段内换行">
        <Toggle
          value={value.mergeWrap}
          onChange={(v) => patch({ mergeWrap: v })}
          label={value.mergeWrap ? '合并' : '一行一段'}
        />
      </Row>
      <Row label="多图输出">
        <Segmented
          value={value.output}
          onChange={(v) => patch({ output: v })}
          options={[
            { value: 'one', label: '合并成一个' },
            { value: 'each', label: '每张一个' },
          ]}
        />
      </Row>
      <Hint>表格、公式、手写体识别率有限，生成后请人工核对。</Hint>
    </Panel>
  );
}

async function emitDoc(chunks: Chunk[], outName: string, ctx: JobCtx, taken: Set<string>): Promise<Out> {
  const mod: any = await import('docx');
  const { Document, Packer, Paragraph, TextRun, HeadingLevel } = mod;
  ctx.progress({ done: 1, total: 1, label: `生成 Word · ${outName}` });
  const children: any[] = [];
  const sep = chunks.length > 1;
  chunks.forEach((c, i) => {
    if (sep) {
      children.push(
        new Paragraph({
          children: [new TextRun({ text: c.name })],
          heading: HeadingLevel.HEADING_2,
          pageBreakBefore: i > 0,
        }),
      );
    }
    for (const p of c.paras) {
      children.push(
        new Paragraph({
          children: [new TextRun({ text: p.text })],
          pageBreakBefore: sep ? false : p.pageBreak && i === 0,
          spacing: { after: 40, line: 276 },
        }),
      );
    }
  });
  const doc = new Document({
    styles: { default: { document: { run: { size: 22, font: { ascii: 'Times New Roman', eastAsia: '宋体' } } } } },
    sections: [{ properties: {}, children }],
  });
  const blob: Blob = await Packer.toBlob(doc);
  const units = chunks.reduce((s, c) => s + c.units, 0);
  const paras = chunks.reduce((s, c) => s + c.paras.length, 0);
  const conf = Math.round(chunks.reduce((s, c) => s + c.conf * c.units, 0) / Math.max(1, units));
  return {
    name: uniqueName(outName, taken),
    blob,
    kind: 'doc',
    note: `${units} 行 / ${paras} 段 · 置信度 ${conf}%${conf < 70 ? ' · 识别置信度低，建议提高清晰度或放大后重试' : ''}`,
  };
}

async function run(files: File[], o: any, ctx: JobCtx): Promise<Out[]> {
  const taken = new Set<string>();
  const outs: Out[] = [];
  const chunks: Chunk[] = [];
  const failed: string[] = [];

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
      const lines = res.lines.filter((l) => l.text.trim());
      if (!lines.length) {
        failed.push(files[i].name);
        continue;
      }
      const chunk: Chunk = {
        name: baseName(files[i].name),
        paras: toParas(lines, !!o.mergeWrap),
        conf: Math.round(res.conf),
        units: lines.length,
      };
      if (o.output === 'each') outs.push(await emitDoc([chunk], `${chunk.name}.docx`, ctx, taken));
      else chunks.push(chunk);
      await ctx.breathe();
    }

    if (o.output !== 'each' && chunks.length) {
      const name = chunks.length > 1 ? '图片文字.docx' : `${chunks[0].name}.docx`;
      outs.push(await emitDoc(chunks, name, ctx, taken));
    }

    if (!outs.length) {
      throw new Error(
        failed.length ? `都没识别出文字：${failed.slice(0, 2).join('、')}` : '没识别出文字，换张更清晰的图试试',
      );
    }
    if (failed.length) {
      const last = outs[outs.length - 1];
      last.note = `${last.note ?? ''} · ${failed.length} 张未识别`;
    }
    return outs;
  } finally {
    await disposeOcr();
  }
}

const tool: ToolDef = {
  id: 'img-to-word',
  name: '图片转 Word',
  desc: '离线 OCR 识别成文档',
  zone: 'convert',
  icon: '🔤',
  accept: 'image/*',
  multiple: true,
  inputHint: '语言包在本地，首次识别稍慢，之后很快',
  defaults: { langs: 'chi_sim+eng', scale: 2, mergeWrap: true, output: 'one' },
  Controls,
  run,
  serverHint: '识别成文字重排，版式与图片不保留，中文识别率有限。',
};

export default tool;

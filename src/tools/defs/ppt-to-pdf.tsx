import { Panel, Row, Segmented, Toggle, Hint } from '../../ui/controls';
import type { ControlsProps, Out, ToolDef } from '../types';
import type { JobCtx } from '../../core/jobs';
import { newPdfDoc, pdfBlob } from '../../core/pdf';
import { decode, encode, ih, iw, makeCanvas } from '../../core/images';
import { baseName, uniqueName } from '../../core/format';

/* ---------------- 本文件私有的画布排版器（中文按字断、英文按空格断） ---------------- */

const FONT = '"Noto Sans SC","Noto Sans CJK SC","PingFang SC","Microsoft YaHei",system-ui,sans-serif';
const CJK = /[\u2E80-\u2EFF\u3000-\u303F\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/;

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

function font(size: number, bold: boolean): string {
  return `${bold ? 'bold ' : ''}${Math.max(6, Math.round(size))}px ${FONT}`;
}

function wrap(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    const para = raw.replace(/[ \t]+/g, ' ').trim();
    if (!para) continue;
    let line = '';
    let lw = 0;
    for (const t of tokenize(para)) {
      const tw = ctx.measureText(t).width;
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

/* ---------------- pptx 解析（正则抽 XML，不引第三方解析库） ---------------- */

type Shape = { title: boolean; size: number; paras: string[] };

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function unesc(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|\w+);/g, (whole, k: string) => {
    if (NAMED[k] !== undefined) return NAMED[k];
    if (k[0] === '#') {
      const code = k[1] === 'x' || k[1] === 'X' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return whole;
  });
}

/** 一个 <a:p> 里所有 <a:t> 拼成一行（忽略 a:br 的软换行） */
function paraText(chunk: string): string {
  let s = '';
  const re = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(chunk))) s += unesc(m[1]);
  return s.replace(/\s+/g, ' ').trim();
}

function shapes(xml: string): Shape[] {
  const out: Shape[] = [];
  const re = /<p:sp>([\s\S]*?)<\/p:sp>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const body = m[1];
    const isTitle = /<p:ph\b[^>]*type="(title|ctrTitle)"/.test(body);
    const sz = /<a:rPr\b[^>]*\ssz="(\d{2,5})"/.exec(body);
    const paras: string[] = [];
    const pre = /<a:p(?:\s[^>]*)?>([\s\S]*?)<\/a:p>/g;
    let p: RegExpExecArray | null;
    while ((p = pre.exec(body))) {
      const t = paraText(p[1]);
      if (t) paras.push(t);
    }
    if (!paras.length) {
      const t = paraText(body);
      if (t) paras.push(t);
    }
    if (paras.length) out.push({ title: isTitle, size: sz ? Number(sz[1]) / 100 : 0, paras });
  }
  // 表格：整行拉平成 "a | b | c"，样式不还原
  const tre = /<a:tr(?:\s[^>]*)?>([\s\S]*?)<\/a:tr>/g;
  let tr: RegExpExecArray | null;
  while ((tr = tre.exec(xml))) {
    const cells: string[] = [];
    const cre = /<a:tc(?:\s[^>]*)?>([\s\S]*?)<\/a:tc>/g;
    let c: RegExpExecArray | null;
    while ((c = cre.exec(tr[1]))) cells.push(paraText(c[1]));
    const line = cells.filter(Boolean).join('  |  ');
    if (line) out.push({ title: false, size: 0, paras: [line] });
  }
  return out;
}

function relMap(xml: string, wantImageOnly: boolean): Map<string, string> {
  const map = new Map<string, string>();
  const re = /<Relationship\b[^>]*\/>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    if (wantImageOnly && !/image/i.test(m[0])) continue;
    const id = /\bId="([^"]+)"/.exec(m[0])?.[1];
    const tg = /\bTarget="([^"]+)"/.exec(m[0])?.[1];
    if (id && tg) map.set(id, tg);
  }
  return map;
}

function blipTargets(xml: string, rels: Map<string, string>): string[] {
  const out: string[] = [];
  const re = /<a:blip\b[^>]*r:embed="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const t = rels.get(m[1]);
    if (t) out.push(t);
  }
  return out;
}

/** "../media/image1.png" -> "ppt/media/image1.png" */
function resolveTarget(target: string, baseDir: string): string {
  const segs = (baseDir + '/' + target.replace(/^\/+/, '')).split('/');
  const stack: string[] = [];
  for (const s of segs) {
    if (!s || s === '.') continue;
    if (s === '..') stack.pop();
    else stack.push(s);
  }
  return stack.join('/');
}

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  webp: 'image/webp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
};

/* ---------------- 画一页 ---------------- */

type Img = { bmp: ImageBitmap };

function drawSlide(
  head: string[],
  body: string[],
  imgs: Img[],
  W: number,
  H: number,
  pageNo: string,
): { cv: HTMLCanvasElement; dropped: number } {
  const cv = makeCanvas(W, H);
  const g = cv.getContext('2d', { alpha: false })!;
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, W, H);
  g.textBaseline = 'top';
  const pad = W * 0.055;
  const maxW = W - pad * 2;
  let y = pad;
  let dropped = 0;

  // 标题
  if (head.length) {
    let size = H * 0.105;
    let lines = [head.join(' ')];
    for (let i = 0; i < 4; i++) {
      g.font = font(size, true);
      lines = wrap(g, head.join(' '), maxW * 0.96);
      if (lines.length <= 2 || size < H * 0.06) break;
      size *= 0.86;
    }
    g.fillStyle = '#12233d';
    for (const ln of lines) {
      g.font = font(size, true);
      g.fillText(ln, pad, y);
      y += size * 1.28;
    }
    y += size * 0.16;
    g.strokeStyle = '#dbe1e8';
    g.lineWidth = Math.max(1, H * 0.004);
    g.beginPath();
    g.moveTo(pad, Math.round(y) + 0.5);
    g.lineTo(W - pad, Math.round(y) + 0.5);
    g.stroke();
    y += H * 0.035;
  }

  // 正文：放不下就整体缩字号
  const bodyRoom = () => Math.max(H * 0.1, H - pad - y - (pageNo ? H * 0.05 : 0) - (imgs.length ? H * 0.26 : 0));
  let size = H * 0.05;
  const layout = (s: number): { list: string[][]; h: number } => {
    g.font = font(s, false);
    const list = body.map((t) => wrap(g, t, maxW - s * 1.15));
    let h = 0;
    for (const ls of list) h += ls.length * s * 1.32 + s * 0.72;
    return { list, h };
  };
  let laid = { list: [] as string[][], h: 0 };
  for (let i = 0; i < 6; i++) {
    laid = layout(size);
    if (laid.h <= bodyRoom() || size < H * 0.026) break;
    size *= 0.88;
  }
  g.fillStyle = '#1d1d1f';
  for (const ls of laid.list) {
    g.font = font(size, false);
    g.fillStyle = '#2f6fb5';
    g.fillText('▪', pad + size * 0.12, y + size * 0.06);
    g.fillStyle = '#1d1d1f';
    for (const ln of ls) {
      g.fillText(ln, pad + size * 1.15, y);
      y += size * 1.32;
    }
    y += size * 0.72;
  }

  // 配图：文字下方的剩余区域里等分堆叠
  if (imgs.length) {
    const top = Math.min(y + size * 0.2, H - pad);
    const free = H - pad - top;
    if (free < H * 0.07) {
      dropped = imgs.length;
    } else {
      const share = free / imgs.length;
      let iy = top;
      for (const { bmp } of imgs) {
        const w0 = iw(bmp);
        const h0 = ih(bmp);
        if (!w0 || !h0) {
          dropped++;
          continue;
        }
        const s = Math.min(maxW / w0, share / h0);
        const w = Math.max(8, Math.round(w0 * s));
        const h = Math.max(8, Math.round(h0 * s));
        if (iy + h > H - pad) {
          dropped++;
          continue;
        }
        g.drawImage(bmp, pad, iy, w, h);
        iy += h + H * 0.012;
      }
    }
  }

  if (pageNo) {
    g.font = font(H * 0.03, false);
    g.fillStyle = '#8b93a0';
    const w = g.measureText(pageNo).width;
    g.fillText(pageNo, W - pad - w, H - pad - H * 0.03);
  }
  return { cv, dropped };
}

/* ---------------- 主流程 ---------------- */

async function run(files: File[], o: any, ctx: any): Promise<Out[]> {
  const { runWithFallback } = await import('../../core/remote');
  return runWithFallback('pptx>pdf', files, ctx as JobCtx, (f, c) => localRun(f, o, c));
}

function Controls({ value, patch }: ControlsProps) {
  return (
    <Panel>
      <Row label="清晰度" hint="越大越清晰、体积越大">
        <Segmented
          value={value.width}
          onChange={(v) => patch({ width: v })}
          options={[
            { value: 1280, label: '1280px' },
            { value: 1600, label: '1600px' },
            { value: 1920, label: '1920px' },
          ]}
        />
      </Row>
      <Row label="内容">
        <div className="flex flex-col gap-2">
          <Toggle value={value.image} onChange={(v) => patch({ image: v })} label="包含配图" />
          <Toggle value={value.pageNo} onChange={(v) => patch({ pageNo: v })} label="页脚标注页码" />
        </div>
      </Row>
      <Hint>降级转换：只取文字与配图，原位置/配色不还原。</Hint>
    </Panel>
  );
}

async function localRun(files: File[], o: any, ctx: JobCtx): Promise<Out[]> {
  const taken = new Set<string>();
  const outs: Out[] = [];
  const errs: string[] = [];
  const zipMod: any = await import('jszip' as unknown as string);
  const JSZip: any = zipMod.default ?? zipMod;
  const EMU = 914400;

  for (let k = 0; k < files.length; k++) {
    ctx.tick();
    ctx.progress({ done: k, total: files.length, label: files[k].name });
    try {
      const zip = await JSZip.loadAsync(await files[k].arrayBuffer());
      const presFile = zip.file('ppt/presentation.xml');
      if (!presFile) throw new Error('不是有效的 pptx（缺 presentation.xml）');
      const pres: string = await presFile.async('string');
      const szTag = /<p:sldSz\b[^>]*>/.exec(pres);
      const cxm = szTag ? /\bcx="(\d+)"/.exec(szTag[0]) : null;
      const cym = szTag ? /\bcy="(\d+)"/.exec(szTag[0]) : null;
      let cx = cxm ? Number(cxm[1]) : 0;
      let cy = cym ? Number(cym[1]) : 0;
      if (!(cx > 0 && cy > 0)) {
        cx = 12192000;
        cy = 6858000; // 16:9
      }
      const pageW = (cx / EMU) * 72;
      const pageH = (cy / EMU) * 72;

      // 页序：优先按 sldIdLst + presentation.xml.rels，拿不到再按文件名数字排
      const relsRaw: string = (await zip.file('ppt/_rels/presentation.xml.rels')?.async('string')) || '';
      const ridToTarget = relMap(relsRaw, false);
      const found: string[] = [];
      zip.forEach((path: string) => {
        const m = /^ppt\/slides\/(slide\d+)\.xml$/.exec(path);
        if (m) found.push(`${m[1]}.xml`);
      });
      const ordered: string[] = [];
      const lst = /<p:sldIdLst>([\s\S]*?)<\/p:sldIdLst>/.exec(pres);
      if (lst) {
        const re = /<p:sldId\b[^>]*\/?>/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(lst[1]))) {
          const rid = /\br:id="([^"]+)"/.exec(m[0])?.[1];
          const tg = rid ? ridToTarget.get(rid) : undefined;
          const name = tg ? /slides\/([^/]+\.xml)/i.exec(tg)?.[1] : undefined;
          if (name && found.includes(name) && !ordered.includes(name)) ordered.push(name);
        }
      }
      let order = ordered;
      if (!order.length) {
        order = found.slice().sort((a, b) => (Number(/\d+/.exec(a)?.[0]) || 0) - (Number(/\d+/.exec(b)?.[0]) || 0));
      }
      for (const n of found) if (!order.includes(n)) order.push(n);
      if (!order.length) throw new Error('没有读到任何幻灯片');

      const doc = await newPdfDoc();
      const W = Math.min(2200, Math.max(900, Number(o.width) || 1600));
      const H = Math.round((W * cy) / cx);
      let drawn = 0;
      let bad = 0;
      let dropped = 0;
      for (let i = 0; i < order.length; i++) {
        ctx.tick();
        ctx.progress({ done: i, total: order.length, label: `${files[k].name} · 第 ${i + 1}/${order.length} 页` });
        try {
          const xml: string = await zip.file(`ppt/slides/${order[i]}`).async('string');
          const sps = shapes(xml);
          const head = sps.filter((s) => s.title).flatMap((s) => s.paras);
          const body = sps
            .filter((s) => !s.title)
            .sort((a, b) => b.size - a.size)
            .flatMap((s) => s.paras);
          let title = head;
          let lines = body;
          if (!title.length && body.length) {
            title = [body[0]];
            lines = body.slice(1);
          }
          const list: Img[] = [];
          if (o.image) {
            const sRel: string = (await zip.file(`ppt/slides/_rels/${order[i]}.rels`)?.async('string')) || '';
            for (const tg of blipTargets(xml, relMap(sRel, true)).slice(0, 4)) {
              if (/\.emf$|\.wmf$/i.test(tg)) continue; // WebView 解不了矢量图
              const path = resolveTarget(tg, 'ppt/slides');
              const f = zip.file(path);
              if (!f) continue;
              try {
                const bytes = await f.async('uint8array');
                const ext = (path.split('.').pop() || 'png').toLowerCase();
                const bmp = await decode(new Blob([bytes as unknown as ArrayBuffer], { type: MIME[ext] || 'image/png' }));
                if (bmp) list.push({ bmp });
              } catch {
                dropped++;
              }
            }
          }
          const r = drawSlide(title, lines, list, W, H, o.pageNo ? `${i + 1} / ${order.length}` : '');
          dropped += r.dropped;
          for (const x of list) {
            try {
              x.bmp.close();
            } catch {
              /* 已释放 */
            }
          }
          const blob = await encode(r.cv, 'image/jpeg', 0.88);
          const jpg = await doc.embedJpg(new Uint8Array(await blob.arrayBuffer()));
          const page = doc.addPage([pageW, pageH]);
          page.drawImage(jpg, { x: 0, y: 0, width: pageW, height: pageH });
          r.cv.width = r.cv.height = 0;
          drawn++;
        } catch {
          bad++;
        }
        await ctx.breathe();
      }
      if (!drawn) {
        errs.push(`${files[k].name}（${order.length} 页全部解析失败）`);
        continue;
      }
      const bytes = await doc.save({ useObjectStreams: true });
      let note = bad ? `${drawn} 页 · ${order.length} 页中有 ${bad} 页未能解析` : `${drawn} 页`;
      if (dropped) note += ` · ${dropped} 张图未纳入`;
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
  id: 'ppt-to-pdf',
  name: 'PPT 转 PDF',
  desc: 'pptx 抽文字与配图成 PDF',
  zone: 'convert',
  icon: '📽️',
  accept: '.pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation',
  multiple: true,
  inputHint: '可多选，每个文件单独出一个 PDF；不支持老式 .ppt',
  defaults: { width: 1600, image: true, pageNo: false },
  Controls,
  run,
  serverHint: '明显降级：只保留文字与配图，母版/动画/SmartArt/图表不还原，要原样效果请接服务器跑 LibreOffice。',
};

export default tool;

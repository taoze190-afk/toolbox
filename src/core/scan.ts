import type { PdfDoc, TextBlock } from './pdf';
import { pageText, renderPage } from './pdf';
import { ocrImage, stripGridLines } from './ocr';
import type { JobCtx } from './jobs';

/** 少于这么多个字符就认为这一页没有可用文字层 */
export const MIN_TEXT_CHARS = 20;

/**
 * 取一页的文字块。有文字层直接用；没有（扫描件）就把这页渲染成图做 OCR。
 * 两条路返回的是同一种结构（PDF 坐标、原点在左下、y 向上、单位 pt），
 * 所以下游的分行/分列算法不需要知道文字是从哪来的。
 */
export async function pageBlocks(
  doc: PdfDoc,
  pageNo: number,
  opts: { ocr: boolean; langs: string; dpi: number; stripGrid?: boolean },
  ctx: JobCtx,
): Promise<{ blocks: TextBlock[]; viaOcr: boolean }> {
  const blocks = await pageText(doc, pageNo);
  const chars = blocks.reduce((a, b) => a + b.str.replace(/\s/g, '').length, 0);
  if (chars >= MIN_TEXT_CHARS || !opts.ocr) return { blocks, viaOcr: false };

  const { canvas, wPt, hPt } = await renderPage(doc, pageNo, opts.dpi);
  try {
    // 扫描件里的表格线会被识别成一串 "[" "|"，先把格线擦掉再认
    if (opts.stripGrid) stripGridLines(canvas);
    const r = await ocrImage(canvas, opts.langs, (p) =>
      ctx.progress({ done: p.done, total: p.total, label: `第 ${pageNo} 页 OCR ${p.label ?? ''}` }),
    );
    // 像素是按 canvas 算的，页宽可能因为单边上限被缩过，所以用实测比例而不是 dpi/72
    const k = canvas.width > 0 ? wPt / canvas.width : 72 / opts.dpi;
    const out: TextBlock[] = [];
    for (const line of r.lines) {
      for (const w of line.words) {
        const str = w.text.trim();
        if (!str) continue;
        out.push({
          str,
          x: w.x * k,
          y: hPt - (w.y + w.h) * k,
          w: w.w * k,
          h: w.h * k,
          fontHeight: w.h * k * 0.7,
        });
      }
    }
    return { blocks: out, viaOcr: out.length > 0 };
  } finally {
    canvas.width = canvas.height = 0;
  }
}

import { asset } from './assets';
import { makeCanvas } from './images';

export type PdfDoc = {
  numPages: number;
  /** 1-based */
  page: (n: number) => Promise<any>;
  proxy: any;
  destroy: () => Promise<void>;
};

let libPromise: Promise<any> | null = null;

async function pdfjs() {
  if (!libPromise) {
    libPromise = import('pdfjs-dist').then((m) => {
      const lib: any = (m as any).default ?? m;
      lib.GlobalWorkerOptions.workerSrc = asset('pdfjs/pdf.worker.min.mjs');
      return lib;
    });
  }
  return libPromise;
}

export async function openPdf(file: Blob): Promise<PdfDoc> {
  const lib = await pdfjs();
  const buf = await file.arrayBuffer();
  const task = lib.getDocument({
    data: new Uint8Array(buf),
    cMapUrl: asset('pdfjs/cmaps/'),
    cMapPacked: true,
    standardFontDataUrl: asset('pdfjs/standard_fonts/'),
    isEvalSupported: false,
    useSystemFonts: true,
  });
  const proxy = await task.promise;
  return {
    numPages: proxy.numPages,
    page: (n: number) => proxy.getPage(n),
    proxy,
    destroy: async () => {
      try {
        await proxy.destroy();
      } catch {
        /* 已销毁 */
      }
    },
  };
}

/** 把一页渲染成画布。dpi 决定清晰度，maxSide 限制单边像素防止内存爆掉。 */
export async function renderPage(
  doc: PdfDoc,
  n: number,
  dpi = 150,
  maxSide = 4096,
): Promise<{ canvas: HTMLCanvasElement; wPt: number; hPt: number }> {
  const page = await doc.page(n);
  const base = page.getViewport({ scale: 1 });
  let scale = dpi / 72;
  const longest = Math.max(base.width, base.height);
  if (longest * scale > maxSide) scale = maxSide / longest;
  const viewport = page.getViewport({ scale });
  const canvas = makeCanvas(viewport.width, viewport.height);
  const ctx = canvas.getContext('2d', { alpha: false })!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, canvasContext: ctx, viewport }).promise;
  page.cleanup();
  return { canvas, wPt: base.width, hPt: base.height };
}

export type TextBlock = {
  str: string;
  x: number;
  y: number;
  w: number;
  h: number;
  fontHeight: number;
};

/** 带坐标的文字抽取，版式还原类转换都靠它 */
export async function pageText(doc: PdfDoc, n: number): Promise<TextBlock[]> {
  const page = await doc.page(n);
  const tc = await page.getTextContent();
  const out: TextBlock[] = [];
  for (const it of tc.items as any[]) {
    if (typeof it.str !== 'string' || !it.str.trim()) continue;
    const [a, b, c, d, e, f] = it.transform;
    const h = Math.hypot(c, d) || Math.abs(a);
    out.push({
      str: it.str,
      x: e,
      y: f,
      w: it.width ?? 0,
      h: it.height ?? h,
      fontHeight: Math.abs(b) || h,
    });
  }
  page.cleanup();
  return out;
}

let librePromise: Promise<any> | null = null;

export async function pdfLib() {
  if (!librePromise) librePromise = import('pdf-lib');
  return librePromise;
}

export async function newPdfDoc() {
  const { PDFDocument } = await pdfLib();
  return await PDFDocument.create();
}

export async function openPdfLib(bytes: ArrayBuffer | Uint8Array) {
  const { PDFDocument } = await pdfLib();
  return await PDFDocument.load(bytes.slice(0), { ignoreEncryption: true, updateMetadata: false });
}

export function pdfBlob(bytes: Uint8Array | ArrayBuffer): Blob {
  return new Blob([bytes as ArrayBuffer], { type: 'application/pdf' });
}

/** 从 PDF 里读出已有图片（用于"原样保文字、只重压图片"的模式） */
export async function pdfHasTextLayer(file: Blob): Promise<boolean> {
  try {
    const doc = await openPdf(file);
    let chars = 0;
    const n = Math.min(doc.numPages, 3);
    for (let i = 1; i <= n; i++) {
      for (const b of await pageText(doc, i)) chars += b.str.replace(/\s/g, '').length;
    }
    await doc.destroy();
    return chars > 20;
  } catch {
    return false;
  }
}

function sniff(bytes: Uint8Array): 'jpg' | 'png' | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  return null;
}

/**
 * 把一张图放进 PDF 的一页。jpg/png 原样嵌入（不二次压缩），其它格式先转 JPEG。
 * 返回页尺寸（pt）与图片像素尺寸。
 */
export async function embedImageAsPage(
  doc: any,
  blob: Blob,
  opts: { pageW?: number; pageH?: number; margin?: number; quality?: number } = {},
): Promise<{ page: any; imgW: number; imgH: number }> {
  const { decode, encode, iw, ih } = await import('./images');
  let bytes = new Uint8Array(await blob.arrayBuffer());
  let kind = sniff(bytes);
  let pxW = 0;
  let pxH = 0;
  if (!kind) {
    const img = await decode(blob);
    pxW = iw(img);
    pxH = ih(img);
    const cv = document.createElement('canvas');
    cv.width = pxW;
    cv.height = pxH;
    cv.getContext('2d')!.drawImage(img as CanvasImageSource, 0, 0);
    bytes = new Uint8Array(await (await encode(cv, 'image/jpeg', opts.quality ?? 0.92)).arrayBuffer());
    cv.width = cv.height = 0;
    if ('close' in img) img.close();
    kind = 'jpg';
  }
  if (!pxW) {
    const probe = kind === 'png' ? await pngSize(bytes) : await jpegSize(bytes);
    pxW = probe?.[0] ?? 1200;
    pxH = probe?.[1] ?? 1600;
  }
  const sd = kind === 'png' ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
  const margin = opts.margin ?? 0;
  let pageW = opts.pageW ?? pxW * 0.75 + margin * 2;
  let pageH = opts.pageH ?? pxH * 0.75 + margin * 2;
  if (opts.pageW && opts.pageH) {
    const availW = opts.pageW - margin * 2;
    const availH = opts.pageH - margin * 2;
    const s = Math.min(availW / pxW, availH / pxH);
    pageW = opts.pageW;
    pageH = opts.pageH;
    const page = doc.addPage([pageW, pageH]);
    page.drawImage(sd, {
      x: (pageW - pxW * s) / 2,
      y: (pageH - pxH * s) / 2,
      width: pxW * s,
      height: pxH * s,
    });
    return { page, imgW: pxW, imgH: pxH };
  }
  const page = doc.addPage([pageW, pageH]);
  page.drawImage(sd, { x: margin, y: margin, width: pageW - margin * 2, height: pageH - margin * 2 });
  return { page, imgW: pxW, imgH: pxH };
}

/** 不解码直接读文件头拿宽高，省掉一次大图解码 */
function jpegSize(b: Uint8Array): [number, number] | null {
  let i = 2;
  while (i < b.length) {
    if (b[i] !== 0xff) {
      i++;
      continue;
    }
    const m = b[i + 1];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return [(b[i + 7] << 8) | b[i + 6], (b[i + 5] << 8) | b[i + 4]] as [number, number];
    }
    const len = (b[i + 2] << 8) | b[i + 3];
    i += 2 + len;
  }
  return null;
}

function pngSize(b: Uint8Array): [number, number] | null {
  if (b.length < 24) return null;
  return [(b[16] << 24) | (b[17] << 16) | (b[18] << 8) | b[19], (b[20] << 24) | (b[21] << 16) | (b[22] << 8) | b[23]] as [
    number,
    number,
  ];
}

export const PAGE_SIZES = {
  a4: [595.28, 841.89],
  letter: [612, 792],
  a5: [419.53, 595.28],
  b5: [498.9, 708.7],
} as const;

/** 尽量不解码整图，只读文件头拿像素宽高 */
export async function imageDims(blob: Blob): Promise<[number, number]> {
  const b = new Uint8Array(await blob.arrayBuffer());
  const kind = sniff(b);
  const d = kind === 'png' ? pngSize(b) : kind === 'jpg' ? jpegSize(b) : null;
  if (d) return d;
  const { decode, iw, ih } = await import('./images');
  const img = await decode(blob);
  const r: [number, number] = [iw(img), ih(img)];
  if ('close' in img) img.close();
  return r;
}


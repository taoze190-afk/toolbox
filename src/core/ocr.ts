import { asset } from './assets';
import type { Progress } from './jobs';

let workerPromise: Promise<any> | null = null;
let activeLangs = '';

export type OcrLang = 'chi_sim' | 'eng' | 'chi_sim+eng' | 'jpn' | 'kor';

export async function getOcrWorker(langs: string, onProgress?: (p: Progress) => void) {
  if (workerPromise && activeLangs === langs) return workerPromise;
  const prev = workerPromise;
  activeLangs = langs;
  workerPromise = (async () => {
    if (prev) {
      try {
        (await prev).terminate();
      } catch {
        /* ignore */
      }
    }
    const { createWorker } = await import('tesseract.js');
    return createWorker(langs.split('+'), 1, {
      workerPath: asset('tesseract/worker.min.js'),
      corePath: asset('tesseract/core/tesseract-core-simd.wasm.js'),
      langPath: asset('tessdata'),
      gzip: false,
      cacheMethod: 'none',
      logger: (m: any) => {
        if (m?.status === 'recognizing text') onProgress?.({ done: m.progress, total: 1, label: '识别中' });
        else if (typeof m?.progress === 'number') onProgress?.({ done: m.progress, total: 1, label: '准备识别引擎' });
      },
    });
  })();
  return workerPromise;
}

export type OcrWord = { text: string; x: number; y: number; w: number; h: number; conf: number };
export type OcrLine = { text: string; y: number; h: number; words: OcrWord[] };
export type OcrResult = { text: string; lines: OcrLine[]; conf: number };

const wordBox = (w: any) => {
  const b = w.bbox ?? w;
  const x0 = b.x0 ?? w.x0 ?? 0;
  const y0 = b.y0 ?? w.y0 ?? 0;
  const x1 = b.x1 ?? w.x1 ?? x0;
  const y1 = b.y1 ?? w.y1 ?? y0;
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
};

const CJK = /[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/;

/**
 * tesseract 会把中文切成单字/词块，直接 join(' ') 会在词中间塞空格。
 * 只在真有间隙、或两侧都是西文时才补空格。
 */
const joinWords = (words: OcrWord[]) => {
  let s = '';
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (i > 0) {
      const prev = words[i - 1];
      const gap = w.x - (prev.x + prev.w);
      const western = !CJK.test(prev.text.slice(-1)) && !CJK.test(w.text[0]);
      if (western || gap > Math.max(2, 0.3 * Math.max(prev.h, w.h))) s += ' ';
    }
    s += w.text;
  }
  return s.trim();
};

const flatten = (out: OcrResult, node: any) => {
  for (const p of node?.paragraphs ?? []) {
    for (const l of p?.lines ?? []) {
      const words: OcrWord[] = (l.words ?? []).map((w: any) => ({
        text: w.text ?? '',
        conf: w.confidence ?? 0,
        ...wordBox(w),
      }));
      const text = joinWords(words);
      if (!text) continue;
      out.lines.push({
        text,
        y: words[0]?.y ?? 0,
        h: Math.max(...words.map((w) => w.h), 1),
        words,
      });
    }
  }
};

export async function ocrImage(
  src: HTMLCanvasElement | HTMLImageElement | ImageBitmap | Blob | string,
  langs: string,
  onProgress?: (p: Progress) => void,
  psm?: string,
): Promise<OcrResult> {
  const worker = await getOcrWorker(langs, onProgress);
  if (psm) await worker.setParameters({ tessedit_pageseg_mode: psm });
  const r = await worker.recognize(src as any, {}, { blocks: true, text: true });
  const out: OcrResult = { text: r.data.text ?? '', lines: [], conf: r.data.confidence ?? 0 };
  // v6 起 blocks 直接挂在 data 上，v5 及以前是 data.pages[].blocks
  const pages = r.data.pages ?? (r.data.blocks ? [{ blocks: r.data.blocks }] : []);
  for (const page of pages) for (const block of page.blocks ?? []) flatten(out, block);
  if (!out.lines.length && out.text) {
    out.text.split('\n').forEach((t, i) => {
      if (t.trim()) out.lines.push({ text: t.trim(), y: i * 20, h: 20, words: [{ text: t.trim(), x: 0, y: i * 20, w: 0, h: 20, conf: out.conf }] });
    });
  }
  return out;
}

/**
 * 表格照里的横竖格线会被识别成一串 "[" "|" 之类的字符，整行结构就废了。
 * 判据：一整行/列的深色占比超过 55% 才算格线——正文行的墨量通常只有 15~30%。
 */
export function stripGridLines(cv: HTMLCanvasElement): void {
  const g = cv.getContext('2d', { willReadFrequently: true })!;
  const { width: w, height: h } = cv;
  const im = g.getImageData(0, 0, w, h);
  const d = im.data;
  const lum = (i: number) => d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
  const darkRow = new Float32Array(h);
  const darkCol = new Float32Array(w);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (d[i + 3] < 40) continue;
      if (lum(i) < 160) {
        darkRow[y]++;
        darkCol[x]++;
      }
    }
  }
  const wipe = (i: number) => {
    if (lum(i) < 200) d[i] = d[i + 1] = d[i + 2] = 255;
  };
  for (let y = 0; y < h; y++) {
    if (darkRow[y] / w <= 0.55) continue;
    for (let x = 0; x < w; x++) wipe((y * w + x) * 4);
  }
  for (let x = 0; x < w; x++) {
    if (darkCol[x] / h <= 0.55) continue;
    for (let y = 0; y < h; y++) wipe((y * w + x) * 4);
  }
  g.putImageData(im, 0, 0);
}

export async function disposeOcr() {
  const p = workerPromise;
  workerPromise = null;
  activeLangs = '';
  if (p) {
    try {
      (await p).terminate();
    } catch {
      /* ignore */
    }
  }
}

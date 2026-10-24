export type ImgSrc = ImageBitmap | HTMLImageElement | HTMLCanvasElement | OffscreenCanvas;

export function iw(img: ImgSrc): number {
  return img instanceof HTMLImageElement ? img.naturalWidth : img.width;
}
export function ih(img: ImgSrc): number {
  return img instanceof HTMLImageElement ? img.naturalHeight : img.height;
}

export function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

/** 解码图片，自动跟随 EXIF 方向；HEIC 在安卓 WebView 上解不了，由调用方兜底提示 */
export async function decode(file: Blob): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch (e) {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      const c = makeCanvas(img.naturalWidth, img.naturalHeight);
      c.getContext('2d')!.drawImage(img, 0, 0);
      return (await createImageBitmap(c)) as unknown as ImageBitmap;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

/** 逐级对半缩，比一次缩到目标尺寸清晰得多 */
export function resize(img: ImgSrc, tw: number, th: number, target?: HTMLCanvasElement): HTMLCanvasElement {
  let sw = iw(img);
  let sh = ih(img);
  let cur: ImgSrc = img;
  while (sw / 2 >= tw && sh / 2 >= th && sw > 2 && sh > 2) {
    const c = makeCanvas(sw / 2, sh / 2);
    const g = c.getContext('2d')!;
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(cur as CanvasImageSource, 0, 0, c.width, c.height);
    cur = c;
    sw = c.width;
    sh = c.height;
  }
  const out = target ?? makeCanvas(tw, th);
  out.width = Math.max(1, Math.round(tw));
  out.height = Math.max(1, Math.round(th));
  const g = out.getContext('2d')!;
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.clearRect(0, 0, out.width, out.height);
  g.drawImage(cur as CanvasImageSource, 0, 0, out.width, out.height);
  return out;
}

/** 等比缩放到不超过 maxW x maxH（不放大） */
export function fitInside(w: number, h: number, maxW: number, maxH: number): [number, number] {
  const s = Math.min(1, maxW / w, maxH / h);
  return [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))];
}

export function coverCrop(w: number, h: number, ratio: number): { sx: number; sy: number; sw: number; sh: number } {
  const cur = w / h;
  let sw = w;
  let sh = h;
  if (cur > ratio) sw = Math.round(h * ratio);
  else sh = Math.round(w / ratio);
  return { sx: Math.round((w - sw) / 2), sy: Math.round((h - sh) / 2), sw, sh };
}

export function cropTo(img: ImgSrc, sx: number, sy: number, sw: number, sh: number, tw?: number, th?: number): HTMLCanvasElement {
  const out = makeCanvas(tw ?? sw, th ?? sh);
  const g = out.getContext('2d')!;
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(img as CanvasImageSource, sx, sy, sw, sh, 0, 0, out.width, out.height);
  return out;
}

/** 透明像素铺成指定底色（证件照要求不透明背景） */
export function flatten(cv: HTMLCanvasElement, bg = '#ffffff'): HTMLCanvasElement {
  const out = makeCanvas(cv.width, cv.height);
  const g = out.getContext('2d')!;
  g.fillStyle = bg;
  g.fillRect(0, 0, out.width, out.height);
  g.drawImage(cv, 0, 0);
  return out;
}

export function encode(cv: HTMLCanvasElement, mime: string, quality = 0.85): Promise<Blob> {
  return new Promise((resolve, reject) => {
    cv.toBlob(
      (b) => (b ? resolve(b) : reject(new Error(`编码失败：${mime}（画布 ${cv.width}x${cv.height}）`))),
      mime,
      quality,
    );
  });
}

export const MIMES = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' } as const;

export function pickMime(name: string, prefer?: string): string {
  if (prefer) return prefer;
  const e = name.split('.').pop()?.toLowerCase() ?? '';
  if (e === 'png') return 'image/png';
  if (e === 'webp') return 'image/webp';
  return 'image/jpeg';
}

/**
 * 压到目标体积以内。先降质量，再降尺寸。
 * 返回 null 表示给定的最低质量/最小尺寸仍达不到目标。
 */
export async function compressToTarget(
  img: ImgSrc,
  targetBytes: number,
  mime = 'image/jpeg',
  opts: { minQuality?: number; minScale?: number } = {},
): Promise<{ blob: Blob; cv: HTMLCanvasElement; quality: number; scale: number } | null> {
  const minQ = opts.minQuality ?? 0.25;
  const minScale = opts.minScale ?? 0.2;
  const w0 = iw(img);
  const h0 = ih(img);
  for (let scale = 1; scale >= minScale - 1e-6; scale *= 0.82) {
    const cv = resize(img, Math.round(w0 * scale), Math.round(h0 * scale));
    let lo = minQ;
    let hi = 0.95;
    let best: { blob: Blob; q: number } | null = null;
    while (hi - lo > 0.02) {
      const mid = (lo + hi) / 2;
      const b = await encode(cv, mime, mid);
      if (b.size <= targetBytes) {
        best = { blob: b, q: mid };
        lo = mid;
      } else {
        hi = mid;
      }
    }
    if (best) return { blob: best.blob, cv, quality: best.q, scale };
    const floor = await encode(cv, mime, minQ);
    if (floor.size > targetBytes) continue;
    return { blob: floor, cv, quality: minQ, scale };
  }
  return null;
}

/** 固定质量压缩（"清晰优先/均衡/体积小"档位） */
export async function compressByQuality(
  img: ImgSrc,
  mime: string,
  quality: number,
  maxSide = 0,
): Promise<{ blob: Blob; cv: HTMLCanvasElement }> {
  let w = iw(img);
  let h = ih(img);
  if (maxSide > 0 && Math.max(w, h) > maxSide) {
    const s = maxSide / Math.max(w, h);
    w = Math.round(w * s);
    h = Math.round(h * s);
  }
  const cv = resize(img, w, h);
  return { blob: await encode(cv, mime, quality), cv };
}

export function dataUrl(cv: HTMLCanvasElement, mime = 'image/jpeg', q = 0.7): string {
  return cv.toDataURL(mime, q);
}

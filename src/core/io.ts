import { Capacitor } from '@capacitor/core';

export const isNative = () => Capacitor.isNativePlatform();

export function mimeOf(name: string): string {
  const e = name.split('.').pop()?.toLowerCase() ?? '';
  return (
    {
      jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
      gif: 'image/gif', avif: 'image/avif', bmp: 'image/bmp', heic: 'image/heic',
      pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      zip: 'application/zip', mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav',
      aac: 'audio/aac', ogg: 'audio/ogg', txt: 'text/plain; charset=utf-8',
    }[e] ?? 'application/octet-stream'
  );
}

export async function blobToBase64(b: Blob): Promise<string> {
  const buf = new Uint8Array(await b.arrayBuffer());
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < buf.length; i += CH) s += String.fromCharCode(...buf.subarray(i, i + CH));
  return btoa(s);
}

export function base64ToBlob(b64: string, mime: string): Blob {
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return new Blob([buf], { type: mime });
}

export type Saved = { ok: true; where: string } | { ok: false; error: string };

/**
 * 原生端落到应用私有目录（Android 11+ 拿不到公共目录，除非走系统分享面板）。
 * 界面上要按"应用目录"来描述，别写成"已保存到下载"。
 */
export async function saveBlob(name: string, blob: Blob, sub = ''): Promise<Saved> {
  if (!isNative()) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    return { ok: true, where: 'download' };
  }
  try {
    const { Filesystem, Directory } = await import('@capacitor/filesystem');
    const dir = sub ? `工具箱/${sub}` : '工具箱';
    const r = await Filesystem.writeFile({
      path: `${dir}/${name}`,
      data: await blobToBase64(blob),
      directory: Directory.Documents,
      recursive: true,
    });
    return { ok: true, where: r.uri };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

/** 调起系统分享（可存到文件、发微信等） */
export async function shareBlob(name: string, blob: Blob): Promise<Saved> {
  if (!isNative()) return { ok: false, error: '仅 App 内可用' };
  try {
    const { Filesystem, Directory } = await import('@capacitor/filesystem');
    const { Share } = await import('@capacitor/share');
    const written = await Filesystem.writeFile({
      path: `share/${name}`,
      data: await blobToBase64(blob),
      directory: Directory.Cache,
      recursive: true,
    });
    await Share.share({ title: name, url: written.uri, dialogTitle: name });
    return { ok: true, where: 'share' };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

export async function revealDir(sub = '') {
  if (!isNative()) return;
  const { Filesystem, Directory } = await import('@capacitor/filesystem');
  const p = await Filesystem.getUri({ path: sub ? `工具箱/${sub}` : '工具箱', directory: Directory.Documents });
  return p.uri;
}

export async function freeSpaceOk(min: number): Promise<boolean> {
  return navigator.storage ? (await navigator.storage.estimate()).quota! > min : true;
}

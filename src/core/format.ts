export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '-';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function fmtSec(s: number): string {
  if (!Number.isFinite(s) || s < 0) return '-';
  const m = Math.floor(s / 60);
  const r = Math.round(s % 60);
  return m > 0 ? `${m}:${String(r).padStart(2, '0')}` : `${r}秒`;
}

export function baseName(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(0, i) : name;
}

export function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

/** 生成不重复的输出名：a.pdf -> a-压缩.pdf -> a-压缩-2.pdf */
export function suffixName(name: string, suffix: string, taken: Set<string>): string {
  const base = baseName(name);
  let cand = `${base}-${suffix}${name.slice(base.length)}`;
  let i = 2;
  while (taken.has(cand.toLowerCase())) cand = `${base}-${suffix}-${i++}${name.slice(base.length)}`;
  taken.add(cand.toLowerCase());
  return cand;
}

/** 只保证不重名，不加后缀 */
export function uniqueName(name: string, taken: Set<string>): string {
  let cand = name;
  const base = baseName(name);
  const ext = name.slice(base.length);
  let i = 2;
  while (taken.has(cand.toLowerCase())) cand = `${base}-${i++}${ext}`;
  taken.add(cand.toLowerCase());
  return cand;
}

export function shortHash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36).slice(0, 6);
}

/** 主题单独占一个 key，好让 index.html 里的首屏脚本只读这一个值，避免深色下先闪白 */
export type ThemeMode = 'auto' | 'light' | 'dark';

const KEY = 'tk.theme';
const mq = () => matchMedia('(prefers-color-scheme: dark)');

export function themeMode(): ThemeMode {
  const v = localStorage.getItem(KEY);
  return v === 'light' || v === 'dark' ? v : 'auto';
}

export function isDark(m = themeMode()) {
  return m === 'auto' ? mq().matches : m === 'dark';
}

export function applyTheme(m = themeMode()) {
  const dark = isDark(m);
  const el = document.documentElement;
  el.dataset.theme = dark ? 'dark' : 'light';
  el.style.colorScheme = dark ? 'dark light' : 'light';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#0c0e14' : '#f4f5f8');
}

export function setTheme(m: ThemeMode) {
  localStorage.setItem(KEY, m);
  applyTheme(m);
}

/** 停在「跟随系统」时，系统切换要立刻跟上 */
export function watchTheme() {
  const on = () => themeMode() === 'auto' && applyTheme('auto');
  mq().addEventListener('change', on);
  return () => mq().removeEventListener('change', on);
}

import { useEffect, useState } from 'react';

/** 窄屏走「首页 → 工具页」的单栏流程，宽屏走左侧工具栏 + 右侧面板 */
export const WIDE_PX = 1024;

export function useWide() {
  const [wide, setWide] = useState(() => innerWidth >= WIDE_PX);
  useEffect(() => {
    const on = () => setWide(innerWidth >= WIDE_PX);
    addEventListener('resize', on);
    addEventListener('orientationchange', on);
    return () => {
      removeEventListener('resize', on);
      removeEventListener('orientationchange', on);
    };
  }, []);
  return wide;
}

export const cx = (...xs: (string | false | null | undefined)[]) => xs.filter(Boolean).join(' ');

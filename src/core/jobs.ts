export type Progress = { done: number; total: number; label?: string };

export class Cancelled extends Error {
  constructor() {
    super('已取消');
    this.name = 'Cancelled';
  }
}

export type JobCtx = {
  progress: (p: Progress) => void;
  signal: AbortSignal;
  /** 长循环里调用，抛 Cancelled 以中断 */
  tick: () => void;
  /** 让 UI 有机会重绘（wasm/同步渲染很重时用） */
  breathe: () => Promise<void>;
};

export function makeCtx(progress: (p: Progress) => void, signal: AbortSignal): JobCtx {
  return {
    progress,
    signal,
    tick: () => {
      if (signal.aborted) throw new Cancelled();
    },
    breathe: () =>
      new Promise<void>((r) => {
        if (signal.aborted) return r();
        requestAnimationFrame(() => setTimeout(r, 0));
      }),
  };
}

export function isCancelled(e: unknown): boolean {
  return e instanceof Cancelled || (e as any)?.name === 'AbortError';
}

export function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

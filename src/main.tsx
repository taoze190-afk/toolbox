import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import ErrorBoundary from './ui/ErrorBoundary';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary><App /></ErrorBoundary>
  </StrictMode>,
);

if (import.meta.env.DEV || import.meta.env.VITE_TK_TEST === '1') {
  const { TOOLS } = await import('./tools/registry');
  const { makeCtx } = await import('./core/jobs');
  (window as any).__tk = {
    tools: TOOLS.map((t) => ({ id: t.id, name: t.name, zone: t.zone, defaults: t.defaults })),
    async run(id: string, files: File[], opts?: Record<string, unknown>) {
      const t = TOOLS.find((x) => x.id === id);
      if (!t) throw new Error(`没有这个工具：${id}`);
      const ac = new AbortController();
      const ctx = makeCtx(() => {}, ac.signal);
      const outs = await t.run(files, { ...structuredClone(t.defaults), ...(opts ?? {}) }, ctx);
      return await Promise.all(
        outs.map(async (o) => ({
          name: o.name,
          size: o.blob.size,
          kind: o.kind,
          note: o.note ?? '',
          b64: await blobToB64(o.blob),
        })),
      );
    },
    async makeTextImage(text: string, w = 900, h = 500, fontPx = 44) {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const g = c.getContext('2d')!;
      g.fillStyle = '#fff';
      g.fillRect(0, 0, w, h);
      g.fillStyle = '#000';
      g.font = `${fontPx}px system-ui, sans-serif`;
      g.textBaseline = 'top';
      const lines = text.split('\n');
      lines.forEach((ln, i) => g.fillText(ln, 24, 24 + i * fontPx * 1.7));
      const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), 'image/png'));
      return new File([blob], 'text.png', { type: 'image/png' });
    },
  };
}

async function blobToB64(b: Blob): Promise<string> {
  const buf = new Uint8Array(await b.arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
}

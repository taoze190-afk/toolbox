import { Panel, Row, Segmented, Slider, Hint } from '../../ui/controls';
import type { ControlsProps, Out, ToolDef } from '../types';
import type { JobCtx } from '../../core/jobs';
import { openPdf, renderPage } from '../../core/pdf';
import { encode, MIMES } from '../../core/images';
import { uniqueName } from '../../core/format';

function Controls({ value, patch }: ControlsProps) {
  return (
    <Panel>
      <Row label="清晰度" hint={`${Math.round((value.dpi / 72) * 100)}%`}>
        <Slider value={value.dpi} onChange={(v) => patch({ dpi: v })} min={72} max={300} step={6} suffix=" dpi" />
      </Row>
      <Row label="图片格式">
        <Segmented
          value={value.mime}
          onChange={(v) => patch({ mime: v })}
          options={[
            { value: MIMES.jpeg, label: 'JPG' },
            { value: MIMES.png, label: 'PNG' },
            { value: MIMES.webp, label: 'WebP' },
          ]}
        />
      </Row>
      {value.mime !== MIMES.jpeg && <Hint>PNG 会大很多，页数多时请耐心等待。</Hint>}
    </Panel>
  );
}

async function run(files: File[], o: any, ctx: JobCtx): Promise<Out[]> {
  const taken = new Set<string>();
  const outs: Out[] = [];
  const ext = o.mime === MIMES.png ? 'png' : o.mime === MIMES.webp ? 'webp' : 'jpg';
  for (let k = 0; k < files.length; k++) {
    ctx.tick();
    const doc = await openPdf(files[k]);
    ctx.progress({ done: k, total: files.length, label: `${files[k].name} · ${doc.numPages} 页` });
    const stem = files[k].name.replace(/\.pdf$/i, '');
    const pad = String(doc.numPages).length;
    try {
      for (let p = 1; p <= doc.numPages; p++) {
        ctx.tick();
        ctx.progress({ done: p - 1, total: doc.numPages, label: `第 ${p}/${doc.numPages} 页` });
        const { canvas } = await renderPage(doc, p, o.dpi);
        const blob = await encode(canvas, o.mime, 0.9);
        outs.push({
          name: uniqueName(`${stem}-第${String(p).padStart(pad, '0')}页.${ext}`, taken),
          blob,
          kind: 'image',
          note: `${canvas.width}×${canvas.height}`,
        });
        canvas.width = canvas.height = 0;
        await ctx.breathe();
      }
    } finally {
      await doc.destroy();
    }
  }
  return outs;
}

const tool: ToolDef = {
  id: 'pdf-to-pages',
  name: 'PDF 逐页转图',
  desc: '每一页导出成一张图片',
  zone: 'convert',
  icon: '📑',
  accept: 'application/pdf,.pdf',
  multiple: false,
  inputHint: '页数多的文件会占用较多内存，建议一次处理一个',
  defaults: { dpi: 150, mime: MIMES.jpeg },
  Controls,
  run,
};

export default tool;

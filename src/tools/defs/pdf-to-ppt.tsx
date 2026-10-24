import { Hint, Panel, Row, Segmented, Slider } from '../../ui/controls';
import type { ControlsProps, Out, ToolDef } from '../types';
import type { JobCtx } from '../../core/jobs';
import { openPdf, renderPage } from '../../core/pdf';
import { dataUrl, MIMES } from '../../core/images';
import { baseName, uniqueName } from '../../core/format';

/** pptx 幻灯片单边最大约 56 英寸，留点余量 */
const MAX_IN = 50;
const QUALITY = 0.9;

const inch = (pt: number) => Math.round((pt / 72) * 1000) / 1000;
const show = (v: number) => String(Math.round(v * 100) / 100);

function Controls({ value, patch }: ControlsProps) {
  return (
    <Panel>
      <Row label="清晰度">
        <Slider value={value.dpi} onChange={(v) => patch({ dpi: v })} min={96} max={220} step={4} suffix=" dpi" />
      </Row>
      <Row label="幻灯片比例">
        <Segmented
          value={value.ratio}
          onChange={(v) => patch({ ratio: v })}
          options={[
            { value: 'first', label: '跟随首页' },
            { value: '169', label: '16:9 横版' },
          ]}
        />
      </Row>
      <Hint>每页是一张整页图片，文字不可编辑；比例不同的页会居中留白。</Hint>
    </Panel>
  );
}

async function run(files: File[], o: any, ctx: JobCtx): Promise<Out[]> {
  const taken = new Set<string>();
  const outs: Out[] = [];

  for (const file of files) {
    ctx.tick();
    const src = await openPdf(file);
    const numPages = src.numPages;
    ctx.progress({ done: 0, total: numPages, label: `${file.name} · ${numPages} 页` });

    try {
      // 首页尺寸定全局 layout
      const first = await src.page(1);
      const fv = first.getViewport({ scale: 1 });
      first.cleanup();
      let wIn = inch(fv.width);
      let hIn = inch(fv.height);
      if (o.ratio === '169') {
        wIn = 13.33;
        hIn = 7.5;
      }
      const shrink = Math.min(1, MAX_IN / Math.max(wIn, hIn));
      const W = Math.round(wIn * shrink * 1000) / 1000;
      const H = Math.round(hIn * shrink * 1000) / 1000;

      const PptxGenJS = ((await import('pptxgenjs')) as any).default;
      const pptx = new PptxGenJS();
      pptx.defineLayout({ name: 'PDFPAGE', width: W, height: H });
      pptx.layout = 'PDFPAGE';

      for (let p = 1; p <= numPages; p++) {
        ctx.tick();
        ctx.progress({ done: p - 1, total: numPages, label: `第 ${p}/${numPages} 页` });
        const { canvas, wPt, hPt } = await renderPage(src, p, o.dpi);
        const data = dataUrl(canvas, MIMES.jpeg, QUALITY);
        canvas.width = canvas.height = 0;

        const slide = pptx.addSlide();
        slide.background = { color: 'FFFFFF' };
        const iw = Math.max(0.5, wPt / 72);
        const ih = Math.max(0.5, hPt / 72);
        const k = Math.min(W / iw, H / ih);
        const w = Math.round(iw * k * 1000) / 1000;
        const h = Math.round(ih * k * 1000) / 1000;
        slide.addImage({
          data,
          x: Math.round(((W - w) / 2) * 1000) / 1000,
          y: Math.round(((H - h) / 2) * 1000) / 1000,
          w,
          h,
        });
        await ctx.breathe();
      }

      ctx.tick();
      ctx.progress({ done: numPages - 1, total: numPages, label: '封装 PPTX' });
      const blob = (await pptx.write({ outputType: 'blob' })) as Blob;
      outs.push({
        name: uniqueName(`${baseName(file.name)}.pptx`, taken),
        blob,
        kind: 'slides',
        note: `${numPages} 页 · ${show(W)}×${show(H)} 英寸`,
      });
    } finally {
      await src.destroy();
    }
  }
  return outs;
}

const tool: ToolDef = {
  id: 'pdf-to-ppt',
  name: 'PDF 转 PPT',
  desc: '每页做成一张幻灯片',
  zone: 'convert',
  icon: '🖥️',
  accept: 'application/pdf,.pdf',
  multiple: false,
  inputHint: '页数多的文件会占用较多内存',
  defaults: { dpi: 150, ratio: 'first' },
  Controls,
  run,
};

export default tool;

import { Hint, Num, Panel, Row, Segmented, Slider, Toggle } from '../../ui/controls';
import type { ControlsProps, Out, ToolDef } from '../types';
import type { JobCtx } from '../../core/jobs';
import { openPdf, renderPage } from '../../core/pdf';
import { encode, makeCanvas, MIMES } from '../../core/images';
import { baseName, uniqueName } from '../../core/format';

/** WebView 单画布上限：单边 16384px，面积再卡一道内存线（约 64MB 像素缓冲） */
const MAX_SIDE = 16384;
const MAX_AREA = 16_000_000;
const MIN_DPI = 36;

const FORMATS = [
  { value: MIMES.jpeg, label: 'JPG' },
  { value: MIMES.png, label: 'PNG' },
  { value: MIMES.webp, label: 'WebP' },
];

const amax = (a: number[]) => a.reduce((x, y) => (x > y ? x : y), 1);

type Plan = { dpi: number; width: number; height: number; ws: number[]; hs: number[] };

function Controls({ value, patch }: ControlsProps) {
  return (
    <Panel>
      <Row label="清晰度" hint="放不下会自动降">
        <Slider value={value.dpi} onChange={(v) => patch({ dpi: v })} min={72} max={250} step={6} suffix=" dpi" />
      </Row>
      <Row label="图片格式">
        <Segmented value={value.mime} onChange={(v) => patch({ mime: v })} options={FORMATS} />
      </Row>
      <Row label="页间距">
        <Num value={value.gap} onChange={(v) => patch({ gap: v })} min={0} max={80} step={2} suffix="px" />
      </Row>
      <Row label="窄页居中">
        <Toggle value={value.center} onChange={(v) => patch({ center: v })} label={value.center ? '居中留白' : '靠左排列'} />
      </Row>
      <Hint>长图单边最长 16384px，页数多时清晰度会被自动压低。</Hint>
    </Panel>
  );
}

async function run(files: File[], o: any, ctx: JobCtx): Promise<Out[]> {
  const taken = new Set<string>();
  const outs: Out[] = [];

  for (const file of files) {
    ctx.tick();
    const doc = await openPdf(file);
    try {
      // 只量尺寸不渲染
      const pts: Array<[number, number]> = [];
      for (let p = 1; p <= doc.numPages; p++) {
        ctx.tick();
        ctx.progress({ done: p - 1, total: doc.numPages, label: `量页 ${p}/${doc.numPages}` });
        const page = await doc.page(p);
        const v = page.getViewport({ scale: 1 });
        pts.push([v.width, v.height]);
        page.cleanup();
      }

      const planAt = (dpi: number): Plan => {
        const k = dpi / 72;
        const ws = pts.map(([w]) => Math.max(1, Math.round(w * k)));
        const hs = pts.map(([, h]) => Math.max(1, Math.round(h * k)));
        let height = 0;
        hs.forEach((h, i) => {
          height += h + (i ? Number(o.gap) : 0);
        });
        return { dpi, width: amax(ws), height, ws, hs };
      };

      let plan = planAt(o.dpi);
      let lowered = false;
      while (plan.width > MAX_SIDE || plan.height > MAX_SIDE || plan.width * plan.height > MAX_AREA) {
        if (plan.dpi <= MIN_DPI) throw new Error('页数太多，长图放不下，改用逐页转图');
        lowered = true;
        plan = planAt(Math.max(MIN_DPI, Math.floor(plan.dpi * 0.85)));
      }

      const cv = makeCanvas(plan.width, plan.height);
      const g = cv.getContext('2d', { alpha: false })!;
      g.fillStyle = '#ffffff';
      g.fillRect(0, 0, cv.width, cv.height);
      g.imageSmoothingEnabled = true;
      g.imageSmoothingQuality = 'high';

      const cap = Math.max(plan.width, amax(plan.hs));
      let y = 0;
      for (let p = 1; p <= pts.length; p++) {
        ctx.tick();
        ctx.progress({ done: p - 1, total: pts.length, label: `拼第 ${p}/${pts.length} 页` });
        const { canvas } = await renderPage(doc, p, plan.dpi, cap);
        const w = plan.ws[p - 1];
        const h = plan.hs[p - 1];
        g.drawImage(canvas, o.center ? Math.round((plan.width - w) / 2) : 0, y, w, h);
        canvas.width = canvas.height = 0;
        y += h + Number(o.gap);
        await ctx.breathe();
      }

      const blob = await encode(cv, o.mime, 0.92);
      cv.width = cv.height = 0;

      const ext = o.mime === MIMES.png ? 'png' : o.mime === MIMES.webp ? 'webp' : 'jpg';
      const note = [`${pts.length} 页`, `${plan.width}×${plan.height}px`];
      if (lowered) note.push(`清晰度已降到 ${plan.dpi} dpi`);

      outs.push({ name: uniqueName(`${baseName(file.name)}-长图.${ext}`, taken), blob, kind: 'image', note: note.join(' · ') });
    } finally {
      await doc.destroy();
    }
  }
  return outs;
}

const tool: ToolDef = {
  id: 'pdf-to-longimg',
  name: 'PDF 转长图',
  desc: '所有页拼成一张竖长图',
  zone: 'convert',
  icon: '📏',
  accept: 'application/pdf,.pdf',
  multiple: false,
  inputHint: '页数极多的文件建议改用逐页转图',
  defaults: { dpi: 144, mime: MIMES.jpeg, gap: 12, center: true },
  Controls,
  run,
};

export default tool;

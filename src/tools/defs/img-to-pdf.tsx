import { Panel, Row, Segmented, Slider, Hint } from '../../ui/controls';
import type { ControlsProps, Out, ToolDef } from '../types';
import type { JobCtx } from '../../core/jobs';
import { embedImageAsPage, imageDims, newPdfDoc, PAGE_SIZES, pdfBlob } from '../../core/pdf';
import { fmtBytes } from '../../core/format';

const PAGES = [
  { value: 'fit', label: '与原图同尺寸' },
  { value: 'a4', label: 'A4' },
  { value: 'letter', label: '信纸' },
  { value: 'a5', label: 'A5' },
];

function Controls({ value, patch }: ControlsProps) {
  return (
    <Panel>
      <Row label="页面">
        <Segmented value={value.page} onChange={(v) => patch({ page: v })} options={PAGES} />
      </Row>
      <Row label="方向" hint="仅固定页面时生效">
        <Segmented
          value={value.orient}
          onChange={(v) => patch({ orient: v })}
          options={[
            { value: 'auto', label: '自动' },
            { value: 'p', label: '竖向' },
            { value: 'l', label: '横向' },
          ]}
        />
      </Row>
      <Row label="页边距">
        <Slider value={value.margin} onChange={(v) => patch({ margin: v })} min={0} max={60} step={2} suffix=" pt" />
      </Row>
      <Row label="输出">
        <Segmented
          value={value.merge}
          onChange={(v) => patch({ merge: v })}
          options={[
            { value: 'one', label: '合成一个 PDF' },
            { value: 'each', label: '每张一个 PDF' },
          ]}
        />
      </Row>
      <Row label="非 JPG/PNG 转码质量" hint="WebP/GIF/HEIC 会先转成 JPG">
        <Slider value={value.quality} onChange={(v) => patch({ quality: v })} min={50} max={98} suffix="%" />
      </Row>
      <Hint>已是 JPG/PNG 的图片原样嵌入，不会二次压缩。</Hint>
    </Panel>
  );
}

async function run(files: File[], o: any, ctx: JobCtx): Promise<Out[]> {
  const fixed = o.page !== 'fit';
  const base = fixed ? (PAGE_SIZES[o.page as keyof typeof PAGE_SIZES] as readonly [number, number]) : null;
  const sizeOf = async (f: File): Promise<{ pageW?: number; pageH?: number }> => {
    if (!base) return {};
    let [pw, ph] = base;
    if (o.orient === 'p') [pw, ph] = [Math.min(pw, ph), Math.max(pw, ph)];
    else if (o.orient === 'l') [pw, ph] = [Math.max(pw, ph), Math.min(pw, ph)];
    else {
      const [iw, ih] = await imageDims(f);
      if (iw > ih && pw < ph) [pw, ph] = [ph, pw];
      if (iw < ih && pw > ph) [pw, ph] = [ph, pw];
    }
    return { pageW: pw, pageH: ph };
  };

  if (o.merge === 'each') {
    const outs: Out[] = [];
    for (let i = 0; i < files.length; i++) {
      ctx.tick();
      ctx.progress({ done: i, total: files.length, label: files[i].name });
      const doc = await newPdfDoc();
      await embedImageAsPage(doc, files[i], { ...(await sizeOf(files[i])), margin: o.margin, quality: o.quality / 100 });
      const bytes = await doc.save({ useObjectStreams: true });
      outs.push({
        name: files[i].name.replace(/\.\w+$/, '') + '.pdf',
        blob: pdfBlob(bytes),
        kind: 'pdf',
        note: `1 页 · ${fmtBytes(bytes.byteLength)}`,
      });
      await ctx.breathe();
    }
    return outs;
  }

  const doc = await newPdfDoc();
  for (let i = 0; i < files.length; i++) {
    ctx.tick();
    ctx.progress({ done: i, total: files.length, label: `第 ${i + 1}/${files.length} 张` });
    await embedImageAsPage(doc, files[i], { ...(await sizeOf(files[i])), margin: o.margin, quality: o.quality / 100 });
    await ctx.breathe();
  }
  const bytes = await doc.save({ useObjectStreams: true });
  const name = files.length === 1 ? files[0].name.replace(/\.\w+$/, '') + '.pdf' : '图片合成.pdf';
  return [{ name, blob: pdfBlob(bytes), kind: 'pdf', note: `${files.length} 页` }];
}

const tool: ToolDef = {
  id: 'img-to-pdf',
  name: '图片转 PDF',
  desc: '多张图合成一个 PDF，或每张单独成 PDF',
  zone: 'convert',
  icon: '🧩',
  accept: 'image/*',
  multiple: true,
  inputHint: '按列表顺序生成页码，可上下调整顺序',
  defaults: { page: 'a4', orient: 'auto', margin: 18, merge: 'one', quality: 92 },
  Controls,
  run,
};

export default tool;

import { Hint, Num, Panel, Row, Segmented, Slider } from '../../ui/controls';
import type { ControlsProps, Out, ToolDef } from '../types';
import type { JobCtx } from '../../core/jobs';
import { compressToTarget, decode, encode, fitInside, ih, iw, makeCanvas, MIMES, resize } from '../../core/images';
import { uniqueName, fmtBytes, baseName as baseOf } from '../../core/format';

const FORMATS = [
  { value: MIMES.jpeg, label: 'JPG' },
  { value: MIMES.webp, label: 'WebP' },
  { value: MIMES.png, label: 'PNG' },
];

function Controls({ value, patch }: ControlsProps) {
  return (
    <Panel>
      <Row label="压缩方式">
        <Segmented
          value={value.mode}
          onChange={(v) => patch({ mode: v })}
          options={[
            { value: 'size', label: '压到指定大小' },
            { value: 'quality', label: '按质量' },
          ]}
        />
      </Row>
      {value.mode === 'size' ? (
        <Row label="目标大小" hint="超出会同时降尺寸">
          <Num value={value.targetKB} onChange={(v) => patch({ targetKB: v })} min={5} suffix="KB" />
        </Row>
      ) : (
        <Row label="质量">
          <Slider value={value.quality} onChange={(v) => patch({ quality: v })} min={20} max={95} suffix="%" />
        </Row>
      )}
      <Row label="输出格式">
        <Segmented value={value.mime} onChange={(v) => patch({ mime: v })} options={FORMATS} />
      </Row>
      <Row label="最长边" hint="0 为不限制">
        <Num value={value.maxSide} onChange={(v) => patch({ maxSide: v })} min={0} step={100} suffix="px" />
      </Row>
      {value.mime === MIMES.png && <Hint>PNG 是无损格式，只有降尺寸才会变小。</Hint>}
    </Panel>
  );
}

async function run(files: File[], o: any, ctx: JobCtx): Promise<Out[]> {
  const taken = new Set<string>();
  const outs: Out[] = [];
  for (let i = 0; i < files.length; i++) {
    ctx.tick();
    ctx.progress({ done: i, total: files.length, label: files[i].name });
    const img = await decode(files[i]);
    const w0 = iw(img);
    const h0 = ih(img);
    const [tw, th] = o.maxSide > 0 ? fitInside(w0, h0, o.maxSide, o.maxSide) : [w0, h0];

    let scale = tw / w0;
    let quality: number;
    let blob: Blob;

    if (o.mode === 'size') {
      const target = Math.max(1024, o.targetKB * 1024);
      const r = await compressToTarget(img, target, o.mime);
      if (!r) {
        const fallback = await compressToTarget(img, target * 4, o.mime, { minQuality: 0.1, minScale: 0.05 });
        if (!fallback) throw new Error(`${files[i].name} 无法压到 ${o.targetKB}KB，请放宽目标或改用 JPG`);
        blob = fallback.blob;
        scale = fallback.scale * scale;
        quality = fallback.quality;
      } else {
        blob = r.blob;
        scale = r.scale * scale;
        quality = r.quality;
      }
    } else {
      quality = o.quality / 100;
      const cv = resize(img, tw, th, makeCanvas(tw, th));
      blob = await encode(cv, o.mime, quality);
    }

    const ext = o.mime === MIMES.webp ? 'webp' : o.mime === MIMES.png ? 'png' : 'jpg';
    outs.push({
      name: uniqueName(`${baseOf(files[i].name)}.${ext}`, taken),
      blob,
      kind: 'image',
      note: `${Math.round(w0 * scale)}×${Math.round(h0 * scale)} · ${fmtBytes(blob.size)}`,
    });
    if ('close' in img) (img as ImageBitmap).close();
    await ctx.breathe();
  }
  return outs;
}

const tool: ToolDef = {
  id: 'image-compress',
  name: '图片压缩',
  desc: 'JPG/WebP/PNG 降质量或压到指定大小',
  zone: 'compress',
  icon: '🖼️',
  accept: 'image/*',
  multiple: true,
  defaults: { mode: 'size', targetKB: 200, quality: 75, mime: MIMES.jpeg, maxSide: 0 },
  Controls,
  run,
};

export default tool;

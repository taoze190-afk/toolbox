import { Hint, Num, Panel, Row, Segmented, Select, Swatches } from '../../ui/controls';
import type { ControlsProps, Out, ToolDef } from '../types';
import type { JobCtx } from '../../core/jobs';
import { compressToTarget, coverCrop, cropTo, decode, encode, ih, iw, makeCanvas, resize } from '../../core/images';
import { BG_COLORS, findSize, ID_SIZE_GROUPS, ID_SIZES } from '../../core/presets';
import type { IdSize } from '../../core/presets';
import { baseName, fmtBytes, uniqueName } from '../../core/format';

const PX_SIZE = (s: IdSize) => !!s.note?.startsWith('按像素');

function targetOf(s: IdSize): [number, number] {
  return PX_SIZE(s) ? [s.mm[0], s.mm[1]] : s.px;
}

function labelOf(s: IdSize) {
  const [w, h] = targetOf(s);
  return PX_SIZE(s)
    ? { id: s.id, name: `${s.name} ${w}×${h}px` }
    : { id: s.id, name: `${s.name} ${s.mm[0]}×${s.mm[1]}mm`, note: `${w}×${h}px` };
}

const GROUPS = [
  { label: '不限', items: [{ id: 'origin', name: '不改变尺寸' }] },
  ...ID_SIZE_GROUPS.map((g) => ({ label: g, items: ID_SIZES.filter((s) => s.group === g).map(labelOf) })),
];

const BG_OPTIONS = [...BG_COLORS];

const FORMATS = [
  { value: 'jpg', label: 'JPG' },
  { value: 'png', label: 'PNG' },
];

function Controls({ value, patch }: ControlsProps) {
  return (
    <Panel>
      <Row label="规格">
        <Select value={value.size} onChange={(v) => patch({ size: v })} groups={GROUPS} />
      </Row>
      <Row label="目标大小" hint="压不到会缩尺寸">
        <Num value={value.targetKB} onChange={(v) => patch({ targetKB: v })} min={5} suffix="KB" />
      </Row>
      <Row label="底色">
        <Swatches value={value.bg} onChange={(v) => patch({ bg: v })} items={BG_OPTIONS} />
      </Row>
      <Row label="输出格式">
        <Segmented value={value.mime} onChange={(v) => patch({ mime: v })} options={FORMATS} />
      </Row>
      {value.mime === 'png' && <Hint>PNG 只能靠缩尺寸变小，报名系统多数要求 JPG。</Hint>}
    </Panel>
  );
}

/** 定位到目标像素并铺底色，压不进目标体积时后续还会整体缩小 */
function build(img: ImageBitmap | HTMLCanvasElement, keepSize: boolean, tw: number, th: number, bg: string) {
  const w = iw(img);
  const h = ih(img);
  let body: HTMLCanvasElement;
  if (keepSize) {
    body = resize(img, w, h);
  } else {
    const c = coverCrop(w, h, tw / th);
    body = resize(cropTo(img, c.sx, c.sy, c.sw, c.sh), tw, th);
  }
  if (!bg) return body;
  const cv = makeCanvas(body.width, body.height);
  const g = cv.getContext('2d')!;
  g.fillStyle = bg;
  g.fillRect(0, 0, cv.width, cv.height);
  g.drawImage(body, 0, 0);
  return cv;
}

async function run(files: File[], o: any, ctx: JobCtx): Promise<Out[]> {
  const keep = o.size === 'origin';
  const size = keep ? null : findSize(o.size);
  const [tw, th] = size ? targetOf(size) : [0, 0];
  const bg = BG_COLORS.find((b) => b.id === o.bg)?.value ?? '';
  const mime = o.mime === 'png' ? 'image/png' : 'image/jpeg';
  const ext = mime === 'image/png' ? 'png' : 'jpg';
  const target = Math.max(5 * 1024, Math.round(o.targetKB * 1024));
  const taken = new Set<string>();
  const outs: Out[] = [];

  for (let i = 0; i < files.length; i++) {
    ctx.tick();
    ctx.progress({ done: i, total: files.length, label: files[i].name });
    const img = await decode(files[i]);
    let cv: HTMLCanvasElement;
    try {
      cv = build(img, keep, tw, th, bg);
    } finally {
      if ('close' in img) img.close();
    }
    // 指定了规格就不能动像素尺寸，只能降质量；压不到就报错，别偷偷缩图
    const r = await compressToTarget(cv, target, mime, keep ? {} : { minScale: 1, minQuality: 0.18 });
    if (!r) {
      const floor = await encode(cv, mime, 0.18);
      throw new Error(
        keep
          ? `${files[i].name} 已降到最低仍 ${fmtBytes(floor.size)}，请放宽目标或改用 JPG`
          : `${files[i].name} 在 ${tw}×${th}px 下最低 ${fmtBytes(floor.size)}，压不到 ${o.targetKB}KB。可放宽目标，或改用「不改变尺寸」允许缩小。`,
      );
    }
    const stem = baseName(files[i].name);
    const name = `${stem}-${size ? size.name.replace(/\s+/g, '') : '压缩'}.${ext}`;
    outs.push({
      name: uniqueName(name, taken),
      blob: r.blob,
      kind: 'image',
      note: `${r.cv.width}×${r.cv.height}px · ${mime === 'image/png' ? '无损' : `质量 ${Math.round(r.quality * 100)}`} · ${fmtBytes(r.blob.size)}`,
    });
    await ctx.breathe();
  }
  return outs;
}

const tool: ToolDef = {
  id: 'idphoto-compress',
  name: '证件照片压缩',
  desc: '按尺寸+底色+目标体积出证件照',
  zone: 'compress',
  icon: '🪪',
  accept: 'image/*',
  multiple: true,
  inputHint: '报名系统卡体积时用，比如要求 100KB 以内',
  defaults: { size: 'one', targetKB: 100, bg: 'white', mime: 'jpg' },
  Controls,
  run,
};

export default tool;

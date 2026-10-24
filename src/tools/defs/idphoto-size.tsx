import { Hint, Panel, Row, Segmented, Select, Swatches } from '../../ui/controls';
import type { ControlsProps, Out, ToolDef } from '../types';
import type { JobCtx } from '../../core/jobs';
import { coverCrop, cropTo, decode, encode, fitInside, ih, iw, makeCanvas, resize } from '../../core/images';
import { BG_COLORS, findSize, ID_SIZE_GROUPS, ID_SIZES, mm2px, SHEETS } from '../../core/presets';
import type { IdSize } from '../../core/presets';
import { baseName, uniqueName } from '../../core/format';

const PX_SIZE = (s: IdSize) => !!s.note?.startsWith('按像素');

/** 目标像素：像素制式直接按 mm 给出的像素，其余按 300dpi 换算 */
function targetOf(s: IdSize): [number, number] {
  return PX_SIZE(s) ? [s.mm[0], s.mm[1]] : s.px;
}

function labelOf(s: IdSize) {
  const [w, h] = targetOf(s);
  return PX_SIZE(s)
    ? { id: s.id, name: `${s.name} ${w}×${h}px` }
    : { id: s.id, name: `${s.name} ${s.mm[0]}×${s.mm[1]}mm`, note: `${w}×${h}px` };
}

const GROUPS = ID_SIZE_GROUPS.map((g) => ({
  label: g,
  items: ID_SIZES.filter((s) => s.group === g).map(labelOf),
}));

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
      <Row label="底色">
        <Swatches value={value.bg} onChange={(v) => patch({ bg: v })} items={BG_OPTIONS} />
      </Row>
      <Row label="构图">
        <Segmented
          value={value.mode}
          onChange={(v) => patch({ mode: v })}
          options={[
            { value: 'crop', label: '居中裁切' },
            { value: 'stretch', label: '拉伸填充' },
            { value: 'pad', label: '留白适配' },
          ]}
        />
      </Row>
      <Row label="输出格式">
        <Segmented value={value.mime} onChange={(v) => patch({ mime: v })} options={FORMATS} />
      </Row>
      <Row label="排版打印页" hint="多张同尺寸照片铺满相纸">
        <Segmented
          value={value.sheet}
          onChange={(v) => patch({ sheet: v })}
          options={[
            { value: '', label: '不开' },
            { value: '5in', label: '5寸' },
            { value: '6in', label: '6寸' },
            { value: 'a4', label: 'A4' },
          ]}
        />
      </Row>
      {value.mode === 'pad' && value.bg === 'none' && value.mime === 'jpg' && (
        <Hint>不铺底时空隙会被填成黑色，留白多请改用 PNG。</Hint>
      )}
    </Panel>
  );
}

/** 把一张图变成目标画布：铺底色 + 按构图方式放入 */
function compose(img: ImageBitmap | HTMLCanvasElement, mode: string, tw: number, th: number, bg: string) {
  const w = iw(img);
  const h = ih(img);
  let body: HTMLCanvasElement;
  if (mode === 'crop') {
    const c = coverCrop(w, h, tw / th);
    body = resize(cropTo(img, c.sx, c.sy, c.sw, c.sh), tw, th);
  } else if (mode === 'stretch') {
    body = resize(img, tw, th);
  } else {
    const [fw, fh] = fitInside(w, h, tw, th);
    body = resize(img, fw, fh);
  }
  const cv = makeCanvas(tw, th);
  const g = cv.getContext('2d')!;
  if (bg) {
    g.fillStyle = bg;
    g.fillRect(0, 0, tw, th);
  }
  g.drawImage(body, Math.round((tw - body.width) / 2), Math.round((th - body.height) / 2));
  return cv;
}

async function run(files: File[], o: any, ctx: JobCtx): Promise<Out[]> {
  const size = findSize(o.size);
  const [tw, th] = targetOf(size);
  const bg = BG_COLORS.find((b) => b.id === o.bg)?.value ?? '';
  const mime = o.mime === 'png' ? 'image/png' : 'image/jpeg';
  const ext = mime === 'image/png' ? 'png' : 'jpg';
  const stem = size.name.replace(/\s+/g, '');
  const sheet = SHEETS.find((s) => s.id === o.sheet);
  const gap = mm2px(3);
  const cols = sheet ? Math.floor((sheet.px[0] + gap) / (tw + gap)) : 0;
  const rows = sheet ? Math.floor((sheet.px[1] + gap) / (th + gap)) : 0;
  if (sheet && (cols < 1 || rows < 1)) {
    throw new Error(`${sheet.name} 放不下 ${tw}×${th}px，请改用 A4 或关掉排版`);
  }
  const taken = new Set<string>();
  const outs: Out[] = [];
  const bodies: HTMLCanvasElement[] = [];

  for (let i = 0; i < files.length; i++) {
    ctx.tick();
    ctx.progress({ done: i, total: files.length, label: files[i].name });
    const img = await decode(files[i]);
    try {
      const cv = compose(img, o.mode, tw, th, bg);
      const blob = await encode(cv, mime, 0.92);
      outs.push({
        name: uniqueName(`${baseName(files[i].name)}-${stem}.${ext}`, taken),
        blob,
        kind: 'image',
        note: PX_SIZE(size) ? `${tw}×${th}px` : `${tw}×${th}px · ${size.mm[0]}×${size.mm[1]}mm`,
      });
      if (sheet) bodies.push(cv);
    } finally {
      if ('close' in img) img.close();
    }
    await ctx.breathe();
  }

  if (sheet && bodies.length) {
    ctx.progress({ done: files.length, total: files.length + 1, label: '排版中' });
    const [pw, ph] = sheet.px;
    const per = cols * rows;
    const ox = Math.round((pw - (cols * tw + (cols - 1) * gap)) / 2);
    const oy = Math.round((ph - (rows * th + (rows - 1) * gap)) / 2);
    const cv = makeCanvas(pw, ph);
    const g = cv.getContext('2d')!;
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, pw, ph);
    for (let k = 0; k < per; k++) {
      ctx.tick();
      const src = bodies[k % bodies.length];
      g.drawImage(src, ox + (k % cols) * (tw + gap), oy + Math.floor(k / cols) * (th + gap));
    }
    const blob = await encode(cv, mime, 0.92);
    const short = sheet.name.replace('相纸', '');
    outs.push({
      name: uniqueName(`证件照排版-${stem}-${short}.${ext}`, taken),
      blob,
      kind: 'image',
      note: `${pw}×${ph}px · ${per} 张`,
    });
    await ctx.breathe();
  }

  return outs;
}

const tool: ToolDef = {
  id: 'idphoto-size',
  name: '证件尺寸修改',
  desc: '改成标准证件照像素尺寸',
  zone: 'compress',
  icon: '📐',
  accept: 'image/*',
  multiple: true,
  inputHint: '选多张时逐个输出，可再拼一页排版',
  defaults: { size: 'one', bg: 'white', mode: 'crop', mime: 'jpg', sheet: '' },
  Controls,
  run,
};

export default tool;

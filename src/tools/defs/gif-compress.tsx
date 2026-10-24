import { Hint, Panel, Row, Segmented } from '../../ui/controls';
import type { ControlsProps, Out, ToolDef } from '../types';
import type { JobCtx } from '../../core/jobs';
import { fmtBytes, suffixName } from '../../core/format';

const LEVELS: Record<string, string> = {
  clear: '-O1 --lossy=20',
  balance: '-O2 --lossy=60',
  small: '-O3 --lossy=120',
  tiny: '-O3 --lossy=200 --colors 64',
};

const SCALES: Record<string, string> = {
  none: '',
  s80: '--scale 0.8',
  s60: '--scale 0.6',
  s40: '--scale 0.4',
};

function Controls({ value, patch }: ControlsProps) {
  return (
    <Panel>
      <Row label="压缩力度">
        <Segmented
          value={value.level}
          onChange={(v) => patch({ level: v })}
          options={[
            { value: 'clear', label: '清晰优先' },
            { value: 'balance', label: '均衡' },
            { value: 'small', label: '体积小' },
            { value: 'tiny', label: '极限' },
          ]}
        />
      </Row>
      <Row label="缩放">
        <Segmented
          value={value.scale}
          onChange={(v) => patch({ scale: v })}
          options={[
            { value: 'none', label: '不缩放' },
            { value: 's80', label: '80%' },
            { value: 's60', label: '60%' },
            { value: 's40', label: '40%' },
          ]}
        />
      </Row>
      <Row label="抽帧">
        <Segmented
          value={value.skip}
          onChange={(v) => patch({ skip: v })}
          options={[
            { value: 'off', label: '不抽帧' },
            { value: 'half', label: '每隔一帧保留' },
          ]}
        />
      </Row>
      {(value.level === 'small' || value.level === 'tiny') && <Hint>文件越大越慢，10MB 以上请耐心等待。</Hint>}
    </Panel>
  );
}

type GifInfo = { w: number; h: number; frames: number };

/** 读头部与图像描述符，拿到画布尺寸和帧数 */
async function gifInfo(blob: Blob): Promise<GifInfo> {
  const b = new Uint8Array(await blob.arrayBuffer());
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const none = { w: 0, h: 0, frames: 0 };
  if (b.length < 14 || b[0] !== 0x47 || b[1] !== 0x49 || b[2] !== 0x46) return none;
  const skipList = (from: number) => {
    let p = from;
    while (p < b.length && b[p] !== 0) p += b[p] + 1;
    return p + 1;
  };
  let p = 6;
  const w = dv.getUint16(p, true);
  const h = dv.getUint16(p + 2, true);
  const packed = dv.getUint8(p + 4);
  p += 7;
  if (packed & 0x80) p += 3 * (1 << ((packed & 7) + 1));
  let frames = 0;
  while (p < b.length) {
    const mark = b[p++];
    if (mark === 0x3b) break;
    if (mark === 0x21) p = skipList(p + 1);
    else if (mark === 0x2c) {
      if (p + 10 > b.length) break;
      const flag = dv.getUint8(p + 8);
      p += 9;
      if (flag & 0x80) p += 3 * (1 << ((flag & 7) + 1));
      p = skipList(p + 1);
      frames++;
    } else break;
  }
  return { w, h, frames };
}

async function run(files: File[], o: any, ctx: JobCtx): Promise<Out[]> {
  const gifsicle = (await import('gifsicle-wasm-browser' as any)).default;
  const taken = new Set<string>();
  const outs: Out[] = [];

  for (let i = 0; i < files.length; i++) {
    ctx.tick();
    ctx.progress({ done: i, total: files.length, label: files[i].name });
    const f = files[i];
    if (f.type && f.type !== 'image/gif') throw new Error(`${f.name} 不是 GIF，无法处理`);
    const src = await gifInfo(f);
    if (!src.frames) throw new Error(`${f.name} 读不到 GIF 帧，换个文件试试`);

    const base = [LEVELS[o.level] ?? LEVELS.balance, SCALES[o.scale] ?? ''].filter(Boolean);
    const odd: number[] = [];
    if (o.skip === 'half' && src.frames > 3) {
      for (let k = 1; k < src.frames; k += 2) odd.push(k);
    }
    // 帧号从 0 开始；gifsicle 的多帧选择器是空格分隔的独立 token，不认 #1,3,5
    const dropOdd = odd.length ? `--delete ${odd.map((k) => `#${k}`).join(' ')}` : '';
    // gifsicle 的帧选择器要跟在图片名后面，写在前面会被当成无效参数并静默忽略
    const runFlags = async (flags: string[], withDelete: boolean) => {
      const res = await gifsicle.run({
        input: [{ file: f, name: 'in.gif' }],
        command: [`${flags.join(' ')} in.gif${withDelete && dropOdd ? ' ' + dropOdd : ''} -o /out/out.gif`],
      });
      return Array.isArray(res) && res.length ? (res[0] as Blob) : null;
    };

    let blob: Blob | null = null;
    let dropped = false;
    if (dropOdd) {
      try {
        blob = await runFlags(base, true);
      } catch {
        blob = null;
      }
      if (!blob) dropped = true;
    }
    if (!blob) blob = await runFlags(base, false);
    if (!blob) throw new Error(`${f.name} 处理失败，试改用清晰优先或关掉缩放`);

    const info = await gifInfo(blob);
    if (dropOdd && info.frames >= src.frames) dropped = true;
    outs.push({
      name: suffixName(f.name, '压缩', taken),
      blob,
      kind: 'image',
      note: `${info.w}×${info.h} · ${info.frames} 帧 · ${fmtBytes(f.size)} → ${fmtBytes(blob.size)}${dropped ? ' · 未抽帧' : ''}`,
    });
    await ctx.breathe();
  }
  return outs;
}

const tool: ToolDef = {
  id: 'gif-compress',
  name: 'GIF 压缩',
  desc: '降色/抽帧/缩放',
  zone: 'compress',
  icon: '🌀',
  accept: 'image/gif,.gif',
  multiple: true,
  inputHint: '只支持 .gif',
  defaults: { level: 'balance', scale: 'none', skip: 'off' },
  Controls,
  run,
};

export default tool;

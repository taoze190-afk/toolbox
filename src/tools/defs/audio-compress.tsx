import { Hint, Panel, Row, Segmented, Toggle } from '../../ui/controls';
import type { ControlsProps, Out, ToolDef } from '../types';
import type { JobCtx } from '../../core/jobs';
import { baseName, fmtSec, uniqueName } from '../../core/format';

const RATES = [
  { value: 0, label: '原始' },
  { value: 22050, label: '22050 Hz' },
  { value: 16000, label: '16000 Hz' },
];

const KBS = [32, 48, 64, 96, 128, 192];

function Controls({ value, patch }: ControlsProps) {
  return (
    <Panel>
      <Row label="码率" hint="kbps">
        <Segmented
          value={value.kbps}
          onChange={(v) => patch({ kbps: v })}
          options={KBS.map((k) => ({ value: k, label: `${k}` }))}
        />
      </Row>
      <Row label="采样率">
        <Segmented value={value.rate} onChange={(v) => patch({ rate: v })} options={RATES} />
      </Row>
      <Row label="单声道" hint="语音类建议开">
        <Toggle value={value.mono} onChange={(v) => patch({ mono: v })} label="合并为一个声道" />
      </Row>
      <Hint>输出 MP3，码率越低越省空间。</Hint>
    </Panel>
  );
}

/** Float32 转 Int16，lamejs 只吃 Int16 */
function to16(src: Float32Array, off: number, len: number): Int16Array {
  const out = new Int16Array(len);
  for (let i = 0; i < len; i++) {
    const v = src[off + i];
    const s = Math.max(-1, Math.min(1, Number.isFinite(v) ? v : 0));
    out[i] = Math.round(s * 0x7fff);
  }
  return out;
}

async function readAudio(file: File): Promise<AudioBuffer> {
  const ac = new AudioContext();
  try {
    const raw = await file.arrayBuffer();
    return await ac.decodeAudioData(raw);
  } catch {
    throw new Error(`${file.name} 本机解不开，先转成 WAV 或 MP3 再试`);
  } finally {
    ac.close().catch(() => {});
  }
}

/** 一次离线渲染同时完成重采样和降声道 */
async function reshape(audio: AudioBuffer, rate: number, mono: boolean): Promise<AudioBuffer> {
  const channels = mono ? 1 : Math.min(2, audio.numberOfChannels);
  if (rate === audio.sampleRate && channels === audio.numberOfChannels) return audio;
  const oc = new OfflineAudioContext(channels, Math.max(1, Math.ceil(audio.duration * rate)), rate);
  const src = oc.createBufferSource();
  src.buffer = audio;
  src.connect(oc.destination);
  return oc.startRendering();
}

async function encodeMp3(audio: AudioBuffer, kbps: number, ctx: JobCtx): Promise<BlobPart[]> {
  const { Mp3Encoder } = await import('@breezystack/lamejs');
  const ch = Math.min(2, audio.numberOfChannels);
  const enc = new Mp3Encoder(ch, audio.sampleRate, kbps);
  const left = audio.getChannelData(0);
  const right = ch > 1 ? audio.getChannelData(1) : null;
  const total = left.length;
  const CHUNK = 1152 * 8;
  const parts: BlobPart[] = [];

  for (let pos = 0; pos < total; pos += CHUNK) {
    ctx.tick();
    const len = Math.min(CHUNK, total - pos);
    const l = to16(left, pos, len);
    const piece = right ? enc.encodeBuffer(l, to16(right, pos, len)) : enc.encodeBuffer(l);
    // lamejs 返回共享缓冲区的视图，逐字节拷出来才能留着
    if (piece.length) parts.push(new Uint8Array(piece));
    ctx.progress({ done: pos + len, total, label: '编码中' });
    await ctx.breathe();
  }
  const end = enc.flush();
  if (end.length) parts.push(new Uint8Array(end));
  return parts;
}

async function run(files: File[], o: any, ctx: JobCtx): Promise<Out[]> {
  const taken = new Set<string>();
  const outs: Out[] = [];

  for (let i = 0; i < files.length; i++) {
    ctx.tick();
    ctx.progress({ done: i, total: files.length, label: files[i].name });
    const decoded = await readAudio(files[i]);
    const audio = await reshape(decoded, o.rate || decoded.sampleRate, !!o.mono);
    const parts = await encodeMp3(audio, o.kbps, ctx);
    const blob = new Blob(parts, { type: 'audio/mpeg' });
    outs.push({
      name: uniqueName(`${baseName(files[i].name)}.mp3`, taken),
      blob,
      kind: 'audio',
      note: `${fmtSec(audio.duration)} · ${o.kbps} kbps · ${audio.sampleRate} Hz`,
    });
  }
  return outs;
}

const tool: ToolDef = {
  id: 'audio-compress',
  name: '音频压缩',
  desc: '重编码降低码率',
  zone: 'compress',
  icon: '🎵',
  accept: 'audio/*',
  multiple: true,
  inputHint: '输出统一为 MP3',
  defaults: { kbps: 64, rate: 0, mono: true },
  Controls,
  run,
};

export default tool;

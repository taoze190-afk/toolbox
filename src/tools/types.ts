import type { ComponentType } from 'react';
import type { JobCtx } from '../core/jobs';

export type OutKind = 'image' | 'pdf' | 'doc' | 'sheet' | 'slides' | 'audio' | 'archive' | 'text';

export type Out = {
  name: string;
  blob: Blob;
  kind: OutKind;
  note?: string;
};

export type Zone = 'compress' | 'convert';

export type ControlsProps = { value: any; patch: (p: Record<string, unknown>) => void };

export type ToolDef = {
  id: string;
  name: string;
  desc: string;
  zone: Zone;
  icon: string;
  accept: string;
  multiple: boolean;
  /** 输入数量说明，显示在选择按钮下方 */
  inputHint?: string;
  defaults: Record<string, unknown>;
  Controls?: ComponentType<ControlsProps>;
  run: (files: File[], opts: any, ctx: JobCtx) => Promise<Out[]>;
  /** 需要服务器才能高保真完成时，界面上给出提示 */
  serverHint?: string;
};

export const ZONES: { id: Zone; name: string; sub: string }[] = [
  { id: 'compress', name: '压缩专区', sub: '图片 / 证件照 / PDF / 尺寸 / 音频 / GIF' },
  { id: 'convert', name: '转换专区', sub: 'PDF / Word / Excel / PPT / 图片 互转' },
];

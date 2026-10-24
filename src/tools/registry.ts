import type { ToolDef } from './types';

import imageCompress from './defs/image-compress';
import idphotoCompress from './defs/idphoto-compress';
import pdfCompress from './defs/pdf-compress';
import idphotoSize from './defs/idphoto-size';
import audioCompress from './defs/audio-compress';
import gifCompress from './defs/gif-compress';

import pdfToWord from './defs/pdf-to-word';
import pdfToLongImg from './defs/pdf-to-longimg';
import pdfToPages from './defs/pdf-to-pages';
import wordToPdf from './defs/word-to-pdf';
import imgToPdf from './defs/img-to-pdf';
import excelToPdf from './defs/excel-to-pdf';
import pptToPdf from './defs/ppt-to-pdf';
import pdfToPpt from './defs/pdf-to-ppt';
import pdfToExcel from './defs/pdf-to-excel';
import imgToWord from './defs/img-to-word';
import imgToExcel from './defs/img-to-excel';

export const TOOLS: ToolDef[] = [
  imageCompress,
  idphotoCompress,
  pdfCompress,
  idphotoSize,
  audioCompress,
  gifCompress,

  pdfToWord,
  pdfToLongImg,
  pdfToPages,
  wordToPdf,
  imgToPdf,
  excelToPdf,
  pptToPdf,
  pdfToPpt,
  pdfToExcel,
  imgToWord,
  imgToExcel,
];

export const toolById = (id: string) => TOOLS.find((t) => t.id === id);

/** 首页和侧栏共用的一套过滤：名称、说明、分区名都参与匹配 */
export function filterTools(q: string): ToolDef[] {
  const k = q.trim().toLowerCase();
  if (!k) return TOOLS;
  const zoneName = (z: ToolDef['zone']) => (z === 'compress' ? '压缩' : '转换');
  return TOOLS.filter((t) => `${t.name}${t.desc}${zoneName(t.zone)}${t.id}`.toLowerCase().includes(k));
}

import fs from 'node:fs';

const LIST = [
  ['idphoto-compress', '证件照片压缩', '按尺寸+底色+目标体积出证件照', 'compress', '🪪', 'image/*', true],
  ['pdf-compress', 'PDF 压缩', '降低页面图像分辨率与质量', 'compress', '📉', 'application/pdf,.pdf', false],
  ['idphoto-size', '证件尺寸修改', '改成标准证件照像素尺寸', 'compress', '📐', 'image/*', true],
  ['audio-compress', '音频压缩', '重编码降低码率', 'compress', '🎵', 'audio/*', true],
  ['gif-compress', 'GIF 压缩', '降色/抽帧/缩放', 'compress', '🌀', 'image/gif,.gif', true],
  ['pdf-to-word', 'PDF 转 Word', '抽取文字生成 docx', 'convert', '📝', 'application/pdf,.pdf', false],
  ['pdf-to-longimg', 'PDF 转长图', '所有页拼成一张竖长图', 'convert', '📏', 'application/pdf,.pdf', false],
  ['word-to-pdf', 'Word 转 PDF', 'docx 转 PDF', 'convert', '📄', '.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document', true],
  ['excel-to-pdf', 'Excel 转 PDF', '表格渲染成 PDF', 'convert', '📊', '.xlsx,.xls', true],
  ['ppt-to-pdf', 'PPT 转 PDF', '幻灯片转 PDF', 'convert', '📽️', '.pptx', true],
  ['pdf-to-ppt', 'PDF 转 PPT', '每页做成一张幻灯片', 'convert', '🖥️', 'application/pdf,.pdf', false],
  ['pdf-to-excel', 'PDF 转 Excel', '按坐标还原表格', 'convert', '🗂️', 'application/pdf,.pdf', false],
  ['img-to-word', '图片转 Word', '离线 OCR 识别成文档', 'convert', '🔤', 'image/*', true],
  ['img-to-excel', '图片转 Excel', '离线 OCR 识别表格', 'convert', '🧮', 'image/*', true],
];

for (const [id, name, desc, zone, icon, accept, multiple] of LIST) {
  const p = `src/tools/defs/${id}.tsx`;
  if (fs.existsSync(p) && !fs.readFileSync(p, 'utf8').includes('尚未实现')) {
    console.log(`skip ${id}（已有实现）`);
    continue;
  }
  const body = `import type { Out, ToolDef } from '../types';

async function run(): Promise<Out[]> {
  throw new Error('${name}：尚未实现');
}

const tool: ToolDef = {
  id: '${id}',
  name: '${name}',
  desc: '${desc}',
  zone: '${zone}',
  icon: '${icon}',
  accept: '${accept}',
  multiple: ${multiple},
  defaults: {},
  run,
};

export default tool;
`;
  fs.writeFileSync(`src/tools/defs/${id}.tsx`, body);
}
console.log('stubs written:', LIST.length);

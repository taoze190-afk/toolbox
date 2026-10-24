export const DPI = 300;
export const mm2px = (mm: number, dpi = DPI) => Math.round((mm / 25.4) * dpi);

export type IdSize = {
  id: string;
  name: string;
  mm: [number, number];
  px: [number, number];
  note?: string;
  group: string;
};

const S = (id: string, name: string, mw: number, mh: number, group: string, note?: string): IdSize => ({
  id,
  name,
  mm: [mw, mh],
  px: [mm2px(mw), mm2px(mh)],
  note,
  group,
});

export const ID_SIZES: IdSize[] = [
  S('one', '一寸', 25, 35, '常用'),
  S('two', '二寸', 35, 49, '常用'),
  S('small-one', '小一寸', 22, 32, '常用'),
  S('big-one', '大一寸', 33, 48, '常用'),
  S('small-two', '小二寸', 35, 45, '常用'),
  S('big-two', '大二寸', 35, 53, '常用'),
  S('three', '三寸', 55, 84, '常用'),

  S('idcard', '身份证', 26, 32, '证件卡证'),
  S('social', '社保卡', 26, 32, '证件卡证'),
  S('driver', '驾驶证', 22, 32, '证件卡证'),
  S('work', '工作证', 25, 35, '证件卡证'),
  S('student', '学生证', 25, 35, '证件卡证'),

  S('passport', '中国护照', 33, 48, '签证护照'),
  S('visa-us', '美国签证 2×2in', 51, 51, '签证护照'),
  S('visa-schengen', '申根签证', 35, 45, '签证护照'),
  S('visa-jp', '日本签证', 35, 35, '签证护照'),
  S('visa-kr', '韩国签证', 35, 45, '签证护照'),
  S('visa-th', '泰国签证', 40, 60, '签证护照'),
  S('visa-cn', '中国签证', 35, 45, '签证护照'),

  S('exam-cet', '四六级 CET', 144, 192, '考试报名', '按像素 144×192'),
  S('exam-ncre', '计算机等级 NCRE', 120, 160, '考试报名', '按像素 120×160'),
  S('exam-teacher', '教师资格证', 295, 413, '考试报名'),
  S('exam-postgrad', '研究生报名', 480, 640, '考试报名', '按像素 480×640'),
  S('exam-cpa', '注册会计师', 178, 220, '考试报名', '按像素 178×220'),
  S('exam-civil', '公务员考试', 295, 413, '考试报名'),
  S('exam-law', '法考', 413, 579, '考试报名'),
  S('exam-putonghua', '普通话测试', 390, 567, '考试报名'),

  S('marriage', '结婚登记', 413, 626, '其他', '需红底'),
  S('resume', '简历照', 295, 413, '其他'),
  S('health', '体检表', 260, 378, '其他'),
  S('visa-greencard', '美国绿卡抽签', 51, 51, '签证护照'),
];

/** 像素制式（px 直接给定，不走 mm） */
export const PX_SIZES: IdSize[] = ID_SIZES.filter((s) => s.note?.startsWith('按像素'));

export const BG_COLORS = [
  { id: 'none', name: '原图', value: '' },
  { id: 'white', name: '白底', value: '#ffffff' },
  { id: 'blue', name: '蓝底', value: '#438edb' },
  { id: 'red', name: '红底', value: '#d9001b' },
  { id: 'gray', name: '灰底', value: '#d7d7d7' },
] as const;

export type Sheet = { id: string; name: string; mm: [number, number]; px: [number, number] };

export const SHEETS: Sheet[] = [
  { id: '5in', name: '5寸相纸', mm: [127, 89], px: [mm2px(127), mm2px(89)] },
  { id: '6in', name: '6寸相纸', mm: [152, 102], px: [mm2px(152), mm2px(102)] },
  { id: 'a4', name: 'A4', mm: [210, 297], px: [mm2px(210), mm2px(297)] },
];

export const ID_SIZE_GROUPS = ['常用', '证件卡证', '签证护照', '考试报名', '其他'];

export function findSize(id: string): IdSize {
  return ID_SIZES.find((s) => s.id === id) ?? ID_SIZES[0];
}

export const QUALITY_LEVELS = [
  { id: 'max', name: '清晰优先', quality: 0.92, dpi: 200 },
  { id: 'balanced', name: '均衡', quality: 0.78, dpi: 150 },
  { id: 'small', name: '体积小', quality: 0.6, dpi: 110 },
  { id: 'tiny', name: '极限压缩', quality: 0.42, dpi: 84 },
] as const;

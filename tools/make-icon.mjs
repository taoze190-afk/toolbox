// 生成应用图标：自适应图标（Android 8+ 读的是这套）+ 旧版 mipmap + 启动图。
//
// 踩过的坑：只改 ic_launcher.png 是没用的——mipmap-anydpi-v26/ic_launcher.xml 存在时，
// 启动器在 Android 8+ 上用「自适应图标」（背景 + 前景两层，再套圆形/方形遮罩），
// ic_launcher.png 只作为低版本回退。所以前景、背景、遮罩安全区都要一起生成。
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';

// 图形本体（512 视框内的白描线条，无文字、无外部图，避免栅格化踩坑）
const GLYPH = `<g fill="none" stroke="#fff" stroke-width="26" stroke-linejoin="round" stroke-linecap="round">
  <rect x="112" y="196" width="288" height="184" rx="34"/>
  <path d="M206 196 v-34 a50 50 0 0 1 100 0 v34"/>
  <path d="M112 268 h288"/>
  <rect x="228" y="244" width="56" height="52" rx="14" fill="#fff" stroke="none"/>
</g>`;

const C0 = '#5b6cff';
const C1 = '#2a1f7a';
const GRAD = `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
  <stop offset="0" stop-color="${C0}"/><stop offset="1" stop-color="${C1}"/></linearGradient></defs>`;

/** 自适应图标前景只许占中间 66%（安全区），遮罩会切掉外面一圈，所以图形再收一点 */
const FG_SCALE = 0.56;
/** 旧版整图里图形占画布的比例，可以更大方 */
const FULL_SCALE = 0.66;

const place = (body, scale) =>
  `<g transform="translate(${((1 - scale) / 2) * 512} ${((1 - scale) / 2) * 512}) scale(${scale})">${body}</g>`;

const svg = (px, inner) => `<svg width="${px}" height="${px}" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">${inner}</svg>`;

/** 前景层：透明底 + 白图形，落在安全区内 */
const fgSvg = (px) => svg(px, place(GLYPH, FG_SCALE));
/** 整图：渐变底 + 图形。shape 可为 square(圆角) / circle / none */
const fullSvg = (px, shape = 'square') => {
  const bg =
    shape === 'circle'
      ? `<circle cx="256" cy="256" r="256" fill="url(#g)"/>`
      : shape === 'none'
        ? `<rect width="512" height="512" fill="url(#g)"/>`
        : `<rect x="24" y="24" width="464" height="464" rx="108" fill="url(#g)"/>`;
  return svg(px, GRAD + bg + place(GLYPH, FULL_SCALE));
};

const DPI = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
const ADAPTIVE = { mdpi: 108, hdpi: 162, xhdpi: 216, xxhdpi: 324, xxxhdpi: 432 };
const RES = 'android/app/src/main/res';

fs.mkdirSync('assets', { recursive: true });
await sharp(Buffer.from(fullSvg(1024, 'square'))).png().toFile('assets/icon.png');
await sharp(Buffer.from(fullSvg(1024, 'circle'))).png().toFile('assets/icon-round.png');

for (const [dpi, px] of Object.entries(DPI)) {
  const dir = `${RES}/mipmap-${dpi}`;
  fs.mkdirSync(dir, { recursive: true });
  await sharp(Buffer.from(fullSvg(px, 'square'))).png().toFile(`${dir}/ic_launcher.png`);
  await sharp(Buffer.from(fullSvg(px, 'circle'))).png().toFile(`${dir}/ic_launcher_round.png`);
}
for (const [dpi, px] of Object.entries(ADAPTIVE)) {
  const dir = `${RES}/mipmap-${dpi}`;
  fs.mkdirSync(dir, { recursive: true });
  await sharp(Buffer.from(fgSvg(px))).png().toFile(`${dir}/ic_launcher_foreground.png`);
}

// 自适应图标的背景层：模板给的是 @color/ic_launcher_background（白底），换成同一套渐变
fs.writeFileSync(
  `${RES}/drawable/ic_launcher_background.xml`,
  `<?xml version="1.0" encoding="utf-8"?>
<shape xmlns:android="http://schemas.android.com/apk/res/android" android:shape="rectangle">
    <gradient android:type="linear" android:angle="315"
        android:startColor="${C0}" android:endColor="${C1}" />
</shape>
`,
);
for (const f of ['ic_launcher.xml', 'ic_launcher_round.xml']) {
  const p = `${RES}/mipmap-anydpi-v26/${f}`;
  if (!fs.existsSync(p)) throw new Error(`缺 ${p}，自适应图标没地方挂`);
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@drawable/ic_launcher_background" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
</adaptive-icon>
`;
  fs.writeFileSync(p, xml);
}
// 背景改成 drawable 之后这个色值没人引用了，留着只会让人以为图标底色是白的
fs.rmSync(`${RES}/values/ic_launcher_background.xml`, { force: true });

// 启动图：res 下每个 splash.png 按它原来的尺寸重画（Android 会优先取带方向/密度限定的那份）
const SPLASH_BG = '#171a22';
const splashSvg = (w, h) => {
  const side = Math.round(Math.min(w, h) * 0.34);
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${w}" height="${h}" fill="${SPLASH_BG}"/>
  <g transform="translate(${(w - side) / 2} ${(h - side) / 2})">${svg(side, GRAD + `<rect x="24" y="24" width="464" height="464" rx="108" fill="url(#g)"/>` + place(GLYPH, FULL_SCALE))}</g>
</svg>`;
};
let splashes = 0;
for (const d of fs.readdirSync(RES)) {
  const p = path.join(RES, d, 'splash.png');
  if (!d.startsWith('drawable') || !fs.existsSync(p)) continue;
  const m = await sharp(p).metadata();
  await sharp(Buffer.from(splashSvg(m.width, m.height))).png().toFile(p);
  splashes++;
}
await sharp(Buffer.from(splashSvg(2732, 2732))).png().toFile('assets/splash.png');

// 一张对照图：整图 + 两种遮罩下的自适应效果，确认遮罩不会切到图形
const masked = (kind) => {
  const clip = kind === 'circle' ? '<circle cx="256" cy="256" r="256"/>' : '<rect x="28" y="28" width="456" height="456" rx="96"/>';
  return svg(
    320,
    `<defs><clipPath id="c">${clip}</clipPath>${GRAD}</defs>
     <g clip-path="url(#c)"><rect width="512" height="512" fill="url(#g)"/>${place(GLYPH, FG_SCALE)}</g>
     <rect x="2" y="2" width="508" height="508" rx="28" fill="none" stroke="#fff" stroke-opacity=".25" stroke-width="4"/>`,
  );
};
fs.mkdirSync('shots/icons', { recursive: true });
const tiles = [
  await sharp(Buffer.from(fullSvg(320, 'square'))).png().toBuffer(),
  await sharp(Buffer.from(masked('circle'))).png().toBuffer(),
  await sharp(Buffer.from(masked('square'))).png().toBuffer(),
];
await sharp({ create: { width: 320 * 3 + 40, height: 320, channels: 4, background: '#0e1016' } })
  .composite(tiles.map((input, i) => ({ input, top: 0, left: i * 340 })))
  .png()
  .toFile('shots/icons/chosen.png');

console.log(`[icon] 5 档 mipmap + 5 档自适应前景 + 背景层 + ${splashes} 张启动图，对照图 shots/icons/chosen.png`);

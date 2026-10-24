// 出 APK 并校验产物内容 —— 构建日志"成功"不算数，必须解包比对。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { need } from './local.mjs';

const require = createRequire(import.meta.url);
const AdmZip = require('adm-zip');

const JDK = need('jdk');
const SDK = need('androidSdk');
const BUILD_TOOLS = fs.existsSync(`${SDK}/build-tools/35.0.0`) ? '35.0.0' : '34.0.0';
const AAPT2 = `${SDK}/build-tools/${BUILD_TOOLS}/aapt2.exe`;

const log = (m) => console.log(`[apk] ${m}`);

const variant = process.argv.includes('--release') ? 'Release' : 'Debug';
// --test：把 __tk 测试钩子编进包，供 tools/device-verify.mjs 在真机上真跑工具
const withTest = process.argv.includes('--test');

// 1. web 产物
log('vite build');
execFileSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build'], {
  stdio: 'inherit',
  env: { ...process.env, VITE_TK_TEST: withTest ? '1' : '0' },
});
if (!fs.existsSync('dist/index.html')) throw new Error('dist 没产出');

// 2. 静态资源必须齐（缺了会在真机上静默失败）
for (const p of [
  'dist/pdfjs/pdf.worker.min.mjs',
  'dist/pdfjs/cmaps/Adobe-CNS1-0.bcmap',
  'dist/tesseract/worker.min.js',
  'dist/tesseract/core/tesseract-core-simd.wasm.js',
  'dist/tessdata/chi_sim.traineddata',
  'dist/tessdata/eng.traineddata',
]) {
  if (!fs.existsSync(p)) throw new Error(`缺静态资源 ${p}，先跑 node tools/prebuild.mjs`);
}

// 3. 同步进安卓工程
log('cap sync android');
execFileSync(process.execPath, ['node_modules/@capacitor/cli/bin/capacitor', 'sync', 'android'], { stdio: 'inherit' });

// 4. gradle 出包
log(`gradlew assemble${variant}`);
execFileSync('cmd', ['/c', 'gradlew.bat', `:app:assemble${variant}`, '--console=plain'], {
  cwd: 'android',
  env: { ...process.env, JAVA_HOME: JDK, ANDROID_HOME: SDK, ANDROID_SDK_ROOT: SDK },
  stdio: 'inherit',
});

const apk = `android/app/build/outputs/apk/${variant.toLowerCase()}/app-${variant.toLowerCase()}.apk`;
if (!fs.existsSync(apk)) throw new Error(`找不到 APK：${apk}`);

// 5. 校验包里的东西，而不是校验构建日志
const zip = new AdmZip(path.resolve(apk));
const entries = zip.getEntries();
const names = entries.map((e) => e.entryName);
const assets = names.filter((f) => f.startsWith('assets/public/'));
if (!assets.length) throw new Error('APK 里没有 assets/public，webDir 没同步进去');

const index = zip.readAsText('assets/public/index.html') ?? '';
if (!index.includes('全能工具箱')) throw new Error('index.html 里没有应用名，webDir 内容不对');

const jsFiles = names.filter((f) => /^assets\/public\/assets\/.*\.js$/.test(f));
const allJs = jsFiles.map((f) => zip.readAsText(f) ?? '').join('');
const expectTools = [
  '图片压缩', '证件照片压缩', 'PDF 压缩', '证件尺寸修改', '音频压缩', 'GIF 压缩',
  'PDF 转 Word', 'PDF 转长图', 'PDF 逐页转图', 'Word 转 PDF', '图片转 PDF',
  'Excel 转 PDF', 'PPT 转 PDF', 'PDF 转 PPT', 'PDF 转 Excel', '图片转 Word', '图片转 Excel',
];
const missing = expectTools.filter((t) => !allJs.includes(t));
if (missing.length) throw new Error(`主包 JS 里缺工具名：${missing.join(', ')}`);

// 6. 版本号要和 package.json 对上
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const badging = execFileSync(AAPT2, ['dump', 'badging', path.resolve(apk)], { encoding: 'utf8' });
const ver = /versionName='([^']+)'/.exec(badging)?.[1];
const label = /application-label:'([^']+)'/.exec(badging)?.[1];
const sizeMB = (fs.statSync(apk).size / 1048576).toFixed(1);
const jsMB = (
  jsFiles.reduce((a, f) => a + (entries.find((e) => e.entryName === f)?.header.size ?? 0), 0) / 1048576
).toFixed(1);
log(`APK ${apk}  ${sizeMB}MB`);
log(`package=${/package: name='([^']+)'/.exec(badging)?.[1]}  versionName=${ver}  label=${label}`);
log(`web 资源 ${assets.length} 个，JS 分片 ${jsFiles.length} 个合计 ${jsMB}MB 未压缩`);
if (ver !== pkg.version) throw new Error(`versionName ${ver} 与 package.json ${pkg.version} 不一致`);

const out = `toolbox-${pkg.version}-${variant.toLowerCase()}${withTest ? '-test' : ''}.apk`;
fs.copyFileSync(apk, out);
log(`已复制到 ${out}`);

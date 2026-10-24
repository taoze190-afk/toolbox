// 假 soffice：只用于本机验证服务逻辑（HTTP/鉴权/排队/子路径/体积限制）。
// pdf 输出会造一个真能解析的最小 PDF，其它格式回吐占位字节。
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const ci = argv.indexOf('--convert-to');
const oi = argv.indexOf('--outdir');
if (ci < 0 || oi < 0) {
  console.error('fake-soffice: 参数不对 ' + argv.join(' '));
  process.exit(1);
}
const fmt = argv[ci + 1];
const outDir = argv[oi + 1];
const input = argv[argv.length - 1];
const name = path.basename(input).replace(/\.\w+$/, '') + '.' + fmt;
fs.mkdirSync(outDir, { recursive: true });

if (fmt === 'pdf') {
  const body =
    '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]>>endobj\n' +
    'trailer<</Root 1 0 R>>\n%%EOF\n';
  fs.writeFileSync(path.join(outDir, name), body);
} else {
  fs.writeFileSync(path.join(outDir, name), Buffer.concat([Buffer.from('FAKE-' + fmt + '-'), fs.readFileSync(input).subarray(0, 4096)]));
}
console.log('fake-soffice: wrote ' + name);

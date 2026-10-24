// 模板 + 两处占位替换。之前把 shell 塞进 JS 字符串数组里拼，被转义咬了三次
// （if [ 少空格、heredoc 误加引号导致 $PORT 不展开、数组元素漏逗号），改成模板文件后没有这类问题。
import fs from 'node:fs';

const tpl = fs.readFileSync('server/install.tpl.sh', 'utf8');
const js = fs.readFileSync('server/convert-server.mjs', 'utf8').trimEnd();
const b64 = fs.readFileSync('server/selftest.docx.b64', 'utf8').trim();

if (!js.includes('convert-to')) throw new Error('服务端源文件不对');
for (const mark of ['%%SERVER_JS%%', '%%SELFTEST_B64%%']) {
  if (!tpl.includes(mark)) throw new Error('模板缺占位 ' + mark);
}
// 内嵌内容里不能出现 heredoc 结束标记，否则会把代码段提前截断
if (js.includes('\nCONVJS') || b64.includes('\nB64')) throw new Error('内嵌内容撞上了 heredoc 结束标记');

const out = tpl.replace('%%SERVER_JS%%', js).replace('%%SELFTEST_B64%%', b64);
fs.writeFileSync('server/install.sh', out, { mode: 0o644 });
console.log('server/install.sh 已生成', (out.length / 1024).toFixed(0), 'KB');

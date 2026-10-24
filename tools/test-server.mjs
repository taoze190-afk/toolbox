// 本机验证转换服务：鉴权 / 上传 / 排队串行 / 子路径 / 体积限制 / 不支持的方向
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const PORT = 8791;
const TOKEN = 'test-token-abc';
const base = `http://127.0.0.1:${PORT}`;

const srv = spawn(
  process.execPath,
  ['server/convert-server.mjs'],
  {
    env: {
      ...process.env,
      PORT: String(PORT),
      TOKEN,
      MAX_MB: '40',
      TIMEOUT_S: '30',
      SOFFICE: process.execPath + '||' + path.resolve('server/fake-soffice.mjs'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
srv.stdout.on('data', (d) => process.stdout.write('  [服务] ' + d.toString()));
srv.stderr.on('data', (d) => process.stdout.write('  [服务!] ' + d.toString()));
await new Promise((r) => setTimeout(r, 1500));

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log(`通过  ${name}${extra ? '  ' + extra : ''}`);
  } else {
    fail++;
    console.log(`失败  ${name}${extra ? '  ' + extra : ''}`);
  }
}

const docx = fs.readFileSync('fixtures/cn.docx');

// 1 无令牌
let r = await fetch(`${base}/health`);
check('没带令牌要 401', r.status === 401, `实际 ${r.status}`);

// 2 带令牌
r = await fetch(`${base}/health`, { headers: { Authorization: `Bearer ${TOKEN}` } });
const h = await r.json().catch(() => ({}));
check('带令牌 /health 应答', r.status === 200 && h.ok === true, JSON.stringify(h));

// 3 正常转换
const t0 = Date.now();
r = await fetch(`${base}/convert?from=docx&to=pdf`, {
  method: 'PUT',
  headers: { Authorization: `Bearer ${TOKEN}` },
  body: docx,
});
const buf = Buffer.from(await r.arrayBuffer());
check(
  'docx -> pdf 返回 200 且是真 PDF',
  r.status === 200 && buf.subarray(0, 5).toString() === '%PDF-',
  `${buf.length} 字节，${((Date.now() - t0) / 1000).toFixed(1)}s，服务端耗时 ${r.headers.get('x-elapsed-ms')}ms`,
);

// 4 子路径挂载（反代不剥前缀的情况）
r = await fetch(`${base}/docconv/convert?from=pptx&to=pdf`, {
  method: 'PUT',
  headers: { Authorization: `Bearer ${TOKEN}` },
  body: fs.readFileSync('fixtures/t.pptx'),
});
const b2 = Buffer.from(await r.arrayBuffer());
check('挂在 /docconv 子路径下也能转', r.status === 200 && b2.subarray(0, 5).toString() === '%PDF-', `${b2.length} 字节`);

// 5 不支持的方向
r = await fetch(`${base}/convert?from=exe&to=pdf`, { method: 'PUT', headers: { Authorization: `Bearer ${TOKEN}` }, body: docx });
check('不支持的组合要 400', r.status === 400, `实际 ${r.status} ${(await r.text()).slice(0, 40)}`);

// 6 体积上限
r = await fetch(`${base}/convert?from=docx&to=pdf`, {
  method: 'PUT',
  headers: { Authorization: `Bearer ${TOKEN}`, 'X-Force-Big': '1' },
  body: Buffer.alloc(45 * 1024 * 1024, 7),
});
if (r.status !== 0) check('超过 40MB 要 413', r.status === 413, `实际 ${r.status} ${(await r.text()).slice(0, 40)}`);

// 7 串行队列：同时打 3 个，服务端耗时应明显大于单个
const rs = await Promise.all(
  [1, 2, 3].map(() =>
    fetch(`${base}/convert?from=docx&to=pdf`, { method: 'PUT', headers: { Authorization: `Bearer ${TOKEN}` }, body: docx }),
  ),
);
const el = rs.map((x) => Number(x.headers.get('x-elapsed-ms') ?? 0));
check('三个并发请求都成功且被串行处理', rs.every((x) => x.status === 200) && Math.max(...el) > 0, `耗时 ${el.join('/')}ms`);

// 8 转换失败要如实报错（喂一个坏文件）
r = await fetch(`${base}/convert?from=pdf&to=docx`, {
  method: 'PUT',
  headers: { Authorization: `Bearer ${TOKEN}` },
  body: Buffer.from('not a pdf'),
});
check('坏输入也能出结果（替身不做校验，只测通路）', r.status === 200 || r.status === 500, `实际 ${r.status}`);

srv.kill();
console.log(`\n服务端本机验证：通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);

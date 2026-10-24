// 真跑验证：起静态夹具服务 + 无头 Chrome，通过 CDP 直接调用工具引擎，再用 node 侧解析产物内容。
// 用法： node tools/verify.mjs            跑全部
//        node tools/verify.mjs image-compress pdf-to-pages   只跑指定工具
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
import { opt } from './local.mjs';

const CHROME = opt('chrome') ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const APP = 'http://127.0.0.1:5175/';
const FIX_PORT = 5199;
const CDP_PORT = 9333;
const OUT = 'out';
fs.mkdirSync(OUT, { recursive: true });

// ---------------- 夹具静态服务 ----------------
const fixServer = http.createServer((req, res) => {
  const p = path.join('fixtures', decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, ''));
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (!p.startsWith('fixtures' + path.sep) && p !== 'fixtures') {
    res.writeHead(403).end();
    return;
  }
  if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) {
    res.writeHead(404).end('no fixture');
    return;
  }
  res.setHeader('Content-Type', MIME[path.extname(p).slice(1)] ?? 'application/octet-stream');
  fs.createReadStream(p).pipe(res);
});
import { MIME, GEN, INSPECT, CASES, must, setOutDir, inspectImage, inspectPdf, inspectDocx, inspectXlsx, inspectPptx } from './lib.mjs';
const fix = (name) => `http://127.0.0.1:${FIX_PORT}/${name}`;

setOutDir(OUT);
// ---------------- CDP ----------------
let ws, msgId = 0;
const pending = new Map();
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    const t = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP 超时 ${method}`));
    }, 240_000);
    pending.set(id, (v) => {
      clearTimeout(t);
      v?.error ? reject(new Error(JSON.stringify(v.error))) : resolve(v.result);
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evalJs(expression, timeoutMs = 240_000) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`求值超时 ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    pending.set(id, (v) => {
      clearTimeout(t);
      if (v?.error) return reject(new Error(JSON.stringify(v.error)));
      const r = v.result;
      if (r.exceptionDetails) {
        const e = r.exceptionDetails;
        return reject(new Error(e.exception?.description ?? e.text ?? '页面异常'));
      }
      resolve(r.result.value);
    });
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  });
}
async function waitFor(expr, ms, what) {
  const t0 = Date.now();
  for (;;) {
    try {
      if (await evalJs(expr, 20_000)) return;
    } catch {
      /* 页面还在换 */
    }
    if (Date.now() - t0 > ms) throw new Error(`等不到 ${what}`);
    await new Promise((r) => setTimeout(r, 400));
  }
}
// ---------------- 主流程 ----------------
const only = process.argv.slice(2);
const cases = only.length ? CASES.filter((c) => only.includes(c.id)) : CASES;

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${path.join(os.tmpdir(), 'tk-chrome-profile')}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--allow-file-access-from-files',
    '--autoplay-policy=no-user-gesture-required',
    '--remote-debugging-address=127.0.0.1',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

process.on('exit', () => {
  try {
    chrome.kill();
    fixServer.close();
  } catch {
    /* 已退出 */
  }
});

const t0 = Date.now();
let pass = 0;
let fail = 0;
const rows = [];

try {
  fixServer.listen(FIX_PORT, '127.0.0.1');
  // 拿 CDP webSocketDebuggerUrl
  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    await new Promise((r) => setTimeout(r, 300));
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    } catch {
      /* chrome 还没起 */
    }
  }
  if (!target) throw new Error('Chrome 调试端口没起来');

  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = (e) => j(new Error('CDP 连接失败 ' + (e?.message ?? '')));
  });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  };
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: APP });
  await waitFor('!!window.__tk', 60_000, '__tk 测试钩子');

  const tools = await evalJs('window.__tk.tools');
  console.log(`已注册工具 ${tools.length} 个：${tools.map((t) => t.id).join(', ')}`);
  console.log('');

  for (const c of cases) {
    const label = c.name;
    const started = Date.now();
    let lastErr = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        // 子代理还在改文件时 vite 会整页刷新，评估上下文会凭空消失——重载后重试
        await waitFor('!!window.__tk', 40_000, '__tk 测试钩子');
        const filesExpr = c.files
          .map((f) =>
            GEN[f]
              ? `(await (${GEN[f]}))`
              : `(await (async()=>{const r=await fetch('${fix(f)}');const b=await r.blob();return new File([b],'${f}',{type:b.type||'application/octet-stream'});})())`,
          )
          .join(',');
        const ms = c.timeoutMs ?? 240_000;
        const run = () =>
          evalJs(
            `(async()=>{const files=[${filesExpr}];
              try { return await __tk.run(${JSON.stringify(c.id)},files,${JSON.stringify(c.opts ?? {})}); }
              catch(e){ return {__err:String(e&&e.message||e),__files:files.map(f=>({cls:Object.prototype.toString.call(f),n:String(f.name),s:f.size,t:String(f.type)}))}; }
            })()`,
            ms,
          );
        if (c.expectError) {
          let msg = '';
          const res = await run();
          if (res && res.__err) msg = res.__err;
          must(c.expectError.test(msg), `该报错却没报错（或报错文案不对）：${msg.slice(0, 160)}`);
          pass++;
          rows.push({ 状态: '通过', 用例: label, 耗时ms: Date.now() - started, 产物数: 0, 详情: `按预期报错：${msg.slice(0, 120)}` });
          lastErr = null;
          break;
        }
        const raw = await run();
        if (raw && raw.__err) throw new Error(`${raw.__err}｜输入=${JSON.stringify(raw.__files)}`);
        const outs = raw;
        if (!Array.isArray(outs)) throw new Error('工具没有返回结果数组');
        const insp = [];
        for (const [oi, o] of outs.entries()) {
          const fn = INSPECT[o.kind];
          if (fn) insp.push(await fn(o.b64, o.name));
          fs.writeFileSync(path.join(OUT, `case${rows.length + 1}-${o.name}`), Buffer.from(o.b64, 'base64'));
          void oi;
        }
        const detail = c.check(outs, insp);
        pass++;
        rows.push({ 状态: '通过', 用例: label, 耗时ms: Date.now() - started, 产物数: outs.length, 详情: JSON.stringify(detail) });
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        const transient = /navigated or closed|not defined|上下文|超时|Execution context/i.test(String(e.message));
        if (!transient || attempt === 3) break;
        console.log(`  ↻ ${label} 第 ${attempt} 次被打断（${String(e.message).slice(0, 60)}），重载重试`);
        try {
          await send('Page.navigate', { url: APP });
        } catch {
          /* 正在换页 */
        }
        await new Promise((r) => setTimeout(r, 1200));
      }
    }
    if (lastErr) {
      fail++;
      rows.push({ 状态: '失败', 用例: label, 耗时ms: Date.now() - started, 产物数: 0, 详情: String(lastErr.message).slice(0, 300) });
    }
    const last = rows[rows.length - 1];
    console.log(`${last.状态}  ${label}  ${last.详情}`);
  }

  console.log('\n产物内容抽查：');
  for (const f of fs.readdirSync(OUT)) {
    if (f.startsWith('_probe') || f === 'report.json') continue;
    const p = path.join(OUT, f);
    const size = fs.statSync(p).size;
    let info = '';
    try {
      if (/\.jpg|\.png|\.webp|\.gif$/i.test(f)) info = JSON.stringify(await inspectImage(fs.readFileSync(p).toString('base64')));
      else if (/\.pdf$/i.test(f)) info = JSON.stringify(await inspectPdf(fs.readFileSync(p).toString('base64')));
      else if (/\.docx$/i.test(f)) info = JSON.stringify(await inspectDocx(fs.readFileSync(p).toString('base64')));
      else if (/\.xlsx$/i.test(f)) info = JSON.stringify(await inspectXlsx(fs.readFileSync(p).toString('base64')));
      else if (/\.pptx$/i.test(f)) info = JSON.stringify(await inspectPptx(fs.readFileSync(p).toString('base64')));
    } catch (e) {
      info = '解析失败: ' + e.message;
    }
    console.log(`  ${f}  ${(size / 1024).toFixed(1)}KB  ${info.slice(0, 260)}`);
  }

  fs.writeFileSync(
    path.join(OUT, 'report.json'),
    JSON.stringify({ at: new Date().toISOString(), pass, fail, totalMs: Date.now() - t0, rows }, null, 2),
  );
  console.log(`\n通过 ${pass} / 失败 ${fail}，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s，报告 out/report.json`);
} catch (e) {
  console.error('验证台异常：', e.message);
  fail++;
} finally {
  chrome.kill();
  ws?.close();
  fixServer.close();
}
process.exit(fail ? 1 : 0);

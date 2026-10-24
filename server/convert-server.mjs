#!/usr/bin/env node
// 自建文档转换服务：只监听你指定的地址，单并发排队，跑 LibreOffice headless。
// 设计约束（跑在你那台 J1900 / 3.7G 内存的机器上）：
//   - 同一时刻只允许一个转换，避免把内存压穿
//   - 每个转换有硬超时，超时直接杀进程树
//   - 临时文件用完即删，不累积
//   - 需要 Bearer token，否则 401
// 用法： TOKEN=xxx PORT=29000 node convert-server.mjs   （默认只监听 127.0.0.1）
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import os from 'node:os';

const PORT = Number(process.env.PORT ?? 8790);
// 只绑回环：必须经反向代理进来，否则路由器上任何到这台机器该端口的映射都会绕过 nginx 和证书
const HOST = process.env.HOST ?? '127.0.0.1';
const TOKEN = process.env.TOKEN ?? '';
// 允许 'node||/abs/fake.mjs' 形式：本机没有 LibreOffice 时用替身验证服务逻辑
const SOFFICE_RAW = process.env.SOFFICE ?? (process.platform === 'win32' ? 'soffice.exe' : 'soffice');
const [SOFFICE, ...SOFFICE_PRE] = SOFFICE_RAW.includes('||') ? SOFFICE_RAW.split('||') : [SOFFICE_RAW];
const MAX_BYTES = Number(process.env.MAX_MB ?? 40) * 1024 * 1024;
const TIMEOUT_MS = Number(process.env.TIMEOUT_S ?? 300) * 1000;
const TMP = path.join(os.tmpdir(), 'docconv');
fs.mkdirSync(TMP, { recursive: true });

if (!TOKEN) {
  console.error('必须设 TOKEN 环境变量，否则任何人都能拿你的服务器转文件');
  process.exit(2);
}

/** 支持的转换方向；不在表里的一律拒绝，避免变成任意命令执行器 */
// 只放实测能过的方向。pdf→docx / pdf→xlsx 看着合理但 LibreOffice 做不到：
// PDF 被导进 Draw，而 Draw 没有导出 Word/Excel 的过滤器，只会报 no export filter。
const ALLOW = new Set(['docx>pdf', 'pptx>pdf', 'xlsx>pdf', 'doc>pdf', 'ppt>pdf', 'xls>pdf']);

const OUT_MIME = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

const log = (...a) => console.log(new Date().toISOString(), ...a);

/** 简单串行队列：一次只跑一个，后来的排队，队列有上限 */
let running = false;
const queue = [];
const MAX_QUEUE = 8;

function next() {
  if (running) return;
  const job = queue.shift();
  if (!job) return;
  running = true;
  job();
}

function enqueue(job) {
  if (queue.length >= MAX_QUEUE) {
    job(new Error('队列已满，稍后再试'), null);
    return;
  }
  queue.push(() =>
    job(null, () => {
      running = false;
      setImmediate(next);
    }),
  );
  next();
}

function runSoffice(inFile, outDir, to) {
  return new Promise((resolve, reject) => {
    // 只用实测过能被接受的参数组合。多加的 --nolockcheck / --nodefault / --env:UserInstallation
    // 会让 soffice 直接吐帮助信息并退出（转换根本没发生），所以一律不用。
    const args = ['--headless', '--norestore', '--convert-to', to, '--outdir', outDir, inFile];
    let child;
    try {
      child = spawn(SOFFICE, [...SOFFICE_PRE, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      reject(e);
      return;
    }
    let err = '';
    child.stderr.on('data', (d) => (err += d.toString()));
    const timer = setTimeout(() => {
      killTree(child);
      reject(new Error('转换超时'));
    }, TIMEOUT_MS);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', () => {
      clearTimeout(timer);
      const out = fs.readdirSync(outDir).find((f) => f.toLowerCase().endsWith('.' + to));
      if (!out) reject(new Error('没产出文件 ' + (err.slice(0, 160) || to)));
      else resolve(path.join(outDir, out));
    });
  });
}

function killTree(child) {
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)]);
    else child.kill('SIGKILL');
  } catch {
    /* 已经退了 */
  }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let over = false;
    req.on('data', (c) => {
      if (over) return; // 已经超限：继续收但直接丢掉，别掐连接
      size += c.length;
      if (size > limit) {
        over = true;
        chunks.length = 0;
        reject(new Error('文件过大'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!over) resolve(Buffer.concat(chunks));
    });
    req.on('error', (e) => {
      if (!over) reject(e);
    });
  });
}

const srv = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }
  const auth = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  if (auth !== TOKEN) {
    res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' }).end('未授权');
    return;
  }

  const p = u.pathname.replace(/\/+$/, '');
  if (p === '/health' || p.endsWith('/health')) {
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, busy: running, queued: queue.length }));
    return;
  }

  if (!(p === '/convert' || p.endsWith('/convert')) || req.method !== 'PUT') {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('只有 PUT <base>/convert?from=docx&to=pdf');
    return;
  }

  const from = (u.searchParams.get('from') ?? '').toLowerCase();
  const to = (u.searchParams.get('to') ?? '').toLowerCase();
  if (!ALLOW.has(`${from}>${to}`)) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end(`不支持 ${from} -> ${to}`);
    return;
  }

  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const dir = path.join(TMP, id);
  fs.mkdirSync(dir, { recursive: true });
  const t0 = Date.now();

  try {
    const body = await readBody(req, MAX_BYTES);
    const inFile = path.join(dir, 'input.' + from);
    fs.writeFileSync(inFile, body);
    log(`${id} 收到 ${from}->${to} ${(body.length / 1024).toFixed(0)}KB，排队中`);

    const outPath = await new Promise((resolve, reject) => {
      enqueue(async (qerr, done) => {
        if (qerr) return reject(qerr);
        try {
          log(`${id} 开始转换`);
          resolve(await runSoffice(inFile, dir, to));
        } catch (e) {
          reject(e);
        } finally {
          done();
        }
      });
    });

    const buf = fs.readFileSync(outPath);
    log(`${id} 完成 ${buf.length} 字节，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    res.writeHead(200, {
      'Content-Type': OUT_MIME[to] ?? 'application/octet-stream',
      'Content-Length': String(buf.length),
      'X-Elapsed-Ms': String(Date.now() - t0),
    });
    res.end(buf);
  } catch (e) {
    const msg = String(e.message ?? e);
    log(`${id} 失败 ${msg}`);
    res.writeHead(/过大/.test(msg) ? 413 : 500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(msg);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

srv.listen(PORT, HOST, () => {
  log(`转换服务已启动 http://${HOST}:${PORT}  并发=1  上限=${MAX_BYTES / 1048576}MB  超时=${TIMEOUT_MS / 1000}s`);
  log(`soffice = ${SOFFICE}`);
});

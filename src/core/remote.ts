import type { Out } from '../tools/types';
import type { JobCtx } from './jobs';
import { hasRemote, loadSettings, type Provider } from './settings';

const CC_API = 'https://api.cloudconvert.com/v2';
const CV_API = 'https://v2.convertapi.com';

export type Dir = 'docx>pdf' | 'pptx>pdf' | 'xlsx>pdf' | 'pdf>docx' | 'pdf>xlsx' | 'pdf>pptx';

export const DIR_LABEL: Record<Dir, string> = {
  'docx>pdf': 'Word 转 PDF',
  'pptx>pdf': 'PPT 转 PDF',
  'xlsx>pdf': 'Excel 转 PDF',
  'pdf>docx': 'PDF 转 Word',
  'pdf>xlsx': 'PDF 转 Excel',
  'pdf>pptx': 'PDF 转 PPT',
};

const KIND_OUT: Record<string, Out['kind']> = { pdf: 'pdf', docx: 'doc', xlsx: 'sheet', pptx: 'slides' };

const stem = (n: string) => n.replace(/\.\w+$/, '');

async function json(url: string, key: string, init?: RequestInit): Promise<any> {
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${key}`, ...(init?.body ? { 'Content-Type': 'application/json' } : {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 160)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('服务返回不是 JSON');
  }
}

/** 设置页用它验密钥 / 探活 */
export async function verifyKey(
  key: string,
  provider: Provider = 'cloudconvert',
): Promise<{ ok: true; label: string } | { ok: false; why: string }> {
  const k = key.trim();
  if (!k) return { ok: false, why: '还没填密钥' };
  try {
    if (provider === 'self') {
      const base = (loadSettings().baseUrl || '').replace(/\/$/, '');
      if (!/^https?:\/\//.test(base)) return { ok: false, why: '先把服务地址填上' };
      const r = await fetch(base + '/health', { headers: { Authorization: `Bearer ${k}` } });
      if (!r.ok) return { ok: false, why: '服务应答 ' + r.status };
      const j = await r.json().catch(() => ({}));
      return { ok: true, label: '已连通 · ' + (j?.busy ? '正在转换，会排队' : '空闲') };
    }
    if (provider === 'convertapi') {
      const d = await json(`${CV_API}/user`, k);
      const credits = d?.Credits ?? d?.credits;
      return { ok: true, label: typeof credits === 'number' ? `已启用 · 剩余 ${credits} 点数` : '已启用' };
    }
    const d = await json(`${CC_API}/user`, k);
    const u = d?.data ?? {};
    const limit = Number(u.conversion_limit ?? 0);
    const used = Number(u.conversions ?? 0);
    return { ok: true, label: limit ? `已启用 · 本期 ${used}/${limit}` : '已启用' };
  } catch (e) {
    return { ok: false, why: String((e as Error).message).slice(0, 160) };
  }
}

async function viaCloudConvert(dir: Dir, file: File, ctx: JobCtx, key: string): Promise<Out> {
  const [src, dst] = dir.split('>');
  const job = await json(
    `${CC_API}/jobs`,
    key,
    {
      method: 'POST',
      body: JSON.stringify({
        tasks: {
          imp: { operation: 'import/upload' },
          conv: { operation: 'convert', input: 'imp', input_format: src, output_format: dst },
          exp: { operation: 'export', input: 'conv', input_format: dst },
        },
      }),
    },
  );
  const id = job?.data?.id;
  const imp = job?.data?.tasks?.find((t: any) => t.operation === 'import/upload');
  if (!id || !imp?.form?.url) throw new Error('服务没返回上传入口');

  ctx.progress({ done: 1, total: 4, label: `${DIR_LABEL[dir]}：上传` });
  const fd = new FormData();
  for (const [k, v] of Object.entries(imp.form.parameters ?? {})) if (k !== 'file') fd.append(k, String(v));
  fd.append('file', file, file.name);
  const up = await fetch(imp.form.url, { method: 'POST', body: fd });
  if (!up.ok && up.status !== 201 && up.status !== 204) throw new Error(`上传失败 HTTP ${up.status}`);

  ctx.progress({ done: 2, total: 4, label: `${DIR_LABEL[dir]}：服务器转换中` });
  const deadline = Date.now() + 180_000;
  let status = 'queued';
  let tasks: any[] = [];
  while (Date.now() < deadline) {
    ctx.tick();
    const j = await json(`${CC_API}/jobs/${id}`, key);
    status = j?.data?.status ?? status;
    tasks = j?.data?.tasks ?? [];
    if (status === 'finished' || status === 'error') break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (status !== 'finished') {
    const f = tasks.find((t: any) => t.status === 'error');
    throw new Error(f ? `转换失败：${f.error?.message ?? '未知原因'}` : '转换超时');
  }
  const exp = tasks.find((t: any) => t.operation === 'export');
  const url = exp?.url ?? exp?.result?.url;
  if (!url) throw new Error('服务没给出结果地址');
  ctx.progress({ done: 3, total: 4, label: `${DIR_LABEL[dir]}：取回结果` });
  const blob = await (await fetch(url)).blob();
  if (blob.size < 512) throw new Error('结果文件异常（过小）');
  return { name: `${stem(file.name)}.${dst}`, blob, kind: KIND_OUT[dst], note: '服务商转换' };
}

async function viaConvertApi(dir: Dir, file: File, ctx: JobCtx, key: string): Promise<Out> {
  const [src, dst] = dir.split('>');
  ctx.progress({ done: 1, total: 3, label: `${DIR_LABEL[dir]}：上传并转换` });
  const fd = new FormData();
  fd.append('File', file, file.name);
  fd.append('StoreFile', 'true');
  const res = await fetch(`${CV_API}/convert/${src}/to/${dst}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: fd,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 160)}`);
  const j = JSON.parse(text);
  const url = j?.Files?.[0]?.Url;
  if (!url) throw new Error('服务没给出结果地址');
  ctx.progress({ done: 2, total: 3, label: `${DIR_LABEL[dir]}：取回结果` });
  const blob = await (await fetch(url)).blob();
  if (blob.size < 512) throw new Error('结果文件异常（过小）');
  return { name: `${stem(file.name)}.${dst}`, blob, kind: KIND_OUT[dst], note: '服务商转换' };
}

/** 自建服务：PUT /convert?from=docx&to=pdf，请求体是文件本身，响应体是结果 */
async function viaSelfHost(dir: Dir, file: File, ctx: JobCtx, base: string, token: string): Promise<Out> {
  const [src, dst] = dir.split('>');
  const url = base.replace(/\/$/, '') + '/convert?from=' + src + '&to=' + dst;
  ctx.progress({ done: 1, total: 3, label: `${DIR_LABEL[dir]}：上传` });
  const res = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` },
    body: file,
  });
  if (!res.ok) throw new Error(`服务返回 ${res.status} ${(await res.text()).slice(0, 120)}`);
  ctx.progress({ done: 2, total: 3, label: `${DIR_LABEL[dir]}：接收结果` });
  const blob = await res.blob();
  if (blob.size < 512) throw new Error('结果文件异常（过小）');
  return { name: `${stem(file.name)}.${dst}`, blob, kind: KIND_OUT[dst], note: '自建服务' };
}

export type Remote = { ok: true; out: Out } | { ok: false; why: string };

/** 失败一律返回 ok:false，让调用方回落到本机实现，绝不把用户卡住 */
export async function convertRemote(dir: Dir, file: File, ctx: JobCtx): Promise<Remote> {
  const s = loadSettings();
  const key = s.ccKey.trim();
  if (!key) return { ok: false, why: '未配置服务密钥' };
  if (s.provider === 'self' && !/^https?:\/\//.test(s.baseUrl)) return { ok: false, why: '自建服务地址没填' };
  if (file.size > s.maxRemoteMB * 1024 * 1024) return { ok: false, why: `超过 ${s.maxRemoteMB}MB` };
  ctx.progress({ done: 0, total: 4, label: `${DIR_LABEL[dir]}：提交任务` });
  try {
    const out =
      s.provider === 'self'
        ? await viaSelfHost(dir, file, ctx, s.baseUrl, key)
        : s.provider === 'convertapi'
          ? await viaConvertApi(dir, file, ctx, key)
          : await viaCloudConvert(dir, file, ctx, key);
    out.note = `${out.note} · ${(out.blob.size / 1024).toFixed(0)} KB`;
    ctx.progress({ done: 4, total: 4, label: '完成' });
    return { ok: true, out };
  } catch (e) {
    if ((e as Error).message === '已取消') throw e;
    return { ok: false, why: String((e as Error).message).slice(0, 140) };
  }
}

/**
 * 配了服务就走远端，失败的那些文件回落到本机实现。
 * 入口先判 hasRemote()：没配密钥时行为与接服务前完全一致。
 */
export async function runWithFallback(
  dir: Dir,
  files: File[],
  ctx: JobCtx,
  local: (files: File[], ctx: JobCtx) => Promise<Out[]>,
): Promise<Out[]> {
  if (!hasRemote()) return local(files, ctx);
  const outs: Out[] = [];
  const rest: File[] = [];
  let why = '';
  for (const f of files) {
    ctx.tick();
    const r = await convertRemote(dir, f, ctx);
    if (r.ok) outs.push(r.out);
    else {
      rest.push(f);
      why = r.why;
    }
  }
  if (rest.length) {
    const loc = await local(rest, ctx);
    loc.forEach((x, i) => {
      x.note = i === 0 && why ? `${x.note ?? ''} · 本机（${why}）` : `${x.note ?? ''} · 本机`;
    });
    outs.push(...loc);
  }
  return outs;
}

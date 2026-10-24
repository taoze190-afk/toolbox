import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Out, ToolDef } from '../tools/types';
import { makeCtx, isCancelled, errMsg, type Progress } from '../core/jobs';
import { fmtBytes } from '../core/format';
import { saveBlob, shareBlob, isNative } from '../core/io';
import { ToolIcon } from './icons';
import { go } from './router';
import { cx } from './layout';

type Status = 'idle' | 'running' | 'done' | 'error';

function swap<T>(arr: T[], i: number, d: number): T[] {
  const j = i + d;
  if (j < 0 || j >= arr.length) return arr;
  const c = arr.slice();
  [c[i], c[j]] = [c[j], c[i]];
  return c;
}

export default function ToolView({ tool, wide }: { tool: ToolDef; wide: boolean }) {
  const [files, setFiles] = useState<File[]>([]);
  const [opts, setOpts] = useState<any>(() => structuredClone(tool.defaults));
  const [status, setStatus] = useState<Status>('idle');
  const [prog, setProg] = useState<Progress | null>(null);
  const [outs, setOuts] = useState<Out[]>([]);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [dragging, setDragging] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const toastTimer = useRef<number | null>(null);

  const patch = useCallback((p: Record<string, unknown>) => setOpts((s: any) => ({ ...s, ...p })), []);

  useEffect(() => {
    document.title = tool.name;
    return () => {
      document.title = '全能工具箱';
      abortRef.current?.abort();
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, [tool.name]);

  const flash = (m: string) => {
    setToast(m);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(''), 2600);
  };

  const addFiles = (list: FileList | File[] | null) => {
    if (!list?.length) return;
    const incoming = Array.from(list);
    const accepted = incoming.filter((f) => acceptsFile(f, tool.accept));
    const rejected = incoming.length - accepted.length;
    if (!accepted.length) {
      flash(`文件格式不支持，请选择 ${acceptLabel(tool.accept)}`);
      return;
    }
    setFiles((prev) => {
      const merged = tool.multiple ? [...prev, ...accepted] : accepted.slice(0, 1);
      return merged.filter((f, i, all) => all.findIndex((x) => sameFile(x, f)) === i);
    });
    if (rejected) flash(`已忽略 ${rejected} 个不支持的文件`);
    setOuts([]);
    setError('');
    setStatus('idle');
  };

  const totalIn = files.reduce((a, f) => a + f.size, 0);

  const run = async () => {
    if (!files.length) return;
    const ac = new AbortController();
    abortRef.current = ac;
    setStatus('running');
    setError('');
    setOuts([]);
    setProg({ done: 0, total: 1, label: '开始' });
    try {
      const ctx = makeCtx(setProg, ac.signal);
      const res = await tool.run(files, opts, ctx);
      setOuts(res);
      setStatus('done');
      const used = new Set([tool.id, ...JSON.parse(localStorage.getItem('tk-used') || '[]')]);
      localStorage.setItem('tk-used', JSON.stringify([...used]));
    } catch (e) {
      if (isCancelled(e)) {
        setStatus('idle');
        flash('已取消');
      } else {
        setError(errMsg(e));
        setStatus('error');
      }
    } finally {
      abortRef.current = null;
      setProg(null);
    }
  };

  const saveAll = async () => {
    if (!isNative() && outs.length > 1) {
      try {
        const { default: JSZip } = await import('jszip');
        const zip = new JSZip();
        outs.forEach((o) => zip.file(o.name, o.blob));
        flash('正在打包…');
        const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 5 } });
        const r = await saveBlob(`${tool.name}-结果.zip`, blob);
        if (!r.ok) setError(`保存失败：${r.error}`);
        else flash(`已打包 ${outs.length} 个文件`);
      } catch (e) {
        setError(`打包失败：${errMsg(e)}`);
      }
      return;
    }
    let ok = 0;
    for (const o of outs) {
      const r = await saveBlob(o.name, o.blob);
      if (r.ok) ok++;
      else setError(`保存失败：${r.error}`);
    }
    if (ok) flash(isNative() ? `已存 ${ok} 个到应用目录，可用「分享」发出` : `已开始下载 ${ok} 个文件`);
  };

  const picker = (
    <div
      className={cx('bg-card rounded-xl2 border border-line p-3 transition-colors', dragging && 'drop-active')}
      onDragEnter={(e) => { e.preventDefault(); setDragging(true); }}
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false); }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        addFiles(e.dataTransfer.files);
      }}
    >
      <input
        ref={inputRef}
        type="file"
        accept={tool.accept}
        multiple={tool.multiple}
        className="hidden"
        onChange={(e) => {
          addFiles(e.target.files);
          e.target.value = '';
        }}
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        className="w-full min-h-24 py-4 px-3 rounded-xl border border-dashed border-line bg-soft/70 text-[14px] font-medium active:scale-[.99] hover:border-accent/45 hover:bg-accent/5 transition"
      >
        <span className="block text-accent text-[22px] leading-none mb-2" aria-hidden="true">＋</span>
        <span className="block">{dragging ? '松开即可添加' : files.length ? '继续添加文件' : `选择${tool.multiple ? '文件（可多选）' : '文件'}`}</span>
        <span className="hidden sm:block text-[11px] text-mute font-normal mt-1">也可以把文件拖到这里</span>
      </button>
      {tool.inputHint && <p className="text-[11px] text-mute mt-2">{tool.inputHint}</p>}

      {files.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {files.map((f, i) => (
            <li key={i} className="flex items-center gap-2.5 bg-soft rounded-lg px-2.5 py-2">
              {f.type.startsWith('image/') ? (
                <Thumb file={f} />
              ) : (
                <span className="w-9 h-9 rounded-md bg-soft2 grid place-items-center shrink-0 text-mute">
                  <ToolIcon id={tool.id} className="w-[18px] h-[18px]" />
                </span>
              )}
              <span className="flex-1 min-w-0">
                <span className="block text-[13px] truncate">{f.name}</span>
                <span className="block text-[11px] text-mute">{fmtBytes(f.size)}</span>
              </span>
              {tool.multiple && files.length > 1 && (
                <span className="flex flex-col shrink-0">
                  <IconBtn label="上移" disabled={i === 0} onClick={() => setFiles((p) => swap(p, i, -1))}>
                    ▲
                  </IconBtn>
                  <IconBtn label="下移" disabled={i === files.length - 1} onClick={() => setFiles((p) => swap(p, i, 1))}>
                    ▼
                  </IconBtn>
                </span>
              )}
              <button
                type="button"
                onClick={() => setFiles((p) => p.filter((_, j) => j !== i))}
                className="w-7 h-7 grid place-items-center text-mute text-[16px]"
                aria-label="移除"
              >
                ×
              </button>
            </li>
          ))}
          <li className="flex items-center justify-between text-[11px] text-mute pt-1">
            <span>共 {files.length} 个 · {fmtBytes(totalIn)}</span>
            <button
              type="button"
              onClick={() => { setFiles([]); setOuts([]); setError(''); setStatus('idle'); }}
              className="px-2 py-1 rounded-md hover:bg-soft2 hover:text-ink"
            >
              清空
            </button>
          </li>
        </ul>
      )}
    </div>
  );

  // 有侧栏时可视宽度被吃掉 262px，所以容器上限按 wide 分档，不能靠 2xl 这种视口断点
  const inner = wide ? 'max-w-[1060px]' : 'max-w-[680px]';

  return (
    <div className="h-full flex flex-col">
      <header className="shrink-0 safe-t bg-bg/92 backdrop-blur px-2 pb-2.5 flex items-center gap-1 border-b border-line">
        {!wide && (
          <button type="button" onClick={() => go('/')} className="w-9 h-9 grid place-items-center text-[20px] text-mute">
            ‹
          </button>
        )}
        <div className={cx('flex items-center gap-2 min-w-0', wide && 'px-2')}>
          <ToolIcon id={tool.id} className="w-[18px] h-[18px] shrink-0 text-accent" />
          <div className="text-[15px] font-semibold truncate">{tool.name}</div>
          <div className="text-[11px] text-mute truncate hidden sm:block">{tool.desc}</div>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto px-4 pt-3 pb-6">
        <div className={cx('mx-auto w-full grid gap-3 items-start', inner, wide && 'xl:grid-cols-[minmax(0,1fr)_400px]')}>
          <div className="space-y-3 min-w-0">
            {picker}
            {status === 'done' && outs.length > 0 && <Results outs={outs} totalIn={totalIn} onSaveAll={saveAll} flash={flash} />}
          </div>
          <div className="space-y-3 min-w-0">
            {tool.Controls && (
              <div className="bg-card rounded-xl2 border border-line px-3">
                <tool.Controls value={opts} patch={patch} />
              </div>
            )}
            {tool.serverHint && <p className="text-[12px] leading-relaxed text-mute bg-soft rounded-xl px-3 py-2.5">{tool.serverHint}</p>}
          </div>
        </div>
      </main>

      <footer className="shrink-0 bg-bg/95 backdrop-blur border-t border-line px-4 pt-2.5 safe-b">
        <div className={cx('mx-auto w-full', inner)}>
          {status === 'running' ? (
            <div className="flex items-center gap-3">
              <div className="flex-1">
                <div className="h-1.5 rounded-full bg-soft2 overflow-hidden">
                  <div
                    className="h-full bg-accent transition-[width] duration-200"
                    style={{ width: `${Math.min(100, Math.round(((prog?.done ?? 0) / (prog?.total || 1)) * 100))}%` }}
                  />
                </div>
                <p className="text-[11px] text-mute mt-1.5 truncate">
                  {prog?.label ?? '处理中'} ·{' '}
                  {prog && prog.total > 1 ? `${prog.done}/${prog.total}` : `${Math.round((prog?.done ?? 0) * 100)}%`}
                </p>
              </div>
              <button
                type="button"
                onClick={() => abortRef.current?.abort()}
                className="px-4 py-2.5 rounded-xl bg-soft text-[14px] font-medium"
              >
                取消
              </button>
            </div>
          ) : (
            <>
              {error && <p className="text-[12px] text-bad mb-2 line-clamp-3">{error}</p>}
              <button
                type="button"
                disabled={!files.length}
                onClick={run}
                className="w-full py-3 rounded-xl bg-accent text-white text-[15px] font-semibold disabled:bg-soft2 disabled:text-mute active:scale-[.99]"
              >
                开始处理
              </button>
            </>
          )}
        </div>
      </footer>

      {toast && (
        <div className="fixed left-1/2 -translate-x-1/2 bottom-24 z-20 bg-ink text-bg text-[13px] px-4 py-2 rounded-full shadow-lg">
          {toast}
        </div>
      )}
    </div>
  );
}

function IconBtn({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="w-6 h-5 grid place-items-center text-mute disabled:opacity-25 text-[11px]"
      aria-label={label}
    >
      {children}
    </button>
  );
}

function Thumb({ file }: { file: File }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);
  return url ? <img src={url} alt="" className="w-9 h-9 rounded-md object-cover bg-soft2 shrink-0" /> : <span className="w-9 h-9" />;
}

function Results({
  outs,
  totalIn,
  onSaveAll,
  flash,
}: {
  outs: Out[];
  totalIn: number;
  onSaveAll: () => void;
  flash: (m: string) => void;
}) {
  const totalOut = outs.reduce((a, o) => a + o.blob.size, 0);
  const saved = totalIn > 0 ? Math.round((1 - totalOut / totalIn) * 100) : 0;
  return (
    <div className="bg-card rounded-xl2 border border-line p-3">
      <div className="flex items-center justify-between mb-2.5">
        <span className="text-[14px] font-medium">
          完成 {outs.length} 个
          {saved > 0 && <span className="text-good"> · 省了 {saved}%</span>}
          {saved < 0 && <span className="text-bad"> · 大了 {-saved}%</span>}
        </span>
        {outs.length > 1 && (
          <button type="button" onClick={onSaveAll} className="text-[13px] text-accent font-medium">
            {isNative() ? '全部保存' : '打包下载'}
          </button>
        )}
      </div>
      <ul className="space-y-1.5">
        {outs.map((o, i) => (
          <li key={i} className="flex items-center gap-2.5 bg-soft rounded-lg px-2.5 py-2">
            <OutThumb out={o} fallback={o.name.split('.').pop() ?? ''} />
            <span className="flex-1 min-w-0">
              <span className="block text-[13px] truncate">{o.name}</span>
              <span className="block text-[11px] text-mute truncate">
                {fmtBytes(o.blob.size)}
                {o.note ? ` · ${o.note}` : ''}
              </span>
            </span>
            <button
              type="button"
              onClick={async () => {
                const r = await saveBlob(o.name, o.blob);
                if (!r.ok) flash(`保存失败 ${r.error}`);
                else flash(isNative() ? '已保存' : '已开始下载');
              }}
              className="px-2.5 py-1.5 rounded-lg bg-card border border-line text-[12px]"
            >
              保存
            </button>
            {isNative() && (
              <button
                type="button"
                onClick={() => shareBlob(o.name, o.blob)}
                className="px-2.5 py-1.5 rounded-lg bg-card border border-line text-[12px]"
              >
                分享
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function sameFile(a: File, b: File) {
  return a.name === b.name && a.size === b.size && a.lastModified === b.lastModified;
}

function acceptsFile(file: File, accept: string) {
  const parts = accept.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (!parts.length) return true;
  const name = file.name.toLowerCase();
  const type = file.type.toLowerCase();
  return parts.some((rule) => {
    if (rule.startsWith('.')) return name.endsWith(rule);
    if (rule.endsWith('/*')) return type.startsWith(rule.slice(0, -1));
    return type === rule;
  });
}

function acceptLabel(accept: string) {
  const readable = accept.split(',').map((x) => x.trim()).filter((x) => x.startsWith('.'));
  return readable.length ? readable.join('、') : accept.includes('image/') ? '图片' : accept.includes('audio/') ? '音频' : '匹配的格式';
}

function OutThumb({ out, fallback }: { out: Out; fallback: string }) {
  const url = useMemo(() => (out.kind === 'image' ? URL.createObjectURL(out.blob) : ''), [out]);
  useEffect(() => () => {
    if (url) URL.revokeObjectURL(url);
  }, [url]);
  return url ? (
    <img src={url} alt="" className="w-9 h-9 rounded-md object-cover bg-soft2 shrink-0" />
  ) : (
    <span className="w-9 h-9 rounded-md bg-soft2 grid place-items-center text-[10px] font-semibold uppercase tracking-wide text-mute shrink-0">
      {fallback}
    </span>
  );
}

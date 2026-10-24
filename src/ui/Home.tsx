import { useEffect, useMemo, useState } from 'react';
import { TOOLS, filterTools, toolById } from '../tools/registry';
import { ZONES, type ToolDef } from '../tools/types';
import { ToolIcon } from './icons';
import { go } from './router';
import { hasRemote } from '../core/settings';
import { cx } from './layout';

/** 最近用过：存的是 id 数组，新的往前插 */
function usedIds(): string[] {
  try {
    const a = JSON.parse(localStorage.getItem('tk-used') || '[]') as string[];
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}

export function Card({ tool }: { tool: ToolDef }) {
  const [favorite, setFavorite] = useState(() => favoriteIds().includes(tool.id));
  useEffect(() => {
    const sync = () => setFavorite(favoriteIds().includes(tool.id));
    window.addEventListener('tk-favorites', sync);
    return () => window.removeEventListener('tk-favorites', sync);
  }, [tool.id]);
  return (
    <article className="tool-card group relative bg-card rounded-xl2 border border-line overflow-hidden">
      <button type="button" onClick={() => go(`/t/${tool.id}`)} className="w-full h-full text-left p-3.5 pr-11 active:scale-[.985] transition">
        <span className="w-9 h-9 mb-3 rounded-xl bg-accent/10 grid place-items-center group-hover:bg-accent/15 transition-colors">
          <ToolIcon id={tool.id} className="w-[20px] h-[20px] text-accent" />
        </span>
        <span className="block text-[14px] font-semibold leading-tight">{tool.name}</span>
        <span className="block text-[11px] text-mute leading-relaxed mt-1.5 line-clamp-2">{tool.desc}</span>
      </button>
      <button
        type="button"
        onClick={() => {
          const next = !favorite;
          setFavorite(next);
          setFavoriteId(tool.id, next);
        }}
        className="absolute right-2.5 top-2.5 w-8 h-8 rounded-lg grid place-items-center text-[17px] text-mute hover:bg-soft hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
        aria-label={favorite ? `取消收藏${tool.name}` : `收藏${tool.name}`}
        title={favorite ? '取消收藏' : '收藏'}
      >
        <span aria-hidden="true">{favorite ? '★' : '☆'}</span>
      </button>
    </article>
  );
}

function favoriteIds(): string[] {
  try {
    const ids = JSON.parse(localStorage.getItem('tk-favorites') || '[]');
    return Array.isArray(ids) ? ids : [];
  } catch {
    return [];
  }
}

function setFavoriteId(id: string, on: boolean) {
  const next = new Set(favoriteIds());
  on ? next.add(id) : next.delete(id);
  localStorage.setItem('tk-favorites', JSON.stringify([...next]));
  window.dispatchEvent(new Event('tk-favorites'));
}

export default function Home({ withNav = true }: { withNav?: boolean }) {
  const [q, setQ] = useState('');
  const [favoriteVersion, setFavoriteVersion] = useState(0);
  const used = useMemo(usedIds, []);
  const recents = useMemo(() => used.map(toolById).filter(Boolean).slice(0, 8) as ToolDef[], [used]);
  const favorites = useMemo(
    () => favoriteIds().map(toolById).filter(Boolean) as ToolDef[],
    [favoriteVersion],
  );
  const list = useMemo(() => filterTools(q), [q]);
  const matched = q.trim() ? list : TOOLS;

  useEffect(() => {
    const on = () => setFavoriteVersion((v) => v + 1);
    window.addEventListener('tk-favorites', on);
    return () => window.removeEventListener('tk-favorites', on);
  }, []);

  return (
    <div className="min-h-full">
      {withNav && (
        <header className="safe-t px-4 pb-3">
          <div className="flex items-center gap-2">
            <div className="brand-mark" aria-hidden="true">T</div>
            <h1 className="text-[21px] font-bold tracking-tight">全能工具箱</h1>
          </div>
          <div className="flex items-center justify-between gap-2 mt-0.5">
            <p className="text-[12px] text-mute">文件处理在本机完成，不经过服务器</p>
            <button
              type="button"
              onClick={() => go('/settings')}
              className="shrink-0 text-[12px] px-2.5 py-1 rounded-lg bg-soft text-ink"
            >
              {hasRemote() ? '服务器转换 已开' : '服务器转换 未开'}
            </button>
          </div>
          <label className="search-box mt-4 flex items-center gap-2.5 px-3.5 rounded-xl bg-card border border-line">
            <span className="text-mute text-[16px]" aria-hidden="true">⌕</span>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜索 17 个工具，如 PDF、压缩"
              className="w-full py-3 bg-transparent text-[14px] outline-none"
            />
            {q && <button type="button" onClick={() => setQ('')} className="w-7 h-7 text-mute" aria-label="清空搜索">×</button>}
          </label>
        </header>
      )}

      <main className={cx('px-4 pb-10 mx-auto w-full', withNav ? 'pt-3 max-w-[680px]' : 'pt-4 max-w-[1180px]')}>
        {!q.trim() && favorites.length > 0 && (
          <section className="mb-6">
            <div className="flex items-center gap-2 mb-2.5">
              <h2 className="text-[14px] font-semibold">我的收藏</h2>
              <span className="section-count">{favorites.length}</span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2.5">
              {favorites.map((t) => <Card key={`f-${t.id}`} tool={t} />)}
            </div>
          </section>
        )}

        {!q.trim() && recents.length > 0 && (
          <section className="mb-6">
            <h2 className="text-[13px] font-semibold text-mute mb-2.5">最近使用</h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2.5">
              {recents.map((t) => (
                <Card key={`r-${t.id}`} tool={t} />
              ))}
            </div>
          </section>
        )}

        {ZONES.map((z) => {
          const items = matched.filter((t) => t.zone === z.id);
          if (!items.length) return null;
          return (
            <section key={z.id} className="mb-6">
              <div className="flex items-baseline gap-2 mb-2.5">
                <h2 className="text-[15px] font-semibold">{z.name}</h2>
                <span className="section-count">{items.length}</span>
                <span className="text-[11px] text-mute truncate">{z.sub}</span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2.5">
                {items.map((t) => (
                  <Card key={t.id} tool={t} />
                ))}
              </div>
            </section>
          );
        })}

        {withNav && q.trim() && !matched.length && (
          <p className="text-[13px] text-mute py-8 text-center">没有匹配「{q.trim()}」的工具</p>
        )}
      </main>
    </div>
  );
}

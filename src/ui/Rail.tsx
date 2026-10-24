import { useMemo, useState } from 'react';
import { filterTools } from '../tools/registry';
import { ZONES } from '../tools/types';
import { ToolIcon } from './icons';
import { go } from './router';
import { hasRemote } from '../core/settings';
import { cx } from './layout';

/** 宽屏（平板横屏 / 桌面）左侧的工具目录，替代「首页 → 工具页」的两跳 */
export default function Rail({ active }: { active: string }) {
  const [q, setQ] = useState('');
  const list = useMemo(() => filterTools(q), [q]);

  return (
    <nav className="w-[262px] shrink-0 h-full flex flex-col border-r border-line bg-card">
      <div className="px-3 pb-2 pt-[max(16px,env(safe-area-inset-top))]">
        <button type="button" onClick={() => go('/')} className="w-full text-left px-1">
          <span className="block text-[15px] font-semibold tracking-wide">全能工具箱</span>
          <span className="block text-[11px] text-mute mt-0.5">文件处理在本机完成</span>
        </button>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜工具"
          className="mt-3 w-full px-3 py-2.5 rounded-lg bg-soft text-[13px] outline-none focus:ring-2 ring-accent/40"
        />
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {ZONES.map((z) => {
          const items = list.filter((t) => t.zone === z.id);
          if (!items.length) return null;
          return (
            <div key={z.id} className="mb-2">
              <div className="px-2 pt-1.5 pb-1 text-[11px] text-mute">{z.name}</div>
              {items.map((t) => {
                const on = t.id === active;
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => go(`/t/${t.id}`)}
                    className={cx(
                      'w-full flex items-center gap-2.5 px-2 py-2.5 rounded-lg text-left transition-colors',
                      on ? 'bg-soft2' : 'hover:bg-soft',
                    )}
                  >
                    <ToolIcon id={t.id} className={cx('w-[18px] h-[18px] shrink-0', on ? 'text-accent' : 'text-mute')} />
                    <span className="text-[13px] truncate">{t.name}</span>
                  </button>
                );
              })}
            </div>
          );
        })}
        {q.trim() && !list.length && <p className="px-3 py-6 text-[12px] text-mute">没有匹配「{q.trim()}」的工具</p>}
      </div>

      <div className="border-t border-line p-2 safe-b">
        <button
          type="button"
          onClick={() => go('/settings')}
          className="w-full flex items-center gap-2 px-2.5 py-2.5 rounded-lg bg-soft text-[12px]"
        >
          <span className={cx('w-1.5 h-1.5 rounded-full shrink-0', hasRemote() ? 'bg-good' : 'bg-mute')} />
          <span className="truncate">服务器转换 {hasRemote() ? '已开' : '未开'}</span>
        </button>
      </div>
    </nav>
  );
}

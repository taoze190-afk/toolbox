import { useEffect } from 'react';
import { toolById } from './tools/registry';
import { useHash } from './ui/router';
import { applyTheme, watchTheme } from './core/theme';
import { cx, useWide } from './ui/layout';
import Rail from './ui/Rail';
import Home from './ui/Home';
import ToolView from './ui/ToolView';
import Settings from './ui/Settings';

export default function App() {
  const route = useHash();
  const wide = useWide();

  useEffect(() => {
    applyTheme();
    return watchTheme();
  }, []);

  const tool = route.tool ? toolById(route.tool) : undefined;
  const body = route.settings ? (
    <Settings wide={wide} />
  ) : tool ? (
    <ToolView key={tool.id} tool={tool} wide={wide} />
  ) : (
    <Home withNav={!wide} />
  );

  return (
    <div className="h-screen supports-[height:100dvh]:h-dvh flex overflow-hidden bg-bg text-ink">
      {wide && <Rail active={tool?.id ?? ''} />}
      {/* 工具页自己管滚动（底部操作条要贴住栏底），其余页面整页滚 */}
      <div className={cx('flex-1 min-w-0 flex flex-col', tool && !route.settings ? 'overflow-hidden' : 'overflow-y-auto')}>
        {body}
      </div>
    </div>
  );
}

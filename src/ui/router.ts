import { useEffect, useState } from 'react';

export type Route = { tool?: string; settings?: boolean };

function parse(): Route {
  const h = location.hash.replace(/^#\/?/, '');
  if (h === 'settings') return { settings: true };
  const m = h.match(/^t\/([\w-]+)/);
  return m ? { tool: m[1] } : {};
}

export function go(path: string) {
  location.hash = path;
}

export function useHash(): Route {
  const [r, setR] = useState<Route>(parse);
  useEffect(() => {
    const on = () => setR(parse());
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  return r;
}

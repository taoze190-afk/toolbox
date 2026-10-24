// 多视口 × 明暗主题 的真截图验收：手机 / 平板竖屏 / 平板横屏，各页面都拍一张并量几何。
// 只看"渲染出来了"不够——深色令牌有没有真的覆盖、侧栏该出现时有没有出现、有没有横向溢出，都要量成数字。
// 用法：node tools/ui-shots.mjs   （需要 npm run dev 在 5175）
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

import { opt } from './local.mjs';

const CHROME = opt('chrome') ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const APP = process.env.APP_URL ?? 'http://127.0.0.1:5175/';
const PORT = 9347;
const DIR = 'shots/ui';
fs.mkdirSync(DIR, { recursive: true });

const VIEWPORTS = [
  { id: 'phone', w: 393, h: 852, mobile: true, rail: false },
  { id: 'tab-portrait', w: 834, h: 1112, mobile: true, rail: false },
  { id: 'tab-landscape', w: 1280, h: 800, mobile: false, rail: true },
];
const THEMES = ['light', 'dark'];
const ROUTES = [
  { hash: '', name: 'home' },
  { hash: '#/t/image-compress', name: 'tool-slider' },
  { hash: '#/t/pdf-to-word', name: 'tool-ocr' },
  { hash: '#/settings', name: 'settings' },
];

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${path.join(os.tmpdir(), 'tk-ui-shots')}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    'about:blank',
  ],
  { stdio: 'ignore' },
);
process.on('exit', () => chrome.kill());

let ws, mid = 0;
const pending = new Map();
let target = null;
for (let i = 0; i < 60 && !target; i++) {
  await new Promise((r) => setTimeout(r, 300));
  try {
    target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(
      (t) => t.type === 'page' && t.webSocketDebuggerUrl,
    );
  } catch {
    /* 还没起 */
  }
}
if (!target) throw new Error('Chrome 没起来');
ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('连不上 CDP（10s）')), 10_000);
  ws.onopen = () => (clearTimeout(t), res());
  ws.onerror = () => (clearTimeout(t), rej(new Error('CDP 失败')));
});
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) (0, pending.get(m.id))(m), pending.delete(m.id);
};
function send(method, params = {}) {
  const id = ++mid;
  return new Promise((res, rej) => {
    const t = setTimeout(() => (pending.delete(id), rej(new Error(`CDP 超时 ${method}`))), 60_000);
    pending.set(id, (v) => (clearTimeout(t), v.error ? rej(new Error(JSON.stringify(v.error))) : res(v.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function ev(expr, ms = 30_000) {
  const id = ++mid;
  return new Promise((res, rej) => {
    const t = setTimeout(() => (pending.delete(id), rej(new Error(`求值超时 ${Math.round(ms / 1000)}s`))), ms);
    pending.set(id, (v) => {
      clearTimeout(t);
      if (v.error) return rej(new Error(JSON.stringify(v.error)));
      const r = v.result;
      if (r.exceptionDetails) return rej(new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
      res(r.result.value);
    });
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
  });
}
async function goto(url) {
  await send('Page.navigate', { url });
  await ev(`(async()=>{for(let i=0;i<80;i++){if(document.querySelector('#root')?.firstElementChild) return 1;await new Promise(r=>setTimeout(r,100));}return 0;})()`);
  await ev(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(r,350))))`);
}
const geom = `(()=>{
  const de=document.documentElement, cs=getComputedStyle(document.body);
  const rail=document.querySelector('nav'); const foot=document.querySelector('footer');
  const wide=innerWidth>=1024;
  return {
    w: innerWidth, h: innerHeight,
    overflowX: de.scrollWidth - de.clientWidth,
    theme: de.dataset.theme || '',
    bg: cs.backgroundColor,
    rail: !!rail, railW: rail ? Math.round(rail.getBoundingClientRect().width) : 0,
    railMatchesWide: !!rail === wide,
    footW: foot ? Math.round(foot.getBoundingClientRect().width) : 0,
    footFits: foot ? foot.getBoundingClientRect().right <= innerWidth + 1 : true,
    clipped: (()=>{ const bad=[];
      for (const el of document.querySelectorAll('button, input, select, h1, h2, .truncate')) {
        const r = el.getBoundingClientRect();
        if (r.width && (r.right > innerWidth + 1 || r.left < -1)) bad.push((el.tagName+'.'+(el.className||'')).slice(0,40));
      }
      return bad.slice(0,3); })(),
    text: (document.querySelector('#root')?.innerText || '').replace(/\\s+/g,' ').slice(0, 70),
  };
})()`;

await send('Runtime.enable');
await send('Page.enable');

let pass = 0;
let fail = 0;
const chk = (ok, name, extra = '') => {
  if (ok) { pass++; console.log(`通过  ${name}`); }
  else { fail++; console.log(`失败  ${name}${extra ? '  ' + extra : ''}`); }
};

const bgs = {};
// 只改 hash 的导航不会重载文档，首屏定色脚本就不跑；加个自增 query 强制每次真重载
let seq = 0;
for (const vp of VIEWPORTS) {
  await send('Emulation.setDeviceMetricsOverride', { width: vp.w, height: vp.h, deviceScaleFactor: 2, mobile: vp.mobile });
  for (const theme of THEMES) {
    await goto(APP);
    await ev(`localStorage.setItem('tk.theme','${theme}');1`);
    for (const rt of ROUTES) {
      await goto(`${APP}?s=${++seq}${rt.hash}`);
      const g = await ev(geom);
      const file = path.join(DIR, `${vp.id}-${theme}-${rt.name}.png`).replace(/\\/g, '/');
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
      const tag = `${vp.id} ${theme} ${rt.name}`;
      bgs[theme] = g.bg;
      chk(g.overflowX <= 0 && !g.clipped.length, `${tag} 无横向溢出`, `溢出${g.overflowX}px 越界${g.clipped.join('|')}`);
      chk(g.railMatchesWide, `${tag} 侧栏随宽度出现`, `宽${g.w} rail=${g.rail}`);
      chk(g.theme === theme, `${tag} 主题已应用`, `data-theme=${g.theme}`);
      chk(g.footFits, `${tag} 底部操作条不越界`, `footW=${g.footW}`);
    }
  }
}
// 深色必须真的换了底色：两档背景色不一样才算令牌覆盖成功
chk(bgs.light !== bgs.dark && /rgb/.test(bgs.light), '浅色与深色底色不同', `light=${bgs.light} dark=${bgs.dark}`);

await send('Emulation.clearDeviceMetricsOverride');
chrome.kill();
console.log(`\n截图目录 ${DIR}/，共 ${VIEWPORTS.length * THEMES.length * ROUTES.length} 张`);
console.log(`多视口验收：通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);

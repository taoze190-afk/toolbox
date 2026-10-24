import { useState } from 'react';
import { loadSettings, saveSettings } from '../core/settings';
import { verifyKey } from '../core/remote';
import { setTheme, themeMode, type ThemeMode } from '../core/theme';
import { go } from './router';
import { Hint, Panel, Row, Segmented } from './controls';

export default function Settings({ wide = false }: { wide?: boolean }) {
  const [key, setKey] = useState(() => loadSettings().ccKey);
  const [maxMB, setMaxMB] = useState(() => loadSettings().maxRemoteMB);
  const [provider, setProvider] = useState(() => loadSettings().provider);
  const [baseUrl, setBaseUrl] = useState(() => loadSettings().baseUrl);
  const [theme, setThemeState] = useState<ThemeMode>(() => themeMode());
  const [state, setState] = useState<{ busy: boolean; msg: string; ok?: boolean }>({ busy: false, msg: '' });
  const [showKey, setShowKey] = useState(false);

  const self = provider === 'self';
  const ready = key.trim().length > 0 && (!self || baseUrl.trim().length > 0);

  const test = async () => {
    setState({ busy: true, msg: '连接中…' });
    saveSettings({ baseUrl: baseUrl.trim() });
    const r = await verifyKey(key, provider as any);
    if (r.ok) {
      saveSettings({ ccKey: key.trim(), maxRemoteMB: maxMB, provider });
      setState({ busy: false, ok: true, msg: r.label });
    } else {
      setState({ busy: false, ok: false, msg: r.why });
    }
  };

  const clear = () => {
    setKey('');
    saveSettings({ ccKey: '' });
    setState({ busy: false, msg: '已停用，全部改用本机处理' });
  };

  return (
    <div className="min-h-full flex flex-col">
      <header className="safe-t sticky top-0 z-10 bg-bg/92 backdrop-blur px-2 pb-2.5 flex items-center gap-1 border-b border-line">
        {!wide && (
          <button type="button" onClick={() => go('/')} className="w-9 h-9 grid place-items-center text-[20px] text-mute">
            ‹
          </button>
        )}
        <div className="text-[15px] font-semibold">设置</div>
      </header>

      <main className="flex-1 px-4 pt-3 pb-10 max-w-[680px] mx-auto w-full">
        <div className="bg-card rounded-xl2 border border-line px-3 mb-3">
          <Panel>
            <Row label="主题" hint="跟随系统会跟着安卓的深色模式走">
              <Segmented
                value={theme}
                onChange={(v) => {
                  setThemeState(v);
                  setTheme(v);
                }}
                options={[
                  { value: 'auto', label: '跟随系统' },
                  { value: 'light', label: '浅色' },
                  { value: 'dark', label: '深色' },
                ]}
              />
            </Row>
          </Panel>
        </div>

        <div className="bg-card rounded-xl2 border border-line px-3 mb-3">
          <Panel>
            <Row label="转换服务">
              <Segmented
                value={provider}
                onChange={(v) => {
                  setProvider(v);
                  saveSettings({ provider: v as any });
                  setState({ busy: false, msg: '' });
                }}
                options={[
                  { value: 'self', label: '自建服务' },
                  { value: 'cloudconvert', label: 'CloudConvert' },
                  { value: 'convertapi', label: 'ConvertAPI' },
                ]}
              />
            </Row>
            {self && (
              <Row label="服务地址" hint="填到端口为止，不要带路径">
                <input
                  type="text"
                  inputMode="url"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  value={baseUrl}
                  onChange={(e) => {
                    setBaseUrl(e.target.value);
                    saveSettings({ baseUrl: e.target.value.trim() });
                  }}
                  onBlur={(e) => saveSettings({ baseUrl: e.target.value.trim() })}
                  placeholder="https://例子.com:29433"
                  className="w-full px-3 py-2 rounded-lg bg-soft text-[13px] outline-none"
                />
              </Row>
            )}
            <Row label={self ? '访问令牌' : '服务密钥'} hint="留空则全部本机处理">
              <div className="relative">
                <input
                  type={showKey ? 'text' : 'password'}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  placeholder={self ? '安装脚本最后打印的那串' : '粘贴 API key'}
                  className="w-full pl-3 pr-14 py-2 rounded-lg bg-soft text-[13px] outline-none"
                />
                <button
                  type="button"
                  onClick={() => setShowKey((v) => !v)}
                  className="absolute right-1 top-1/2 -translate-y-1/2 px-2 py-1 text-[11px] text-mute rounded-md hover:bg-soft2"
                  aria-label={showKey ? '隐藏密钥' : '显示密钥'}
                >
                  {showKey ? '隐藏' : '显示'}
                </button>
              </div>
            </Row>
            <Row label="走服务器的上限" hint="超过就本机处理">
              <Segmented
                value={maxMB}
                onChange={(v) => {
                  setMaxMB(v);
                  saveSettings({ maxRemoteMB: v });
                }}
                options={[
                  { value: 10, label: '10 MB' },
                  { value: 30, label: '30 MB' },
                  { value: 60, label: '60 MB' },
                ]}
              />
            </Row>
          </Panel>
        </div>

        <div className="flex gap-2 mb-3">
          <button
            type="button"
            disabled={state.busy || !ready}
            onClick={test}
            className="flex-1 py-3 rounded-xl bg-accent text-white text-[15px] font-semibold disabled:bg-soft2 disabled:text-mute"
          >
            {state.busy ? '连接中' : '验证并启用'}
          </button>
          {key && (
            <button type="button" onClick={clear} className="px-4 py-3 rounded-xl bg-soft text-[14px]">
              停用
            </button>
          )}
        </div>

        {state.msg && (
          <p className={'text-[13px] leading-relaxed mb-4 ' + (state.ok ? 'text-good' : 'text-bad')}>{state.msg}</p>
        )}

        <Hint>
          启用后，Word 转 PDF、PPT 转 PDF、Excel 转 PDF 会优先用服务器还原原版式；转换失败或没网时自动改用本机处理。
          {self ? '地址和令牌只存在这台手机上，文件由手机直连你自己的服务器。' : '密钥只存在这台手机上，文件由手机直接发给服务商。'}
        </Hint>
      </main>
    </div>
  );
}

/** 用户可改的运行时配置，存在本机 localStorage，不进包也不上传 */
const KEY = 'tk.settings';

export type Provider = 'cloudconvert' | 'convertapi' | 'self';

export type Settings = {
  /** 服务密钥；留空则所有"服务器转换"走本地降级实现 */
  ccKey: string;
  provider: Provider;
  /** 自建转换服务地址，例如 https://xxx.example.com:29433 */
  baseUrl: string;
  /** 单次走服务器的文件大小上限 MB，超过直接本地处理 */
  maxRemoteMB: number;
};

const DEFAULTS: Settings = { ccKey: '', provider: 'cloudconvert', baseUrl: '', maxRemoteMB: 30 };

export function loadSettings(): Settings {
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) || '{}') as Partial<Settings>) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(s: Partial<Settings>): Settings {
  const next = { ...loadSettings(), ...s };
  localStorage.setItem(KEY, JSON.stringify(next));
  return next;
}

export const hasRemote = () => loadSettings().ccKey.trim().length > 8;

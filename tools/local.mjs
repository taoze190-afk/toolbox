// 本机专用的路径与设备号：真值写在 tools/local.json，那个文件不进版本库。
// 克隆仓库的人照 tools/local.example.json 复制一份改自己的路径。
import fs from 'node:fs';

const file = new URL('./local.json', import.meta.url);
const cfg = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};

export function need(key) {
  if (cfg[key] === undefined) {
    throw new Error(`tools/local.json 里缺 "${key}"（参考 tools/local.example.json）`);
  }
  return cfg[key];
}

export const opt = (key) => cfg[key];

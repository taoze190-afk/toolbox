import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 4096,
  },
  server: {
    host: '127.0.0.1',
    port: 5175,
    strictPort: true,
    // 安卓构建产物和 tools/ 脚本会不停变动，被 watch 到就整页刷新，
    // 正好打断验证脚本的断言（真踩过），只让 src/ 与 public/ 触发重载
    watch: { ignored: ['**/android/**', '**/tools/**', '**/fixtures/**', '**/out/**', '**/shots/**'] },
  },
});

import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 版本号唯一事实源 = 仓库根 package.json，构建时注入给前端。
// 原因是它曾漂移成 root 0.1.77 / web 0.1.47 / errorContext 0.1.45 三份，报错上下文里的
// 版本号与 CHANGELOG 对不上，用户报障时无法据此定位是哪一版。手写两份就必然漂移。
const APP_VERSION: string = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
).version as string;

export default defineConfig({
  define: { 'import.meta.env.VITE_APP_VERSION': JSON.stringify(APP_VERSION) },
  plugins: [react()],
  resolve: {
    alias: {
      // react-syntax-highlighter@16 误引用 highlight.js 11 才有的 sql_more（其依赖声明为 10.x）
      // 本项目不使用代码高亮，别名到同包 sql 语言，规避构建解析失败
      'highlight.js/lib/languages/sql_more': 'highlight.js/lib/languages/sql',
    },
  },
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/api': {
        target: process.env.VITE_PROXY_TARGET ?? 'http://localhost:3080',
        changeOrigin: true,
      },
    },
  },
  build: {
    chunkSizeWarningLimit: 900,
    rolldownOptions: {
      output: {
        // 框架与组件库分包，优化首屏与缓存命中
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('@ant-design/x')) return 'x';
          if (id.includes('/antd/') || id.includes('@ant-design/icons') || id.includes('/rc-')) return 'antd';
          if (id.includes('/react') || id.includes('/scheduler/')) return 'react';
          return undefined;
        },
      },
    },
  },
});

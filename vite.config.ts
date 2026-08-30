import { defineConfig, Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

/**
 * 移除 crossorigin 属性
 * Electron 打包后使用 file:// 协议，crossorigin 会导致资源加载问题
 */
function removeCrossorigin(): Plugin {
  return {
    name: 'remove-crossorigin',
    transformIndexHtml(html) {
      return html.replace(/ crossorigin/g, '');
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), removeCrossorigin()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@electron': path.resolve(__dirname, './electron'),
      '@shared': path.resolve(__dirname, './shared'),
    },
  },
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // 代码分割配置
    rollupOptions: {
      output: {
        manualChunks: {
          // React 核心库单独打包
          'react-vendor': ['react', 'react-dom', 'react-router-dom'],
          // Ant Design UI 库单独打包
          'icons-vendor': ['@ant-design/icons'],
          // 状态管理和工具库
          'utils-vendor': ['zustand'],
        },
        // 优化文件命名
        chunkFileNames: 'js/[name]-[hash].js',
        entryFileNames: 'js/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash].[ext]',
      },
    },
    // 构建性能优化
    chunkSizeWarningLimit: 1000, // 提高警告阈值到 1MB
    minify: 'esbuild', // 使用 esbuild 压缩，速度更快
    sourcemap: false, // 生产环境关闭 sourcemap
    // 提升构建性能
    target: 'esnext',
    cssCodeSplit: true,
  },
  server: {
    // Reserve a project-specific port so another checkout can keep 5173.
    port: 5174,
    // 显式绑 IPv4：主进程加载 http://127.0.0.1:5174（renderer-entry.ts），
    // 而 Vite 默认绑 localhost 在部分环境解析成仅 [::1]，Electron 会 ERR_CONNECTION_REFUSED
    host: '127.0.0.1',
    strictPort: true, // 如果端口被占用则报错，不自动切换
    // 开发服务器优化
    hmr: {
      overlay: true,
    },
    watch: {
      ignored: [
        '**/node_modules/**',
        '**/.piskiepilot/**',
        '**/.git/**',
        '**/dist/**',
        '**/dist-electron/**',
        '**/logs/**',
      ],
    },
  },
  // 优化依赖预构建
  optimizeDeps: {
    include: ['react', 'react-dom', '@ant-design/icons'],
  },
});

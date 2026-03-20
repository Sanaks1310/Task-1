import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      '/ws': {
        target:    'ws://localhost:4000',
        ws:        true,
        changeOrigin: true,
      },
    },
  },
  build: {
    target:       'es2022',
    outDir:       'dist',
    sourcemap:    true,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom'],
          state: ['zustand'],
        },
      },
    },
  },
});

import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src'), '@shared': path.resolve(import.meta.dirname, 'shared') } },
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 1200, target: 'es2022' },
  server: { fs: { allow: ['.'] } },
});

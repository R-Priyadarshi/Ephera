import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../landing-react',
    emptyOutDir: true,
    cssCodeSplit: false,
    rollupOptions: {
      input: resolve(__dirname, 'src/embed.jsx'),
      output: {
        entryFileNames: 'landing-react.js',
        chunkFileNames: 'landing-react-[hash].js',
        assetFileNames: (assetInfo) => {
          if (assetInfo.name && assetInfo.name.endsWith('.css')) {
            return 'landing-react.css';
          }
          return '[name][extname]';
        }
      }
    }
  }
});

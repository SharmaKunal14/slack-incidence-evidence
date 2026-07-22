import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { build } from 'vite';

const webRoot = fileURLToPath(new URL('../web/', import.meta.url));
const outputDirectory = fileURLToPath(
  new URL('../website/public/review-demo/', import.meta.url),
);

await build({
  base: '/review-demo/',
  root: webRoot,
  publicDir: false,
  plugins: [tailwindcss(), react()],
  build: {
    assetsDir: '',
    assetsInlineLimit: 0,
    cssCodeSplit: false,
    emptyOutDir: true,
    minify: 'esbuild',
    modulePreload: false,
    outDir: outputDirectory,
    rollupOptions: {
      input: fileURLToPath(new URL('../web/demo.html', import.meta.url)),
      output: {
        entryFileNames: 'app.js',
        assetFileNames: 'styles.css',
      },
    },
    sourcemap: false,
    target: 'es2022',
  },
});

process.stdout.write(`Created ${outputDirectory}\n`);

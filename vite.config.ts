import { defineConfig } from 'vite';

// GitHub Pages serves a project site from /<repo-name>/, so the base has to match the
// repository name. Override with BASE_PATH if you rename the repo or use a custom domain.
const base = process.env.BASE_PATH ?? '/harmonica-ai-song-maker/';

export default defineConfig({
  base,
  build: {
    target: 'es2022',
    outDir: 'dist',
    // The Basic Pitch model and TensorFlow are large; this keeps the warning noise down
    // without hiding a genuine regression in our own bundle.
    chunkSizeWarningLimit: 1200,
  },
  server: { port: 5173 },
});

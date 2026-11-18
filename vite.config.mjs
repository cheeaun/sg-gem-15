import { defineConfig } from 'vite';

// One port for both servers: the page is opened at a known URL, and a silent
// fallback to another port would hide a port clash. Binding 0.0.0.0 serves the
// page to other devices on the LAN as well as localhost.
const PORT = 8123;

export default defineConfig({
  // Relative asset URLs, so the same build works at a GitHub Pages project path.
  base: './',
  // The pipeline writes the DEM into data/gem15_singapore. Treating data/ as the
  // public directory serves it from /gem15_singapore in dev and copies it into the
  // build root, without a second 13.6 MB copy in the source tree.
  publicDir: 'data',
  build: {
    target: 'es2022',
  },
  // Fixed port, and HMR off deliberately: this page keeps a large terrain scene
  // and a base-map texture cache in memory, and repeated hot updates stacked copies
  // of them in the dev client until the tab was reloaded. A change needs a manual
  // reload.
  server: { host: '0.0.0.0', port: PORT, strictPort: true, hmr: false },
  preview: { host: '0.0.0.0', port: PORT, strictPort: true },
});

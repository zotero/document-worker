import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { readdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default {
  root: resolve(__dirname, '..'),
  server: { open: '/preview/' },
  optimizeDeps: {
    entries: ['preview/index.html'],
  },
  plugins: [{
    name: 'test-pdf-list',
    configureServer(server) {
      server.middlewares.use('/__api/test-pdfs', (_req, res) => {
        const dir = resolve(__dirname, '..', 'test/pdfs/full');
        let files = [];
        try {
          files = readdirSync(dir).filter(f => f.endsWith('.pdf')).sort((a, b) => {
            const na = parseInt(a, 10), nb = parseInt(b, 10);
            if (!isNaN(na) && !isNaN(nb)) return na - nb;
            return a.localeCompare(b);
          });
        } catch {}
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(files));
      });
    }
  }, {
    // Strip `with { type: 'json' }` import attributes (unsupported by esbuild)
    // Vite handles .json imports natively
    name: 'strip-import-attributes',
    enforce: 'pre',
    transform(code, id) {
      if (code.includes('with {'))
        return { code: code.replace(/\s+with\s+\{\s*type:\s*['"][^'"]*['"]\s*\}/g, ''), map: null };
    }
  }],
  resolve: {
    alias: {
      fs: 'data:text/javascript,export default {}',
      path: 'data:text/javascript,export default {}',
      worker_threads: 'data:text/javascript,export default {}',
      vm: 'data:text/javascript,export default {}',
    }
  }
};

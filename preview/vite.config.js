import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { existsSync, readdirSync, statSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_PDF_DIRS = ['test/fixtures/pdf/full', 'test/fixtures/pdf/extra'];

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function collectPdfEntries(relativeDir) {
  const dir = resolve(__dirname, '..', relativeDir);
  if (!existsSync(dir) || !isDirectory(dir)) {
    return [];
  }

  return readdirSync(dir)
    .filter(name => name.endsWith('.pdf'))
    .sort((a, b) => {
      const na = parseInt(a, 10);
      const nb = parseInt(b, 10);
      if (!Number.isNaN(na) && !Number.isNaN(nb) && na !== nb) {
        return na - nb;
      }
      return a.localeCompare(b);
    })
    .map(name => ({
      name,
      path: `${relativeDir}/${name}`,
      label: relativeDir.includes('/extra') ? `${name} (extra)` : name
    }));
}

function comparePdfEntries(a, b) {
  const na = parseInt(a.name, 10);
  const nb = parseInt(b.name, 10);
  if (!Number.isNaN(na) && !Number.isNaN(nb) && na !== nb) {
    return na - nb;
  }
  return a.name.localeCompare(b.name) || a.path.localeCompare(b.path);
}

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
        const entries = TEST_PDF_DIRS.flatMap(collectPdfEntries).sort(comparePdfEntries);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(entries));
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
      'pdfjs/pdf.worker.js': resolve(__dirname, '../pdf.js/src/pdf.worker.js'),
      'display-node_utils': resolve(__dirname, '../pdf.js/src/display/stubs.js'),
      'display-node_stream': resolve(__dirname, '../pdf.js/src/display/stubs.js'),
      'display-cmap_reader_factory': resolve(__dirname, '../pdf.js/src/display/cmap_reader_factory.js'),
      'display-standard_fontdata_factory': resolve(__dirname, '../pdf.js/src/display/standard_fontdata_factory.js'),
      'display-wasm_factory': resolve(__dirname, '../pdf.js/src/display/wasm_factory.js'),
      'display-fetch_stream': resolve(__dirname, '../pdf.js/src/display/fetch_stream.js'),
      'display-network': resolve(__dirname, '../pdf.js/src/display/network.js'),
      fs: 'data:text/javascript,export default {}',
      path: 'data:text/javascript,export default {}',
      worker_threads: 'data:text/javascript,export default {}',
      vm: 'data:text/javascript,export default {}',
    }
  }
};

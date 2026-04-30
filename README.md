# Document Worker

Zotero worker for document processing.

It supports PDF annotation processing, PDF text extraction and rendering, and structured text extraction from PDFs, EPUBs, and HTML snapshots.

The source modules run in Node.js for tests and tooling. Production builds emit a Web Worker bundle for Zotero desktop, and the same worker code is exercised in JavaScriptCore/JSContext for Zotero's iOS runtime.

## Build

```bash
git clone https://github.com/zotero/document-worker --recursive
cd document-worker
npm ci
npm run build
```

`npm run build` creates `build/worker.js` and the static assets loaded by the worker.

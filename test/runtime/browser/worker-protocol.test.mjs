import { test, expect } from '@playwright/test';
import http from 'node:http';
import fs from 'node:fs';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	sampleCitaviAnnotations,
	sampleMendeleyAnnotations,
	sampleRenderableAnnotations,
	sampleZoteroAnnotations,
} from '../../helpers/fixtures.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoDir = resolve(__dirname, '../../..');

const MIME_TYPES = {
	'.bcmap': 'application/octet-stream',
	'.html': 'text/html; charset=utf-8',
	'.js': 'application/javascript; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.onnx': 'application/octet-stream',
	'.pdf': 'application/pdf',
	'.wasm': 'application/wasm',
	'.epub': 'application/epub+zip',
};

function createStaticServer() {
	return http.createServer((req, res) => {
		try {
			let url = new URL(req.url || '/', 'http://127.0.0.1');
			let pathname = decodeURIComponent(url.pathname);
			if (pathname === '/') {
				res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
				res.end('<!doctype html><meta charset="utf-8"><title>worker runtime</title>');
				return;
			}

			let filePath = resolve(repoDir, pathname.slice(1));
			if (filePath !== repoDir && !filePath.startsWith(repoDir + sep)) {
				res.writeHead(403);
				res.end('Forbidden');
				return;
			}

			let data = fs.readFileSync(filePath);
			res.writeHead(200, {
				'Content-Type': MIME_TYPES[extname(filePath)] || 'application/octet-stream',
			});
			res.end(data);
		}
		catch (err) {
			res.writeHead(err.code === 'ENOENT' ? 404 : 500);
			res.end(err.message);
		}
	});
}

async function listen(server) {
	await new Promise((resolveListen, rejectListen) => {
		server.once('error', rejectListen);
		server.listen(0, '127.0.0.1', () => {
			server.off('error', rejectListen);
			resolveListen();
		});
	});
	let address = server.address();
	return `http://${address.address}:${address.port}`;
}

async function close(server) {
	await new Promise((resolveClose, rejectClose) => {
		server.close((err) => err ? rejectClose(err) : resolveClose());
	});
}

function assertStructure(result, type) {
	expect(result.processor?.type).toBe(type);
	expect(result.schemaVersion).toBe('1.0.0-draft');
	expect(Array.isArray(result.pages)).toBe(true);
	expect(result.pages.length).toBeGreaterThan(0);
	expect(Array.isArray(result.content)).toBe(true);
	expect(result.content.length).toBeGreaterThan(0);
	expect(result.content[0].type).toBeTruthy();
}

// This runtime suite assumes `npm run build` has populated build/ with worker assets.
test('browser Web Worker protocol supports public document APIs', async ({ page }) => {
	test.setTimeout(120000);

	let server = createStaticServer();
	let baseURL = await listen(server);
	try {
		await page.goto(baseURL);

		let samples = {
			citaviAnnotations: sampleCitaviAnnotations(),
			mendeleyAnnotations: sampleMendeleyAnnotations(),
			renderableAnnotations: sampleRenderableAnnotations(),
			zoteroAnnotations: sampleZoteroAnnotations(),
		};

		let result = await page.evaluate(async (samples) => {
			const worker = new Worker('/build/worker.js');
			const pending = new Map();
			let nextID = 0;
			let savedRenderedAnnotations = 0;

			worker.onmessage = async (event) => {
				const message = event.data;
				if (message.action === 'FetchData') {
					try {
						const response = await fetch('/build/' + message.data);
						if (!response.ok) {
							throw new Error(`${message.data}: ${response.status}`);
						}
						const buf = await response.arrayBuffer();
						worker.postMessage({ responseID: message.id, data: buf }, [buf]);
					}
					catch (err) {
						worker.postMessage({
							responseID: message.id,
							error: { message: err.message },
						});
					}
					return;
				}
				if (message.action === 'SaveRenderedAnnotation') {
					if (message.data?.buf?.byteLength > 0) {
						savedRenderedAnnotations++;
					}
					worker.postMessage({ responseID: message.id, data: true });
					return;
				}

				const pendingCall = pending.get(message.responseID);
				if (!pendingCall) {
					return;
				}
				pending.delete(message.responseID);

				if (message.error) {
					pendingCall.reject(new Error(message.error.message || String(message.error)));
				}
				else {
					pendingCall.resolve(message.data);
				}
			};

			function callWorker(action, data, transfer = []) {
				return new Promise((resolve, reject) => {
					const id = ++nextID;
					pending.set(id, { resolve, reject });
					worker.postMessage({ id, action, data }, transfer);
				});
			}

			function callWorkerWithBuffer(action, sourceBuf, data = {}) {
				const buf = sourceBuf.slice(0);
				return callWorker(action, { buf, ...data }, [buf]);
			}

			async function fetchArrayBuffer(path) {
				const response = await fetch(path);
				if (!response.ok) {
					throw new Error(`${path}: ${response.status}`);
				}
				return response.arrayBuffer();
			}

			function isPdfBuffer(buf) {
				return new TextDecoder().decode(new Uint8Array(buf, 0, 4)) === '%PDF';
			}

			const pdf = await fetchArrayBuffer('/test/fixtures/pdf/full/1.pdf');
			const pdf2 = await fetchArrayBuffer('/test/fixtures/pdf/full/2.pdf');
			const epub = await fetchArrayBuffer('/test/fixtures/epub/1.epub');
			const snapshot = await fetchArrayBuffer('/test/fixtures/snapshot/1.html');

			const imported = await callWorkerWithBuffer('pdf.importAnnotations', pdf, {
				existingAnnotations: [],
				password: '',
				transfer: false,
			});

			const written = await callWorkerWithBuffer('pdf.writeAnnotations', pdf, {
				annotations: samples.zoteroAnnotations,
				password: '',
			});

			const deleted = await callWorkerWithBuffer('pdf.deletePages', pdf, {
				pageIndexes: [1],
				password: '',
			});

			const rotated = await callWorkerWithBuffer('pdf.rotatePages', pdf, {
				pageIndexes: [0],
				degrees: 90,
				password: '',
			});

			const fulltext = await callWorkerWithBuffer('pdf.getFulltext', pdf, {
				maxPages: 1,
				password: '',
			});

			const recognizerData = await callWorkerWithBuffer('pdf.getRecognizerData', pdf, {
				password: '',
			});

			const mendeleyAnnotations = await callWorkerWithBuffer('pdf.importMendeleyAnnotations', pdf2, {
				mendeleyAnnotations: samples.mendeleyAnnotations,
				password: '',
			});

			const citaviAnnotations = await callWorkerWithBuffer('pdf.importCitaviAnnotations', pdf2, {
				citaviAnnotations: samples.citaviAnnotations,
				password: '',
			});

			const pdfStructure = await callWorkerWithBuffer('getStructuredDocumentText', pdf, {
				contentType: 'application/pdf',
				password: '',
			});

			const epubStructure = await callWorkerWithBuffer('getStructuredDocumentText', epub, {
				contentType: 'application/epub+zip',
			});

			const snapshotStructure = await callWorkerWithBuffer('getStructuredDocumentText', snapshot, {
				contentType: 'text/html',
			});

			const renderedAnnotationCount = await callWorkerWithBuffer('pdf.renderAnnotations', pdf, {
				libraryID: 1,
				annotations: samples.renderableAnnotations,
				password: '',
			});

			const hasAnnotations = await callWorkerWithBuffer('pdf.hasAnnotations', pdf, {
				password: '',
			});

			worker.terminate();

			return {
				imported,
				writtenIsPdf: isPdfBuffer(written.buf),
				deletedIsPdf: isPdfBuffer(deleted.buf),
				rotatedIsPdf: isPdfBuffer(rotated.buf),
				fulltext,
				recognizerData,
				mendeleyAnnotations,
				citaviAnnotations,
				pdfStructure,
				epubStructure,
				snapshotStructure,
				renderedAnnotationCount,
				savedRenderedAnnotations,
				hasAnnotations,
			};
		}, samples);

		expect(Array.isArray(result.imported.imported)).toBe(true);
		expect(Array.isArray(result.imported.deleted)).toBe(true);
		expect(result.writtenIsPdf).toBe(true);
		expect(result.deletedIsPdf).toBe(true);
		expect(result.rotatedIsPdf).toBe(true);
		expect(result.fulltext.text.length).toBeGreaterThan(0);
		expect(result.fulltext.extractedPages).toBe(1);
		expect(result.fulltext.totalPages).toBeGreaterThanOrEqual(1);
		expect(Array.isArray(result.recognizerData.pages)).toBe(true);
		expect(result.recognizerData.pages.length).toBeGreaterThan(0);
		expect(Array.isArray(result.mendeleyAnnotations)).toBe(true);
		expect(result.mendeleyAnnotations.length).toBeGreaterThan(0);
		expect(Array.isArray(result.citaviAnnotations)).toBe(true);
		expect(result.citaviAnnotations.length).toBeGreaterThan(0);
		assertStructure(result.pdfStructure, 'pdf');
		assertStructure(result.epubStructure, 'epub');
		assertStructure(result.snapshotStructure, 'snapshot');
		expect(result.renderedAnnotationCount).toBe(1);
		expect(result.savedRenderedAnnotations).toBe(1);
		expect(typeof result.hasAnnotations.hasAnnotations).toBe('boolean');
	}
	finally {
		await close(server);
	}
});

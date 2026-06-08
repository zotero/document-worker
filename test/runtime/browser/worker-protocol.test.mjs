import { test, expect } from '@playwright/test';
import { Buffer } from 'node:buffer';
import {
	readFixtureSourceHash,
	sampleCitaviAnnotations,
	sampleMendeleyAnnotations,
	sampleRenderableAnnotations,
	sampleZoteroAnnotations,
} from '../../helpers/fixtures.js';
import {
	assertRenderedTextCropPNG,
	pdfTextCropRenderContract,
} from '../../helpers/render-assertions.js';
import { close, createStaticServer, listen } from './server.js';

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
			sourceHashes: {
				pdf: readFixtureSourceHash('pdf', 'full', '1.pdf'),
				epub: readFixtureSourceHash('epub', '1.epub'),
				snapshot: readFixtureSourceHash('snapshot', '1.html'),
			},
		};

		let result = await page.evaluate(async (samples) => {
			const worker = new Worker('/build/worker.js');
			const pending = new Map();
			let nextID = 0;
			let renderedAnnotationPNGs = [];

			function arrayBufferToBase64(buf) {
				let bytes = new Uint8Array(buf);
				let binary = '';
				for (let i = 0; i < bytes.length; i++) {
					binary += String.fromCharCode(bytes[i]);
				}
				return btoa(binary);
			}

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
						renderedAnnotationPNGs.push(arrayBufferToBase64(message.data.buf));
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

			function isSdtBuffer(buf) {
				const bytes = new Uint8Array(buf, 0, 8);
				const magic = [0x89, 0x53, 0x44, 0x54, 0x0d, 0x0a, 0x1a, 0x0a];
				return magic.every((value, index) => bytes[index] === value);
			}

			const pdf = await fetchArrayBuffer('/test/fixtures/pdf/full/1.pdf');
			const pdf2 = await fetchArrayBuffer('/test/fixtures/pdf/full/2.pdf');
			const epub = await fetchArrayBuffer('/test/fixtures/epub/1.epub');
			const snapshot = await fetchArrayBuffer('/test/fixtures/snapshot/1.html');
			const pdfHash = samples.sourceHashes.pdf;
			const epubHash = samples.sourceHashes.epub;
			const snapshotHash = samples.sourceHashes.snapshot;

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

			const packedPdfStructure = await callWorkerWithBuffer('getStructuredDocumentText', pdf, {
				contentType: 'application/pdf',
				password: '',
				sourceHash: pdfHash,
			});

			const packedEpubStructure = await callWorkerWithBuffer('getStructuredDocumentText', epub, {
				contentType: 'application/epub+zip',
				sourceHash: epubHash,
			});

			const packedSnapshotStructure = await callWorkerWithBuffer('getStructuredDocumentText', snapshot, {
				contentType: 'text/html',
				sourceHash: snapshotHash,
			});

			const renderedAnnotationCount = await callWorkerWithBuffer('pdf.renderAnnotations', pdf, {
				libraryID: 1,
				annotations: samples.renderableAnnotations,
				password: '',
			});

			const renderedArea = await callWorkerWithBuffer('pdf.renderArea', pdf, {
				pageIndex: samples.renderAreaContract.pageIndex,
				rect: samples.renderAreaContract.rect,
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
				packedPdfIsSdt: isSdtBuffer(packedPdfStructure.buf),
				packedPdfByteLength: packedPdfStructure.buf.byteLength,
				packedEpubIsSdt: isSdtBuffer(packedEpubStructure.buf),
				packedEpubByteLength: packedEpubStructure.buf.byteLength,
				packedSnapshotIsSdt: isSdtBuffer(packedSnapshotStructure.buf),
				packedSnapshotByteLength: packedSnapshotStructure.buf.byteLength,
				renderedAnnotationCount,
				renderedAnnotationPNGs,
				renderedAreaPNG: arrayBufferToBase64(renderedArea.buf),
				hasAnnotations,
			};
		}, { ...samples, renderAreaContract: pdfTextCropRenderContract });

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
		expect(result.packedPdfIsSdt).toBe(true);
		expect(result.packedPdfByteLength).toBeGreaterThan(100);
		expect(result.packedEpubIsSdt).toBe(true);
		expect(result.packedEpubByteLength).toBeGreaterThan(100);
		expect(result.packedSnapshotIsSdt).toBe(true);
		expect(result.packedSnapshotByteLength).toBeGreaterThan(100);
		expect(result.renderedAnnotationCount).toBe(1);
		expect(result.renderedAnnotationPNGs).toHaveLength(1);
		await assertRenderedTextCropPNG(Buffer.from(result.renderedAnnotationPNGs[0], 'base64'));
		await assertRenderedTextCropPNG(Buffer.from(result.renderedAreaPNG, 'base64'));
		expect(typeof result.hasAnnotations.hasAnnotations).toBe('boolean');
	}
	finally {
		await close(server);
	}
});

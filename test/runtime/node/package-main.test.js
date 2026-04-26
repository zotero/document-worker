import '../../../scripts/pdfjs-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as worker from 'document-worker';
import {
	mainAbsentExportNames,
	mainExportNames,
	mainPdfNamespaceExportNames,
} from '../public-api.js';
import {
	assertAnnotationImportResult,
	assertFulltextResult,
	assertPdfBuffer,
	assertRecognizerData,
	assertStructuredDocumentText,
} from '../../helpers/assertions.js';
import { dataProvider } from '../../helpers/data-provider.js';
import {
	readFixtureArrayBuffer,
	sampleCitaviAnnotations,
	sampleMendeleyAnnotations,
	sampleZoteroAnnotations,
} from '../../helpers/fixtures.js';

function pdf1() {
	return readFixtureArrayBuffer('pdf', 'full', '1.pdf');
}

function pdf2() {
	return readFixtureArrayBuffer('pdf', 'full', '2.pdf');
}

// This runtime suite assumes `npm run build` has populated build/ with worker assets.
describe('package main export in Node.js', { timeout: 120000 }, () => {
	it('exposes the intended top-level API shape', () => {
		assert.deepEqual(Object.keys(worker).sort(), mainExportNames.slice().sort());
		for (let name of mainAbsentExportNames) {
			assert.equal(worker[name], undefined);
		}
		assert.equal(typeof worker.pdf, 'object');
		for (let name of mainPdfNamespaceExportNames) {
			assert.equal(typeof worker.pdf[name], 'function', `pdf.${name}`);
		}
	});

	it('runs every supported PDF namespace export', async () => {
		let imported = await worker.pdf.importAnnotations(pdf1(), [], '', false, dataProvider);
		assertAnnotationImportResult(imported);

		let written = await worker.pdf.writeAnnotations(pdf1(), sampleZoteroAnnotations(), '', dataProvider);
		assertPdfBuffer(written);

		let deleted = await worker.pdf.deletePages(pdf1(), [1], '');
		assertPdfBuffer(deleted);

		let rotated = await worker.pdf.rotatePages(pdf1(), [0], 90, '');
		assertPdfBuffer(rotated);

		let fulltext = await worker.pdf.getFulltext(pdf1(), 1, '', dataProvider);
		assertFulltextResult(fulltext);

		let recognizerData = await worker.pdf.getRecognizerData(pdf1(), '', dataProvider);
		assertRecognizerData(recognizerData);

		let mendeley = await worker.pdf.importMendeleyAnnotations(
			pdf2(),
			sampleMendeleyAnnotations(),
			'',
			dataProvider
		);
		assert.ok(Array.isArray(mendeley));
		assert.ok(mendeley.length > 0);

		let citavi = await worker.pdf.importCitaviAnnotations(
			pdf2(),
			sampleCitaviAnnotations(),
			'',
			dataProvider
		);
		assert.ok(Array.isArray(citavi));
		assert.ok(citavi.length > 0);

		let hasAnnotations = await worker.pdf.hasAnnotations(pdf1(), '');
		assert.equal(typeof hasAnnotations, 'boolean');
	});

	it('extracts structured document text for PDF, EPUB, and snapshot', async () => {
		let pdfResult = await worker.getStructuredDocumentText(pdf1(), {
			contentType: 'application/pdf',
			password: '',
			dataProvider,
		});
		assertStructuredDocumentText(pdfResult, 'pdf');

		let epubResult = await worker.getStructuredDocumentText(
			readFixtureArrayBuffer('epub', '1.epub'),
			{ contentType: 'application/epub+zip' }
		);
		assertStructuredDocumentText(epubResult, 'epub');

		let snapshotResult = await worker.getStructuredDocumentText(
			readFixtureArrayBuffer('snapshot', '1.html'),
			{ contentType: 'text/html' }
		);
		assertStructuredDocumentText(snapshotResult, 'snapshot');
	});
});

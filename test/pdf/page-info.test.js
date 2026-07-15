import '../../scripts/pdfjs-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { getStructuredDocumentText } from '../../src/index.js';
import {
	SDT_PACK_VERSION,
	SDT_PROCESSOR_VERSIONS,
	SDT_SCHEMA_VERSION,
} from '../../src/versions.js';
import { openStructuredDocumentTextPack } from '../../structured-document-text/src/pack/reader.js';

const sourceHash = '00000000000000000000000000000000';
const dataProvider = path => { throw new Error(`Unexpected data provider call: ${path}`); };

function createPDF(pages) {
	let pageObjects = pages.map(({
		mediaBox = '0 0 612 792',
		pageEntries = '',
	}) => `<< /Type /Page /Parent 2 0 R /MediaBox [${mediaBox}] /Resources << >> ${pageEntries} >>`);
	let pageRefs = pageObjects.map((_, index) => `${index + 3} 0 R`);
	let objects = [
		'<< /Type /Catalog /Pages 2 0 R >>',
		`<< /Type /Pages /Count ${pages.length} /Kids [${pageRefs.join(' ')}] >>`,
		...pageObjects,
	];
	let body = '%PDF-1.6\n';
	let offsets = [];
	for (let [index, object] of objects.entries()) {
		offsets.push(Buffer.byteLength(body));
		body += `${index + 1} 0 obj\n${object}\nendobj\n`;
	}
	let xrefOffset = Buffer.byteLength(body);
	let xrefEntries = offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n `);
	body += [
		'xref',
		`0 ${objects.length + 1}`,
		'0000000000 65535 f ',
		...xrefEntries,
		'trailer',
		`<< /Size ${objects.length + 1} /Root 1 0 R >>`,
		'startxref',
		String(xrefOffset),
		'%%EOF',
		'',
	].join('\n');
	return Buffer.from(body);
}

async function getPackedStructure(pdf) {
	let result = await getStructuredDocumentText(pdf, {
		contentType: 'application/pdf',
		password: '',
		dataProvider,
		sourceHash,
	});
	let reader = await openStructuredDocumentTextPack(result.buf, {
		inflate: bytes => new Uint8Array(inflateRawSync(bytes)),
	});
	return { reader, structure: await reader.materialize() };
}

describe('PDF SDT page info', () => {
	it('emits non-default rotation and userUnit and omits defaults', async () => {
		let { reader, structure } = await getPackedStructure(createPDF([
			{},
			{ pageEntries: '/Rotate 90 /UserUnit 2' },
		]));

		assert.equal(reader.header.packVersion, SDT_PACK_VERSION);
		assert.equal(reader.header.schemaVersion, SDT_SCHEMA_VERSION);
		assert.deepEqual(structure.metadata.processor, {
			type: 'pdf',
			version: SDT_PROCESSOR_VERSIONS.pdf,
		});
		let [defaultPage, transformedPage] = structure.catalog.pages;
		assert.equal(Object.hasOwn(defaultPage, 'rotation'), false);
		assert.equal(Object.hasOwn(defaultPage, 'userUnit'), false);
		assert.equal(transformedPage.rotation, 90);
		assert.equal(transformedPage.userUnit, 2);
		assert.deepEqual(defaultPage.viewRect, [0, 0, 612, 792]);
		assert.deepEqual(transformedPage.viewRect, [0, 0, 612, 792]);
	});

	it('normalizes malformed rotation and userUnit in packed output', async () => {
		let { structure } = await getPackedStructure(
			createPDF([{ pageEntries: `/Rotate (90) /UserUnit ${'9'.repeat(400)}` }])
		);
		let [page] = structure.catalog.pages;

		assert.equal(Object.hasOwn(page, 'rotation'), false);
		assert.equal(Object.hasOwn(page, 'userUnit'), false);
	});
});

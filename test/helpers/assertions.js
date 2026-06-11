import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';

export function assertFulltextResult(result) {
	assert.equal(typeof result, 'object');
	assert.equal(typeof result.text, 'string');
	assert.ok(result.text.length > 0);
	assert.ok(result.extractedPages >= 1);
	assert.ok(result.totalPages >= result.extractedPages);
}

export function assertStructuredDocumentText(result, type) {
	assert.equal(result.metadata?.processor?.type, type);
	assert.equal(Number.isInteger(result.metadata?.processor?.version), true);
	assert.ok(result.metadata.processor.version > 0);
	assert.equal(result.schemaVersion, '1.0.0');
	assert.match(result.metadata?.source?.hash, /^[0-9a-f]{32}$/u);
	assert.ok(Array.isArray(result.catalog?.pages));
	assert.ok(result.catalog.pages.length > 0);
	assert.ok(Array.isArray(result.content));
	assert.ok(result.content.length > 0);
	assert.ok(result.content[0].type);
}

export function assertPdfBuffer(buf) {
	let bytes = Buffer.from(buf);
	assert.ok(bytes.length > 100);
	assert.equal(bytes.subarray(0, 4).toString('utf8'), '%PDF');
}

export function assertAnnotationImportResult(result) {
	assert.equal(typeof result, 'object');
	assert.ok(Array.isArray(result.imported));
	assert.ok(Array.isArray(result.deleted));
}

export function assertRecognizerData(result) {
	assert.equal(typeof result, 'object');
	assert.equal(typeof result.metadata, 'object');
	assert.ok(Array.isArray(result.pages));
	assert.ok(result.pages.length > 0);
}

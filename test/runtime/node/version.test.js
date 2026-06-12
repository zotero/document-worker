import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { TextDecoder, TextEncoder } from 'node:util';
import vm from 'node:vm';
import {
	SDT_PACK_VERSION,
	SDT_PROCESSOR_VERSIONS,
	SDT_SCHEMA_VERSION,
} from '../../../src/versions.js';
import {
	SDT_PACK_VERSION as SDT_PACKAGE_PACK_VERSION,
	SDT_SCHEMA_VERSION as SDT_PACKAGE_SCHEMA_VERSION,
} from '../../../structured-document-text/src/version.js';

describe('version constants', () => {
	it('uses explicit integer processor versions', () => {
		assert.deepEqual(Object.keys(SDT_PROCESSOR_VERSIONS).sort(), ['epub', 'pdf', 'snapshot']);
		for (let version of Object.values(SDT_PROCESSOR_VERSIONS)) {
			assert.equal(Number.isInteger(version), true);
			assert.ok(version > 0);
		}
	});

	it('keeps exported SDT versions in sync with structured-document-text', () => {
		assert.equal(SDT_SCHEMA_VERSION, SDT_PACKAGE_SCHEMA_VERSION);
		assert.equal(SDT_PACK_VERSION, SDT_PACKAGE_PACK_VERSION);
	});

	it('writes build metadata from exported constants', async () => {
		let metadata = JSON.parse(await readFile('build/metadata.json', 'utf8'));
		assert.deepEqual(metadata, {
			SDT_SCHEMA_VERSION,
			SDT_PACK_VERSION,
			SDT_PROCESSOR_VERSIONS,
		});
	});

	it('builds the bundled SDT reader module', async () => {
		let source = await readFile('build/structured-document-text.js', 'utf8');
		let module = { exports: {} };
		vm.runInNewContext(source, {
			module,
			exports: module.exports,
			TextDecoder,
			TextEncoder,
		});

		assert.equal(typeof module.exports.openStructuredDocumentTextPack, 'function');
		assert.equal(module.exports.SDT_SCHEMA_VERSION, SDT_SCHEMA_VERSION);
		assert.equal(module.exports.SDT_PACK_VERSION, SDT_PACK_VERSION);
	});
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
	DOCUMENT_WORKER_PROCESSOR_VERSION,
	SDT_SCHEMA_VERSION,
} from '../../../src/versions.js';
import {
	SDT_SCHEMA_VERSION as SDT_PACKAGE_SCHEMA_VERSION,
} from '../../../structured-document-text/src/version.js';

describe('version constants', () => {
	it('uses an explicit semver processor version', () => {
		assert.match(DOCUMENT_WORKER_PROCESSOR_VERSION, /^[0-9]+\.[0-9]+\.[0-9]+$/u);
	});

	it('keeps the exported schema version in sync with structured-document-text', () => {
		assert.equal(SDT_SCHEMA_VERSION, SDT_PACKAGE_SCHEMA_VERSION);
	});
});

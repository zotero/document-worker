import '../../scripts/pdfjs-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { getFulltext, getStructure } from '../../src/pdf/index.js';
import { readFixtureSourceHash } from '../helpers/fixtures.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const buildDir = resolve(__dirname, '..', '..', 'build');
const pdfFixturesDir = resolve(__dirname, '..', 'fixtures', 'pdf');

function dataProvider(path) {
	return fs.readFileSync(resolve(buildDir, path));
}

describe('dataProvider integration', { timeout: 30000 }, () => {
	it('loads standard font data for a PDF with non-embedded fonts', async () => {
		let fetched = [];
		function trackingProvider(path) {
			fetched.push(path);
			return dataProvider(path);
		}

		let buf = fs.readFileSync(resolve(pdfFixturesDir, 'special', 'non-embedded-fonts.pdf'));
		let result = await getFulltext(buf, 1, '', trackingProvider);

		assert.equal(typeof result, 'object');
		assert.equal(typeof result.text, 'string');
		assert.ok(result.text.length > 0);

		let fontPaths = fetched.filter(p => p.startsWith('standard_fonts/'));
		assert.ok(fontPaths.length > 0);
	});

	it('loads CMap data for a PDF with CJK fonts', async () => {
		let fetched = [];
		function trackingProvider(path) {
			fetched.push(path);
			return dataProvider(path);
		}

		let buf = fs.readFileSync(resolve(pdfFixturesDir, 'special', 'cjk-cmap.pdf'));
		let result = await getFulltext(buf, 1, '', trackingProvider);

		assert.equal(typeof result, 'object');
		assert.equal(typeof result.text, 'string');
		assert.ok(result.text.length > 0);

		let cmapPaths = fetched.filter(p => p.startsWith('cmaps/'));
		assert.ok(cmapPaths.length > 0);
	});

	it('loads ONNX runtime and model for getStructure', { timeout: 120000 }, async () => {
		let fetched = [];
		function trackingProvider(path) {
			fetched.push(path);
			return dataProvider(path);
		}

		let buf = fs.readFileSync(resolve(pdfFixturesDir, 'full', '1.pdf'));
		let result = await getStructure(buf, '', trackingProvider, {
			sourceHash: readFixtureSourceHash('pdf', 'full', '1.pdf'),
		});

		assert.equal(typeof result, 'object');
		assert.ok(Array.isArray(result.catalog.pages));
		assert.ok(Array.isArray(result.content));
		assert.ok(result.content.length > 0);

		let onnxPaths = fetched.filter(p => p.startsWith('onnx/'));
		assert.ok(onnxPaths.length > 0);

		let modelPaths = fetched.filter(p => p.includes('/model.onnx'));
		assert.ok(modelPaths.length > 0);
	});

	it('loads openjpeg wasm through the data provider', () => {
		let bytes = dataProvider('wasm/openjpeg.wasm');
		assert.ok(bytes.byteLength > 0);
		assert.deepEqual(Array.from(bytes.subarray(0, 4)), [0x00, 0x61, 0x73, 0x6d]);
	});
});

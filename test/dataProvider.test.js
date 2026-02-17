/* eslint-env mocha, node */

import { expect } from 'chai';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { createCanvas } from 'canvas';
import * as pdfjs from '../pdf.js/build/lib-legacy/pdf.js';
import * as pdfjsWorker from '../pdf.js/build/lib-legacy/pdf.worker.js';
import { getFulltext, getStructure } from '../src/index.js';

globalThis.pdfjsWorker = pdfjsWorker;

const __dirname = dirname(fileURLToPath(import.meta.url));
const buildDir = resolve(__dirname, '..', 'build');

function dataProvider(path) {
	return fs.readFileSync(resolve(buildDir, path));
}

describe('dataProvider integration', function () {
	this.timeout(30000);

	it('loads standard font data for a PDF with non-embedded fonts', async function () {
		let fetched = [];
		function trackingProvider(path) {
			fetched.push(path);
			return dataProvider(path);
		}

		let buf = fs.readFileSync(resolve(__dirname, 'pdfs', 'special', 'non-embedded-fonts.pdf'));
		let result = await getFulltext(buf, 1, '', trackingProvider);

		expect(result).to.be.an('object');
		expect(result.text).to.be.a('string');
		expect(result.text.length).to.be.greaterThan(0);

		let fontPaths = fetched.filter(p => p.startsWith('standard_fonts/'));
		expect(fontPaths).to.have.length.greaterThan(0);
	});

	it('loads CMap data for a PDF with CJK fonts', async function () {
		let fetched = [];
		function trackingProvider(path) {
			fetched.push(path);
			return dataProvider(path);
		}

		let buf = fs.readFileSync(resolve(__dirname, 'pdfs', 'special', 'cjk-cmap.pdf'));
		let result = await getFulltext(buf, 1, '', trackingProvider);

		expect(result).to.be.an('object');
		expect(result.text).to.be.a('string');
		expect(result.text.length).to.be.greaterThan(0);

		let cmapPaths = fetched.filter(p => p.startsWith('cmaps/'));
		expect(cmapPaths).to.have.length.greaterThan(0);
	});

	it('loads ONNX runtime and model for getStructure', async function () {
		this.timeout(120000);
		let fetched = [];
		function trackingProvider(path) {
			fetched.push(path);
			return dataProvider(path);
		}

		let buf = fs.readFileSync(resolve(__dirname, 'pdfs', 'full', '1.pdf'));
		let result = await getStructure(buf, '', trackingProvider);

		expect(result).to.be.an('object');
		expect(result.pages).to.be.an('array');
		expect(result.content).to.be.an('array');
		expect(result.content.length).to.be.greaterThan(0);

		let onnxPaths = fetched.filter(p => p.startsWith('onnx/'));
		expect(onnxPaths).to.have.length.greaterThan(0);

		let modelPaths = fetched.filter(p => p.includes('/model.onnx'));
		expect(modelPaths).to.have.length.greaterThan(0);
	});

	it('loads openjpeg wasm for a PDF with JPEG2000 images', async function () {
		let fetched = [];
		function trackingProvider(path) {
			fetched.push(path);
			return dataProvider(path);
		}

		let buf = fs.readFileSync(resolve(__dirname, 'pdfs', 'special', 'jpeg2000.pdf'));
		let ownerDocument = {
			createElement: (name) => {
				if (name === 'canvas') return createCanvas(1, 1);
				return null;
			},
		};

		let pdfDoc = await pdfjs.getDocument({
			data: new Uint8Array(buf).buffer,
			ownerDocument,
			CMapReaderFactory: function () {
				this.fetch = async ({ name }) => {
					let raw = await trackingProvider('cmaps/' + name + '.bcmap');
					return { cMapData: raw, isCompressed: true };
				};
			},
			StandardFontDataFactory: function () {
				this.fetch = async ({ filename }) => trackingProvider('standard_fonts/' + filename);
			},
			WasmFactory: function () {
				this.fetch = async ({ filename }) => trackingProvider('wasm/' + filename);
			},
		}).promise;

		let page = await pdfDoc.getPage(1);
		let viewport = page.getViewport({ scale: 1 });
		let canvas = createCanvas(viewport.width, viewport.height);
		let ctx = canvas.getContext('2d');

		try {
			await page.render({ canvasContext: ctx, viewport }).promise;
		}
		catch (e) {
			// node-canvas doesn't support OffscreenCanvas drawImage; render may
			// fail after wasm is loaded — that's fine for this test.
		}

		let wasmPaths = fetched.filter(p => p.startsWith('wasm/'));
		expect(wasmPaths).to.include('wasm/openjpeg.wasm');
	});
});

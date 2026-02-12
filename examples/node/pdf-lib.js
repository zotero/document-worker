import { dirname } from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

// Define __dirname
const __dirname = dirname(fileURLToPath(import.meta.url));

import * as pdfWorker from '../../src/index.js';

async function cmapProvider(name) {
	// console.log('cmap requested:', name);
	let buf = fs.readFileSync(__dirname + '/../../pdf.js/external/bcmaps/' + name + '.bcmap');
	return {
		isCompressed: true,
		cMapData: buf
	};
}

async function standardFontProvider(filename) {
	// console.log('standard font requested:', filename);
	let buf = fs.readFileSync(__dirname + '/../../pdf.js/external/standard_fonts/' + filename);
	return buf;
}

async function onnxRuntimeProvider() {
	let buf = fs.readFileSync(__dirname + '/../../src/structure/model/onnx/ort-wasm-simd.wasm');
	return buf;
}

async function segmentationModelProvider() {
	let model = fs.readFileSync(__dirname + '/../../src/structure/segment/model.onnx');
	let crf = JSON.parse(fs.readFileSync(__dirname + '/../../src/structure/segment/model.crf.json'));
	return { model, crf };
}

export async function getStructure(buf) {
	return await pdfWorker.getStructure(buf, null, cmapProvider, standardFontProvider, onnxRuntimeProvider, segmentationModelProvider);
}

export async function getPdfData(buf) {
	let pages = await pdfWorker.getPages(buf, '', cmapProvider, standardFontProvider);
	return pages;
}

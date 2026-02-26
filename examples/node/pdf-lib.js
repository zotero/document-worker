import '../../scripts/pdfjs-setup.js';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

// Define __dirname
const __dirname = dirname(fileURLToPath(import.meta.url));

import * as pdfWorker from '../../src/index.js';

const baseDir = __dirname + '/../../pdf.js/external/';

async function dataProvider(path) {
	let filePath = baseDir + path;
	// Some checkouts store packed CMaps under "bcmaps" instead of "cmaps".
	if (!fs.existsSync(filePath) && path.startsWith('cmaps/')) {
		const fallbackPath = baseDir + path.replace(/^cmaps\//, 'bcmaps/');
		if (fs.existsSync(fallbackPath)) {
			filePath = fallbackPath;
		}
	}
	return fs.readFileSync(filePath);
}

export async function getStructure(buf) {
	return await pdfWorker.getStructure(buf, null, dataProvider);
}

export async function getPdfData(buf) {
	let pages = await pdfWorker.getPages(buf, '', dataProvider);
	return pages;
}

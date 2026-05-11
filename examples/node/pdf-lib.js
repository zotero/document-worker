import '../../scripts/pdfjs-setup.js';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import crypto from 'crypto';

// Define __dirname
const __dirname = dirname(fileURLToPath(import.meta.url));

import { getPages, getStructure } from '../../src/pdf/index.js';

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

function sourceHash(buf) {
	return crypto.createHash('md5').update(buf).digest('hex');
}

export async function getPdfStructure(buf) {
	return await getStructure(buf, null, dataProvider, { sourceHash: sourceHash(buf) });
}

export async function getPdfData(buf) {
	let pages = await getPages(buf, '', dataProvider);
	return pages;
}

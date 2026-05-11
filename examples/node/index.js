import crypto from 'crypto';
import fs from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

import { getStructuredDocumentText } from '../../src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function dataProvider(path) {
	return fs.readFileSync(resolve(__dirname, '../../build', path));
}

function sourceHash(buf) {
	return crypto.createHash('md5').update(buf).digest('hex');
}

async function main() {
	let buf = fs.readFileSync(resolve(__dirname, '../../test/fixtures/pdf/full/2.pdf'));
	let result = await getStructuredDocumentText(buf, {
		contentType: 'application/pdf',
		password: '',
		dataProvider,
		sourceHash: sourceHash(buf),
	});

	console.log(`SDT pack: ${result.buf.byteLength} bytes`);
}

main();

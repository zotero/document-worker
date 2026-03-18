import '../scripts/pdfjs-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { getStructure } from '../src/pdf/index.js';
import stringify from 'json-stringify-pretty-compact';

const __dirname = dirname(fileURLToPath(import.meta.url));
const buildDir = resolve(__dirname, '..', 'build');
const pdfsDir = resolve(__dirname, 'pdfs', 'full');

function dataProvider(path) {
	return fs.readFileSync(resolve(buildDir, path));
}

// Auto-discover test cases: each .pdf with a corresponding .json snapshot
let pdfFiles = fs.readdirSync(pdfsDir)
	.filter(f => f.endsWith('.pdf'))
	.filter(f => fs.existsSync(resolve(pdfsDir, f.replace('.pdf', '.json'))));

describe('getStructure snapshots', { timeout: 120000 }, () => {
	for (let pdfFile of pdfFiles) {
		let name = pdfFile.replace('.pdf', '');
		let pdfPath = resolve(pdfsDir, pdfFile);
		let snapshotPath = resolve(pdfsDir, name + '.json');

		it(pdfFile, async (t) => {
			let buf = fs.readFileSync(pdfPath);
			let result = await getStructure(buf, '', dataProvider);

			// Strip non-deterministic field
			delete result.dateCreated;

			let json = stringify(result, { indent: '\t', maxLength: 100 });

			if (process.env.UPDATE_SNAPSHOTS) {
				fs.writeFileSync(snapshotPath, json + '\n', 'utf8');
				t.skip();
			}
			else {
				let expected = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
				assert.deepEqual(result, expected);
			}
		});
	}
});

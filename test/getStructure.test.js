/* eslint-env mocha, node */

import { expect } from 'chai';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { getStructure } from '../src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const buildDir = resolve(__dirname, '..', 'build');
const pdfsDir = resolve(__dirname, 'pdfs', 'full');

function dataProvider(path) {
	return fs.readFileSync(resolve(buildDir, path));
}

// Auto-discover test cases: each .pdf with a corresponding .zst.json snapshot
let pdfFiles = fs.readdirSync(pdfsDir)
	.filter(f => f.endsWith('.pdf'))
	.filter(f => fs.existsSync(resolve(pdfsDir, f.replace('.pdf', '.zst.json'))));

describe('getStructure snapshots', function () {
	this.timeout(120000);

	for (let pdfFile of pdfFiles) {
		let name = pdfFile.replace('.pdf', '');
		let pdfPath = resolve(pdfsDir, pdfFile);
		let snapshotPath = resolve(pdfsDir, name + '.zst.json');

		it(pdfFile, async function () {
			let buf = fs.readFileSync(pdfPath);
			let result = await getStructure(buf, '', dataProvider);

			// Strip non-deterministic field
			delete result.dateCreated;

			let json = JSON.stringify(result, null, '\t');

			if (process.env.UPDATE_SNAPSHOTS) {
				fs.writeFileSync(snapshotPath, json + '\n', 'utf8');
				this.skip();
			}
			else {
				let expected = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
				expect(result).to.deep.equal(expected);
			}
		});
	}
});

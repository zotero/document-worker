import fs from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const fixturesRoot = resolve(repoRoot, 'test', 'fixtures');

export function fixturePath(...parts) {
	return resolve(fixturesRoot, ...parts);
}

export function readFixture(...parts) {
	return fs.readFileSync(fixturePath(...parts));
}

export function readFixtureArrayBuffer(...parts) {
	let buf = readFixture(...parts);
	return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

export function sampleZoteroAnnotations() {
	return [{
		id: 'AAAABBBB',
		type: 'highlight',
		color: '#f8c348',
		position: {
			pageIndex: 0,
			rects: [
				[231.284, 402.126, 293.107, 410.142],
				[54, 392.164, 293.107, 400.18],
				[54, 382.201, 293.107, 390.217],
				[54, 372.238, 293.107, 380.254],
				[54, 362.276, 273.955, 370.292],
			],
		},
		authorName: 'John',
		text: 'We present an alternative compilation technique for dynamically-typed languages that identifies frequently executed loop traces at run-time and then generates machine code on the fly that is specialized for the actual dynamic types occurring on each path through the loop',
		comment: 'Sounds promising',
		dateModified: '2020-02-07T07:24:34.638Z',
		tags: ['tag1'],
	}];
}

export function sampleMendeleyAnnotations() {
	return [{
		id: 1,
		type: 'note',
		page: 2,
		x: 446.040241448692,
		y: 657.971830985916,
	}, {
		type: 'highlight',
		page: 1,
		rects: [{
			x1: 108.094,
			y1: 257.801,
			x2: 295.598,
			y2: 269.051,
		}],
	}];
}

export function sampleCitaviAnnotations() {
	return [{
		key: 'B3UENNWP',
		type: 'highlight',
		text: null,
		position: {
			pageIndex: 0,
			rects: [[230.20219999999998, 578.879472, 275.47790585937497, 585.816528]],
		},
		pageLabel: '',
		dateAdded: '2022-02-18T17:24:15',
		dateModified: '2022-02-18T17:24:24',
		tags: [{ name: 'red' }],
		color: '#ff6666',
	}];
}

export function sampleRenderableAnnotations() {
	return [{
		id: 'render-test',
		color: '#f8c348',
		position: {
			pageIndex: 0,
			rects: [[231.284, 402.126, 293.107, 410.142]],
		},
	}];
}

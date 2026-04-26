/*
 ***** BEGIN LICENSE BLOCK *****

 This file is part of the Zotero Data Server.

 Copyright © 2020 Center for History and New Media
 George Mason University, Fairfax, Virginia, USA
 http://zotero.org

 This program is free software: you can redistribute it and/or modify
 it under the terms of the GNU Affero General Public License as published by
 the Free Software Foundation, either version 3 of the License, or
 (at your option) any later version.

 This program is distributed in the hope that it will be useful,
 but WITHOUT ANY WARRANTY; without even the implied warranty of
 MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 GNU Affero General Public License for more details.

 You should have received a copy of the GNU Affero General Public License
 along with this program.  If not, see <http://www.gnu.org/licenses/>.

 ***** END LICENSE BLOCK *****
 */
import '../../scripts/pdfjs-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import crypto from 'crypto';
import * as pdfWorker from '../../src/pdf/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pdfFixturesDir = path.join(__dirname, '..', 'fixtures', 'pdf');

describe('PDF Worker', function () {
	it('should import annotations', async function () {
		let buf = fs.readFileSync(path.join(pdfFixturesDir, 'full', '1.pdf'));
		let result = await pdfWorker.importAnnotations(buf, []);

		let expectedResult = {
			imported: [{
				type: 'highlight',
				position: { pageIndex: 0, rects: [[328, 395, 557, 406], [317, 385, 455, 396]] },
				dateModified: '2019-06-05T13:52:44.000Z',
				authorName: '',
				comment: 'A comment for the highlighted text',
				color: '#ffff00',
				pageLabel: '1',
				text: 'Compilers for statically typed languages rely on type information to generate efficient machine code',
				sortIndex: '00000|002514|00386',
				tags: [],
				transferable: true
			}, {
				type: 'highlight',
				position: {
					pageIndex: 0,
					rects: [[231.284, 402.126, 293.107, 410.142], [54, 392.164, 293.107, 400.18], [54, 382.201, 293.107, 390.217], [54, 372.238, 293.107, 380.254], [54, 362.276, 273.955, 370.292]]
				},
				dateModified: '2020-02-07T07:24:34.000Z',
				authorName: '',
				comment: 'Sounds promising',
				color: '#c9222a',
				pageLabel: '1',
				text: 'We present an alternative compilation technique for dynamically-typed languages that identifies frequently executed loop traces at run-time and then generates machine code on the fly that is specialized for the actual dynamic types occurring on each path through the loop',
				sortIndex: '00000|000779|00381',
				tags: [],
				transferable: true
			}, {
				type: 'highlight',
				position: { pageIndex: 0, rects: [[54, 199.237, 293.1, 207.253], [54, 189.274, 67.943, 197.29]] },
				dateModified: '2020-02-07T07:24:37.000Z',
				authorName: '',
				comment: 'Comment 2',
				color: '#589fee',
				pageLabel: '1',
				text: 'Dynamic languages such as JavaScript, Python, and Ruby, are popular',
				sortIndex: '00000|001536|00584',
				tags: [],
				transferable: true
			}, {
				type: 'highlight',
				position: {
					pageIndex: 0,
					rects: [[54, 199.237, 293.1, 207.253], [54, 189.274, 293.107, 197.29], [54, 179.311, 293.107, 187.327], [54, 169.349, 234.673, 177.365]]
				},
				dateModified: '2020-02-07T07:23:13.000Z',
				authorName: '',
				comment: 'Comment 1',
				color: '#f8c348',
				pageLabel: '1',
				text: 'Dynamic languages such as JavaScript, Python, and Ruby, are popular since they are expressive, accessible to non-experts, and make deployment as easy as distributing a source file. They are used for small scripts as well as for complex applications',
				sortIndex: '00000|001536|00584',
				tags: [],
				transferable: true
			}, {
				type: 'highlight',
				position: {
					pageIndex: 0,
					rects: [[328.969, 196.896, 556.115, 204.912], [317.014, 186.933, 556.121, 194.949], [317.014, 176.971, 556.121, 184.987], [317.014, 167.008, 398.671, 175.024]]
				},
				dateModified: '2020-02-07T07:23:32.000Z',
				authorName: '',
				comment: 'An important point',
				color: '#589fee',
				pageLabel: '1',
				text: 'Unlike method-based dynamic compilers, our dynamic compiler operates at the granularity of individual loops. This design choice is based on the expectation that programs spend most of their time in hot loops',
				sortIndex: '00000|003552|00587',
				tags: [],
				transferable: true
			}, {
				type: 'note',
				position: { pageIndex: 1, rects: [[343.157, 557.388, 365.157, 579.388]] },
				dateModified: '2019-06-05T13:53:32.000Z',
				authorName: '',
				comment: 'Another comment',
				color: '#ffff00',
				pageLabel: '2',
				sortIndex: '00001|003623|00212',
				tags: [],
				transferable: true
			}, {
				type: 'highlight',
				position: {
					pageIndex: 1,
					rects: [[65.955, 620.429, 293.101, 628.445], [54, 610.467, 293.106, 618.528], [54, 600.504, 177.745, 608.52]]
				},
				dateModified: '2020-02-07T07:23:50.000Z',
				authorName: '',
				comment: 'A problem of nested loops',
				color: '#6cc055',
				pageLabel: '2',
				text: 'Nested loops can be difficult to optimize for tracing VMs. In a na ̈ıve implementation, inner loops would become hot first, and the VM would start tracing there.',
				sortIndex: '00001|000459|00163',
				tags: [],
				transferable: true
			}, {
				type: 'highlight',
				position: { pageIndex: 1, rects: [[54, 470.99, 293.107, 479.006], [54, 461.027, 268.978, 469.043]] },
				dateModified: '2020-02-07T07:24:04.000Z',
				authorName: '',
				comment: '',
				color: '#f8c348',
				pageLabel: '2',
				text: 'The system stops extending the inner tree when it reaches an outer loop, but then it starts a new trace at the outer loop header.',
				sortIndex: '00001|001247|00312',
				tags: [],
				transferable: true
			}, {
				type: 'highlight',
				position: {
					pageIndex: 1,
					rects: [[65.955, 301.625, 293.101, 309.641], [54, 291.662, 293.104, 299.678], [54, 281.7, 293.107, 289.716], [54, 271.737, 263.85, 279.753]]
				},
				dateModified: '2020-02-07T07:24:12.000Z',
				authorName: '',
				comment: '',
				color: '#f8c348',
				pageLabel: '2',
				text: 'We implemented these techniques for an existing JavaScript interpreter, SpiderMonkey. We call the resulting tracing VM TraceMonkey. TraceMonkey supports all the JavaScript features of SpiderMonkey, with a 2x-20x speedup for traceable programs',
				sortIndex: '00001|002143|00482',
				tags: [],
				transferable: true
			}, {
				type: 'note',
				position: { pageIndex: 1, rects: [[478.3, 697, 500.3, 719]] },
				dateModified: '2020-02-07T07:23:40.000Z',
				authorName: '',
				comment: 'Use this in my thesis',
				color: '#f8c348',
				pageLabel: '2',
				sortIndex: '00001|003310|00073',
				tags: [],
				transferable: true
			}, {
				type: 'highlight',
				position: {
					pageIndex: 1,
					rects: [[328.969, 176.096, 556.115, 184.112], [317.014, 166.133, 376.291, 174.149]]
				},
				dateModified: '2020-02-07T07:24:24.000Z',
				authorName: '',
				comment: '',
				color: '#f8c348',
				pageLabel: '2',
				text: 'TraceMonkey always begins executing a program in the bytecode interpreter.',
				sortIndex: '00001|004682|00607',
				tags: [],
				transferable: true
			}, {
				type: 'highlight',
				position: {
					pageIndex: 1,
					rects: [[338.883, 136.245, 556.121, 144.261], [317.014, 126.282, 556.121, 134.298], [317.014, 116.32, 534.474, 124.336]]
				},
				dateModified: '2020-02-07T07:24:29.000Z',
				authorName: '',
				comment: '',
				color: '#f8c348',
				pageLabel: '2',
				text: 'At the start of execution, there are no compiled traces yet, so the trace monitor counts the number of times each loop back edge is executed until a loop becomes hot, currently after 2 crossings',
				sortIndex: '00001|004901|00647',
				tags: [],
				transferable: true
			}], deleted: []
		};

		assert.deepEqual(result, expectedResult);
	});

	it('should write annotations', async function () {
		let annotations = [{
			'id': 'AAAABBBB',
			'type': 'highlight',
			'color': '#f8c348',
			'position': {
				'pageIndex': 0,
				'rects': [
					[231.284, 402.126, 293.107, 410.142],
					[54, 392.164, 293.107, 400.18],
					[54, 382.201, 293.107, 390.217],
					[54, 372.238, 293.107, 380.254],
					[54, 362.276, 273.955, 370.292]
				]
			},
			'authorName': 'John',
			'text': 'We present an alternative compilation technique for dynamically-typed languages that identifies frequently executed loop traces at run-time and then generates machine code on the fly that is specialized for the actual dynamic types occurring on each path through the loop',
			'comment': 'Sounds promising',
			'dateModified': '2020-02-07T07:24:34.638Z',
			'tags': ['tag1', 'tag2', 'tag3']
		},
		{
			'id': 'BBBBCCCC',
			'type': 'ink',
			'color': '#589fee',
			'position': {
				'pageIndex': 0,
				'width': 2.4774284,
				'paths': [
					[78.4, 657.59996, 84.8, 664, 90.4, 670.40004, 97.6, 676.8, 104, 682.4, 110.4, 689.6, 112, 679.2, 112, 669.59996, 112, 661.59996, 112, 652.8, 112, 644, 110.4, 636, 108, 627.2, 106.4, 616.8, 106.4, 605.59996, 105.6, 597.59996, 104.8, 589.59996, 104, 581.59996, 104, 573.59996],
					[176.8, 659.2, 176, 667.2, 180, 675.2, 188, 678.4, 196, 680.8, 204, 682.4, 212.8, 682.4, 218.4, 675.2, 218.4, 666.40004, 218.4, 657.59996, 218.4, 648.8, 210.4, 641.59996, 203.2, 637.59996, 195.2, 631.2, 189.6, 624.8, 184, 617.59996, 180.8, 608.8, 180, 600.8, 179.2, 592.8, 176, 584, 182.4, 578.40004, 191.2, 578.40004, 200, 578.40004, 208.8, 577.59996, 218.4, 577.59996, 228, 577.59996, 232.8, 577.59996]
				]
			},
			'authorName': 'John',
			'dateModified': '2021-08-20T07:24:34.638Z',
			'tags': ['tag1', 'tag2', 'tag3']
		}];

			let buf = fs.readFileSync(path.join(pdfFixturesDir, 'full', '1.pdf'));
		buf = await pdfWorker.writeAnnotations(buf, annotations);
		var buffer = Buffer.from(buf);
		let md5 = crypto.createHash('md5').update(buffer).digest('hex');
		// console.log(md5);
		// fs.writeFileSync(__dirname + '/1-out.pdf', buffer);
	});

	it('should preserve annotation text outside the BMP', async function () {
		let buf = fs.readFileSync(path.join(pdfFixturesDir, 'full', '1.pdf'));
		let comment = 'Emoji comment \u{1f600}';
		let authorName = 'Emoji author \u{1f600}';
		let tags = ['tag-\u{1f600}'];
		let written = await pdfWorker.writeAnnotations(buf, [{
			id: 'EMOJI0001',
			type: 'note',
			color: '#f8c348',
			position: {
				pageIndex: 0,
				rects: [[100, 100, 122, 122]]
			},
			authorName,
			comment,
			dateModified: '2026-01-02T03:04:05.000Z',
			tags
		}]);

		let result = await pdfWorker.importAnnotations(written, []);
		let imported = result.imported.find(annotation => annotation.comment === comment);

		assert.ok(imported);
		assert.equal(imported.authorName, authorName);
		assert.deepEqual(imported.tags, tags);
	});

	it('should import Mendeley annotations', async function () {
			let buf = fs.readFileSync(path.join(pdfFixturesDir, 'full', '2.pdf'));
		let mendeleyAnnotations = [
			{
				id: 1,
				type: 'note',
				page: 2,
				x: 446.040241448692,
				y: 657.971830985916
			},
			{
				type: 'highlight',
				page: 1,
				rects: [
					{
						x1: 108.094,
						y1: 257.801,
						x2: 295.598,
						y2: 269.051
					},
					{
						x1: 108.094,
						y1: 270.258,
						x2: 503.574,
						y2: 280.758
					},
					{
						x1: 108.094,
						y1: 281.859,
						x2: 503.705,
						y2: 292.359
					}
				]
			},
			{
				type: 'highlight',
				page: 2,
				rects: [
					{
						x1: 166.2053,
						y1: 375.23994140625,
						x2: 503.8281,
						y2: 384.41279296875
					},
					{
						x1: 108.1,
						y1: 363.62021484375,
						x2: 503.5352,
						y2: 372.81279296875
					},
					{
						x1: 108.1,
						y1: 352.418310546875,
						x2: 503.953758203125,
						y2: 361.11279296875
					}
				]
			},
			{
				type: 'highlight',
				page: 2,
				rects: [
					{
						x1: 171.995975855131,
						y1: 641.070422535211,
						x2: 443.625754527163,
						y2: 475.074446680081
					}
				]
			},
			{
				type: 'highlight',
				page: 2,
				rects: [
					{
						x1: 166.2053,
						y1: 375.23994140625,
						x2: 503.8281,
						y2: 384.41279296875
					}
				]
			},
			{
				type: 'highlight',
				page: 2,
				rects: [
					{
						x1: 298.0,
						y1: 594.22685546875,
						x2: 302.66004196,
						y2: 600.7107421875
					}
				]
			}
		];
		let annotations = await pdfWorker.importMendeleyAnnotations(buf, mendeleyAnnotations);

		let result = [{
			id: 1,
			position: {
				pageIndex: 1,
				rects: [[435.04, 646.972, 457.04, 668.972]]
			}, type: 'note', pageLabel: '2', sortIndex: '00001|000162|00123'
		}, {
			position: {
				pageIndex: 0,
				rects: [[108.094, 281.859, 503.705, 292.359], [108.094, 270.258, 503.574, 280.758], [108.094, 257.801, 295.598, 269.051]]
			},
			type: 'highlight',
			pageLabel: '1',
			text: 'be wary of their customers, hassling them for more information than they would otherwise need. A certain percentage of fraud is accepted as unavoidable. These costs and payment uncertainties can be avoided in person by using physical cu',
			sortIndex: '00000|001702|00499'
		}, {
			position: {
				pageIndex: 1,
				rects: [[166.205, 375.24, 503.828, 384.413], [108.1, 363.62, 503.535, 372.813], [108.1, 352.418, 503.954, 361.113]]
			},
			type: 'highlight',
			pageLabel: '2',
			text: 'For our purposes, the earliest transaction is the one that counts, so we don\'t care about later attempts to double-spend. The only way to confirm the absence of a transaction is to be aware of all transactions. In the mint based model, the mint was aware of all transactions and',
			sortIndex: '00001|000817|00407'
		}, {
			position: { pageIndex: 1, rects: [[171.996, 475.074, 443.626, 641.07]] },
			type: 'image',
			pageLabel: '2',
			sortIndex: '00001|001769|00150'
		}, {
			position: { pageIndex: 1, rects: [[166.205, 375.24, 503.828, 384.413]] },
			type: 'highlight',
			pageLabel: '2',
			text: 'For our purposes, the earliest transaction is the one that counts, so we don\'t care',
			sortIndex: '00001|000817|00407'
		}, {
			pageLabel: '2',
			position: {
				pageIndex: 1,
				rects: [
					[
						298,
						594.227,
						302.66,
						600.711
					]
				]
			},
			text: 'P',
			sortIndex: '00001|001837|00191',
			type: 'highlight'
		}];

		assert.deepEqual(annotations, result);
	});

	it('should process Citavi annotations', async () => {
		const citaviAnnotation = {
			key: 'B3UENNWP',
			type: 'highlight',
			text: null,
			position:
			{
				pageIndex: 0,
				rects: [
					[
						230.20219999999998,
						578.879472,
						275.47790585937497,
						585.816528
					],
					[
						230.20219999999998,
						578.879472,
						275.47790585937497,
						585.816528
					]
				]
			},
			pageLabel: '',
			dateAdded: '2022-02-18T17:24:15',
			dateModified: '2022-02-18T17:24:24',
			tags: [{ name: 'red' }],
			color: '#ff6666'
		};
			const buf = fs.readFileSync(path.join(pdfFixturesDir, 'full', '2.pdf'));
		const [processedAnnotations] = await pdfWorker.importCitaviAnnotations(buf, [citaviAnnotation]);
		assert.equal(processedAnnotations.key, 'B3UENNWP');
		assert.equal(processedAnnotations.sortIndex, '00000|000103|00206');
		assert.equal(processedAnnotations.text, 'peer-to-peer');
		assert.equal(processedAnnotations.pageLabel, '1');
		assert.deepEqual(processedAnnotations.position.rects[0], [230.202, 578.879, 275.478, 585.817]);
	});
});

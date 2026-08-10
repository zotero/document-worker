import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
	getAnnotLinkRefs,
	getLinksFromAnnotations,
	getUnderlyingTextRange,
	getUnderlyingTextRanges,
} from '../../src/pdf/structure/link.js';

function blockText(text, glyphs, pageIndex = 0) {
	let rects = Array(text.length).fill(null);
	let pageIndexes = Array(text.length).fill(null);
	for (let [offset, rect] of glyphs) {
		rects[offset] = rect;
		pageIndexes[offset] = pageIndex;
	}
	return { text, rects, pageIndexes };
}

function horizontalBlockText(text, pageIndex = 0) {
	let glyphs = [];
	for (let i = 0; i < text.length; i++) {
		if (!/\s/u.test(text[i])) {
			glyphs.push([i, [i, 0, i + 1, 1]]);
		}
	}
	return blockText(text, glyphs, pageIndex);
}

describe('PDF annotation links', () => {
	it('uses annotation quad points as precise source rectangles', async () => {
		let page = {
			pageIndex: 2,
			_parsedAnnotations: [{
				data: {
					url: 'https://example.com/',
					rect: [0, 0, 100, 20],
					quadPoints: new Float32Array([
						10, 20, 40, 20, 10, 12, 40, 12,
						0, 10, 25, 10, 0, 2, 25, 2,
					]),
				},
			}],
		};

		let [link] = await getLinksFromAnnotations(null, page);

		assert.deepEqual(link.src, {
			pageIndex: 2,
			rect: [0, 0, 100, 20],
			rects: [[10, 12, 40, 20], [0, 2, 25, 10]],
		});
	});

	it('falls back to the annotation rectangle without valid quad points', async () => {
		let page = {
			pageIndex: 0,
			_parsedAnnotations: [{
				data: {
					url: 'https://example.com/',
					rect: [1, 2, 3, 4],
					quadPoints: new Float32Array([1, 2, 3]),
				},
			}],
		};

		let [link] = await getLinksFromAnnotations(null, page);

		assert.deepEqual(link.src.rects, [[1, 2, 3, 4]]);
	});

	it('falls back to the annotation rectangle without positive-area quad points', async () => {
		let page = {
			pageIndex: 0,
			_parsedAnnotations: [{
				data: {
					url: 'https://example.com/',
					rect: [0, 0, 4, 1],
					quadPoints: new Float32Array(8),
				},
			}],
		};

		let [link] = await getLinksFromAnnotations(null, page);
		let bt = horizontalBlockText('Link');
		let structureIndex = {
			withPageEntries(pageIndex, callback) {
				assert.equal(pageIndex, 0);
				return callback([{
					blockRef: [0],
					blockRefKey: '0',
					bt,
					pageRect: [0, 0, 4, 1],
				}]);
			},
		};
		let refs = getAnnotLinkRefs({}, new Map([[0, [link]]]), structureIndex);

		assert.deepEqual(link.src.rects, [[0, 0, 4, 1]]);
		assert.equal(refs.get('0')[0].src.text, 'Link');
	});

	it('keeps valid quad points while discarding degenerate ones', async () => {
		let page = {
			pageIndex: 0,
			_parsedAnnotations: [{
				data: {
					url: 'https://example.com/',
					rect: [0, 0, 100, 20],
					quadPoints: new Float32Array([
						0, 0, 0, 0, 0, 0, 0, 0,
						10, 20, 40, 20, 10, 12, 40, 12,
					]),
				},
			}],
		};

		let [link] = await getLinksFromAnnotations(null, page);

		assert.deepEqual(link.src.rects, [[10, 12, 40, 20]]);
	});

	it('splits linked ranges around geometrically unmatched text', () => {
		let bt = horizontalBlockText('ABXCD');
		bt.rects[2] = [2, 2, 3, 3];

		let ranges = getUnderlyingTextRanges(bt, {
			pageIndex: 0,
			rect: [0, 0, bt.text.length, 1],
		});

		assert.deepEqual(ranges, [{
			offsetStart: 0,
			offsetEnd: 1,
			text: 'AB',
		}, {
			offsetStart: 3,
			offsetEnd: 4,
			text: 'CD',
		}]);
	});

	it('uses multiple source rectangles for a wrapped link', () => {
		let text = 'prefix Creative Commons Attribution 4.0 International suffix';
		let linkStart = text.indexOf('Creative');
		let secondLineStart = text.indexOf('Attribution');
		let linkEnd = text.indexOf(' International') + ' International'.length - 1;
		let glyphs = [];
		for (let i = 0; i < text.length; i++) {
			if (/\s/u.test(text[i])) {
				continue;
			}
			let secondLine = i >= secondLineStart;
			let x = secondLine ? i - secondLineStart : i;
			glyphs.push([i, [x, secondLine ? 0 : 2, x + 1, secondLine ? 1 : 3]]);
		}
		let bt = blockText(text, glyphs);

		let range = getUnderlyingTextRange(bt, {
			pageIndex: 0,
			rect: [0, 0, text.length, 3],
			rects: [
				[linkStart, 2, secondLineStart - 1, 3],
				[0, 0, linkEnd - secondLineStart + 1, 1],
			],
		});

		assert.equal(range.text, 'Creative Commons Attribution 4.0 International');
		assert.equal(range.offsetStart, linkStart);
		assert.equal(range.offsetEnd, linkEnd);
	});

	it('uses significant glyph overlap for a tiny partial-glyph link', () => {
		let bt = horizontalBlockText('(b)');

		let range = getUnderlyingTextRange(bt, {
			pageIndex: 0,
			rect: [0, 0, 1.2, 1],
		});

		assert.deepEqual(range, {
			offsetStart: 0,
			offsetEnd: 1,
			text: '(b',
		});
	});

	it('keeps symbol-only text with exact center evidence', () => {
		for (let symbol of ['†', '*', '§', '→']) {
			let bt = horizontalBlockText(symbol);
			let range = getUnderlyingTextRange(bt, {
				pageIndex: 0,
				rect: [0, 0, 1, 1],
			});

			assert.deepEqual(range, {
				offsetStart: 0,
				offsetEnd: 0,
				text: symbol,
			});
		}
	});

	it('does not expand a center-matched symbol using weaker overlap evidence', () => {
		let range = getUnderlyingTextRange(horizontalBlockText('†A'), {
			pageIndex: 0,
			rect: [0, 0, 1.2, 1],
		});

		assert.deepEqual(range, {
			offsetStart: 0,
			offsetEnd: 0,
			text: '†',
		});
	});

	it('rejects punctuation-only partial overlap from a graphical link', () => {
		let range = getUnderlyingTextRange(horizontalBlockText('Author,'), {
			pageIndex: 0,
			rect: [6, 0, 6.2, 1],
		});

		assert.deepEqual(range, { offsetStart: null, offsetEnd: null, text: '' });
	});

	it('discards conflicting destinations resolved from one disjoint internal link', () => {
		let sourceText = horizontalBlockText('ABXCD');
		sourceText.rects[2] = [2, 2, 3, 3];
		let sourceEntries = [{
			blockRef: [0],
			blockRefKey: '0',
			bt: sourceText,
			pageRect: [0, 0, 5, 3],
		}];
		let destinationEntries = [{
			blockRef: [1],
			block: { type: 'heading' },
			bt: horizontalBlockText('AB', 1),
		}, {
			blockRef: [2],
			block: { type: 'heading' },
			bt: horizontalBlockText('CD', 1),
		}];
		let structureIndex = {
			withPageEntries(pageIndex, callback) {
				return callback(pageIndex === 0 ? sourceEntries : destinationEntries);
			},
		};
		let refs = getAnnotLinkRefs({}, new Map([[
			0,
			[{
				src: { pageIndex: 0, rect: [0, 0, 5, 1] },
				dest: { pageIndex: 1, rect: [0, 0, 2, 1] },
			}],
		]]), structureIndex);

		assert.deepEqual(refs.get('0').map(ref => ref.dest), [undefined, undefined]);
	});

});

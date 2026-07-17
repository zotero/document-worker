import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
	applyBlockClassifierPredictions,
	collapsePaintScenes,
	compactExcessiveImageBlocks,
	enforceStandaloneGraphicQuality,
	MAX_IMAGE_BLOCKS_PER_PAGE,
	refineGraphicBlocks,
} from '../../src/pdf/structure/model/block-seg/inference.js';

function line(id, text, rect, startOffset = id) {
	return {
		id,
		text,
		rect,
		startOffset,
		endOffset: startOffset,
	};
}

function countImages(blocks) {
	return blocks.filter(block => block.type === 'image').length;
}

function rectContains(outer, inner) {
	return outer[0] <= inner[0]
		&& outer[1] <= inner[1]
		&& outer[2] >= inner[2]
		&& outer[3] >= inner[3];
}

function ruledGridObjects() {
	return [
		{ type: 'object', subtype: 'path', rect: [5, 45, 85, 46] },
		{ type: 'object', subtype: 'path', rect: [5, 65, 85, 66] },
		{ type: 'object', subtype: 'path', rect: [5, 85, 85, 86] },
	];
}

describe('applyBlockClassifierPredictions', () => {
	it('uses the block classifier independently from flow class', () => {
		const blocks = [
			{ type: 'body' },
			{ type: 'title' },
			{ type: 'table' },
		];

		applyBlockClassifierPredictions(blocks, [
			{ blockTypeName: 'caption', flowClassName: 'excluded' },
			{ blockTypeName: 'paragraph', flowClassName: 'auxiliary' },
			null,
		]);

		assert.deepEqual(blocks, [
			{ type: 'caption', flowClass: 'excluded' },
			{ type: 'body', flowClass: 'auxiliary' },
			{ type: 'table', flowClass: 'body' },
		]);
		assert.equal('modelBlockType' in blocks[0], false);
	});
});

describe('collapsePaintScenes', () => {
	const pageRect = [0, 0, 100, 100];

	function formFixture(rect = [20, 20, 80, 80], fragmentCount = 33) {
		const lines = [line(0, 'before', [5, 90, 45, 98], 0)];
		for (let index = 0; index < fragmentCount; index++) {
			const x = 20 + (index % 6) * 8;
			const y = 20 + Math.floor(index / 6) * 8;
			lines.push({
				...line(index + 1, String(index), [x, y, x + 4, y + 6], index + 1),
				formXObjectSeqs: [10],
				chars: [{
					fontName: 'marker-font',
					paintGlyph: 17,
				}],
			});
		}
		lines.push(line(lines.length, 'after', [5, 5, 45, 13], lines.length));
		return {
			lines,
			blocks: [{
				type: 'body',
				flowClass: 'body',
				bbox: [5, 5, 80, 98],
				lines: lines.map(item => item.id),
				startOffset: 0,
				endOffset: lines.length - 1,
			}],
			scenes: [{
				seq: 10,
				rect,
				paintObjectCount: 100,
				textCharCount: fragmentCount,
				formXObjectSeqs: [10],
			}],
		};
	}

	function fragmentFixture({
		rect,
		chars = null,
	}) {
		const lines = Array.from({ length: 33 }, (_, index) => ({
			...line(index, `text ${index}`, rect(index), index),
			...(chars ? { chars: chars(index) } : {}),
		}));
		const blocks = lines.map(item => ({
			type: 'body',
			flowClass: 'auxiliary',
			bbox: item.rect,
			lines: [item.id],
			startOffset: item.startOffset,
			endOffset: item.endOffset,
		}));
		return { lines, blocks, scenes: [] };
	}

	function collapse(fixture, validObjects = []) {
		return collapsePaintScenes(
			fixture.blocks,
			fixture.lines,
			fixture.scenes,
			pageRect,
			{ validObjects },
		);
	}

	it('uses actual painted Form bounds and preserves surrounding text', () => {
		const fixture = formFixture();
		fixture.blocks.push({
			type: 'image',
			flowClass: 'auxiliary',
			bbox: [82, 20, 98, 80],
			lines: [],
			startOffset: 0,
			endOffset: -1,
		});

		const collapsed = collapse(fixture, [{ bbox: [20, 20, 80, 80] }]);

		assert.deepEqual(collapsed.map(block => block.type), ['body', 'image', 'image', 'body']);
		assert.deepEqual(collapsed[2].bbox, [20, 20, 80, 80]);
		assert.deepEqual(collapsed[2].lines, []);
		assert.deepEqual(collapsed[2]._charRanges, []);
		assert.deepEqual(collapsed[0].lines, [0]);
		assert.deepEqual(collapsed[3].lines, [34]);
	});

	it('does not treat a declared full-page Form as a scene', () => {
		const fixture = formFixture(pageRect);
		assert.equal(
			collapse(fixture, [{ bbox: [20, 20, 80, 80] }]),
			fixture.blocks,
		);
	});

	it('requires fragmented paint evidence in addition to Form complexity', () => {
		const fixture = formFixture([20, 20, 80, 80], 32);
		assert.equal(
			collapse(fixture, [{ bbox: [20, 20, 80, 80] }]),
			fixture.blocks,
		);
	});

	it('preserves text-dominant Forms', () => {
		const fixture = formFixture();
		fixture.scenes[0].textCharCount = fixture.scenes[0].paintObjectCount * 3 + 1;
		assert.equal(
			collapse(fixture, [{ bbox: [20, 20, 80, 80] }]),
			fixture.blocks,
		);
	});

	it('does not infer Form text density when extraction metadata is missing', () => {
		const fixture = formFixture();
		delete fixture.scenes[0].textCharCount;
		assert.equal(
			collapse(fixture, [{ bbox: [20, 20, 80, 80] }]),
			fixture.blocks,
		);
	});

	it('does not subdivide an existing image with a contained Form scene', () => {
		const fixture = formFixture();
		fixture.blocks.push({
			type: 'image',
			flowClass: 'auxiliary',
			bbox: [10, 10, 90, 90],
			lines: [],
			startOffset: 0,
			endOffset: -1,
		});

		assert.equal(collapse(fixture, [{ bbox: [10, 10, 90, 90] }]), fixture.blocks);
	});

	it('keeps a graphic-only Form scene free of unrelated text ranges', () => {
		const fixture = {
			lines: [],
			blocks: Array.from({ length: 33 }, (_, index) => ({
				type: 'image',
				flowClass: 'auxiliary',
				bbox: [20 + index % 6, 20 + Math.floor(index / 6), 21 + index % 6, 21 + Math.floor(index / 6)],
				lines: [],
				startOffset: 0,
				endOffset: -1,
			})),
			scenes: [{
				seq: 10,
				rect: [20, 20, 80, 80],
				paintObjectCount: 100,
				textCharCount: 0,
				formXObjectSeqs: [10],
			}],
		};
		const collapsed = collapse(fixture, [{ bbox: [20, 20, 80, 80] }]);

		assert.equal(collapsed.length, 1);
		assert.deepEqual(collapsed[0]._charRanges, []);
	});

	it('does not group dense atomic text from geometry without graphic provenance', () => {
		const fixture = fragmentFixture({
			rect: (index) => {
				const x = 10 + (index % 11) * 7;
				const y = 30 + Math.floor(index / 11) * 7;
				return [x, y, x + 4, y + 5];
			},
		});
		const collapsed = collapse(fixture, [{ bbox: [8, 28, 86, 50] }]);

		assert.equal(collapsed, fixture.blocks);
	});

	it('groups repeated source glyph programs without interpreting extracted text', () => {
		const fixture = fragmentFixture({
			rect: () => [20, 20, 80, 70],
			chars: () => Array.from({ length: 20 }, () => ({
				fontName: 'marker-font',
				paintGlyph: 17,
			})),
		});
		const collapsed = collapse(fixture, [{ bbox: [20, 20, 80, 70] }]);

		assert.equal(collapsed.length, 1);
		assert.equal(collapsed[0].type, 'image');
		assert.deepEqual(collapsed[0].bbox, [20, 20, 80, 70]);
		assert.deepEqual(collapsed[0].lines, []);
		assert.deepEqual(collapsed[0]._charRanges, []);
	});

	it('keeps real image text while dropping repeated graphical glyphs', () => {
		const fixture = fragmentFixture({
			rect: (index) => [20, 20 + index, 80, 21 + index],
			chars: () => [{
				fontName: 'marker-font',
				paintGlyph: 17,
			}],
		});
		fixture.lines.unshift({
			...line(0, 'real label', [20, 18, 40, 19], 0),
			chars: [{
				fontName: 'label-font',
				paintGlyph: 1,
			}],
		});
		for (let index = 1; index < fixture.lines.length; index++) {
			fixture.lines[index].id = index;
			fixture.lines[index].startOffset = index;
			fixture.lines[index].endOffset = index;
			fixture.blocks[index - 1].lines = [index];
			fixture.blocks[index - 1].startOffset = index;
			fixture.blocks[index - 1].endOffset = index;
		}
		fixture.blocks.unshift({
			type: 'image',
			flowClass: 'auxiliary',
			bbox: [20, 18, 80, 54],
			lines: [0],
			startOffset: 0,
			endOffset: 0,
		});

		const collapsed = collapse(fixture, [{ bbox: [20, 18, 80, 54] }]);

		assert.equal(collapsed.length, 1);
		assert.deepEqual(collapsed[0].lines, [0]);
		assert.deepEqual(collapsed[0]._charRanges, [[0, 0]]);
	});

	it('preserves non-fragment text inside a qualifying Form', () => {
		const fixture = formFixture();
		const textLine = {
			...line(35, 'legitimate explanatory text', [22, 50, 75, 56], 35),
			formXObjectSeqs: [10],
		};
		fixture.lines.push(textLine);
		fixture.blocks[0].lines.push(textLine.id);
		fixture.blocks[0].endOffset = textLine.endOffset;
		const collapsed = collapse(fixture, [{ bbox: [20, 20, 80, 80] }]);

		assert.equal(collapsed.some(block => block.lines?.includes(textLine.id)), true);
		assert.equal(
			collapsed.find(block => block.type === 'image').lines.includes(textLine.id),
			false,
		);
	});

	it('counts each Form fragment once when it is also in a graphic block', () => {
		const fixture = formFixture();
		for (const item of fixture.lines.filter(item => item.id > 17 && item.formXObjectSeqs)) {
			delete item.formXObjectSeqs;
		}
		fixture.blocks = fixture.lines
			.filter(item => item.formXObjectSeqs)
			.map(item => ({
				type: 'image',
				flowClass: 'auxiliary',
				bbox: item.rect,
				lines: [item.id],
				startOffset: item.startOffset,
				endOffset: item.endOffset,
			}));

		assert.equal(
			collapse(fixture, [{ bbox: [20, 20, 80, 80] }]),
			fixture.blocks,
		);
	});

	it('collapses excessive non-table block fragmentation inside a complex Form', () => {
		const fixture = formFixture();
		for (const item of fixture.lines) {
			delete item.chars;
		}
		fixture.blocks = fixture.lines
			.filter(item => item.formXObjectSeqs)
			.map(item => ({
				type: 'body',
				flowClass: 'body',
				bbox: item.rect,
				lines: [item.id],
				startOffset: item.startOffset,
				endOffset: item.endOffset,
			}));

		const collapsed = collapse(fixture, [{ bbox: [20, 20, 80, 80] }]);

		assert.equal(collapsed.length, 1);
		assert.equal(collapsed[0].type, 'image');
		assert.deepEqual(collapsed[0]._charRanges, [[1, 33]]);
	});

	it('preserves excessive table fragmentation inside a complex Form', () => {
		const fixture = formFixture();
		for (const item of fixture.lines) {
			delete item.chars;
		}
		fixture.blocks = fixture.lines
			.filter(item => item.formXObjectSeqs)
			.map(item => ({
				type: 'table',
				flowClass: 'body',
				bbox: item.rect,
				lines: [item.id],
				startOffset: item.startOffset,
				endOffset: item.endOffset,
			}));

		assert.equal(
			collapse(fixture, [{ bbox: [20, 20, 80, 80] }]),
			fixture.blocks,
		);
	});
});

describe('compactExcessiveImageBlocks', () => {
	function imageFragment(index) {
		const x = (index % 8) * 10;
		const y = Math.floor(index / 8) * 10;
		return {
			type: 'image',
			flowClass: 'auxiliary',
			bbox: [x, y, x + 8, y + 8],
			lines: [index],
			startOffset: index,
			endOffset: index,
		};
	}

	it('returns pages within the image budget untouched', () => {
		const lines = Array.from({ length: 5 }, (_, index) => line(index, `label ${index}`, [index * 10, 0, index * 10 + 8, 8], index));
		const blocks = Array.from({ length: 5 }, (_, index) => imageFragment(index));

		assert.equal(compactExcessiveImageBlocks(blocks, lines, [0, 0, 100, 100]), blocks);
	});

	it('collapses an excessive adjacent image run without absorbing a table', () => {
		const lines = Array.from({ length: 40 }, (_, index) => (
			line(index, `label ${index}`, [(index % 8) * 10, Math.floor(index / 8) * 10, (index % 8) * 10 + 8, Math.floor(index / 8) * 10 + 8], index)
		));
		const blocks = [
			{ type: 'table', flowClass: 'auxiliary', bbox: [-5, 0, -1, 48], lines: [], startOffset: 0, endOffset: -1 },
			...Array.from({ length: 40 }, (_, index) => imageFragment(index)),
		];

		const compacted = compactExcessiveImageBlocks(blocks, lines, [0, 0, 100, 100]);

		assert.equal(compacted.length, 2);
		assert.deepEqual(compacted.map(block => block.type), ['table', 'image']);
		assert.deepEqual(compacted[1].bbox, [0, 0, 78, 48]);
		assert.equal(compacted[1].lines.length, 40);
		assert.equal(compacted[1].flowClass, 'auxiliary');
	});

	it('enforces the hard limit when images are separated by arbitrary body blocks', () => {
		const lines = Array.from({ length: 80 }, (_, index) => line(index, `text ${index}`, [index % 10 * 10, Math.floor(index / 10) * 10, index % 10 * 10 + 8, Math.floor(index / 10) * 10 + 8], index));
		const bodyBlocks = [];
		const blocks = [];
		for (let index = 0; index < 40; index++) {
			blocks.push(imageFragment(index));
			const body = { type: 'body', flowClass: 'body', bbox: [0, index, 5, index + 1], lines: [40 + index], startOffset: 40 + index, endOffset: 40 + index };
			bodyBlocks.push(body);
			blocks.push(body);
		}

		const compacted = compactExcessiveImageBlocks(blocks, lines, [0, 0, 100, 100]);

		assert.ok(compacted.filter(block => block.type === 'image').length <= MAX_IMAGE_BLOCKS_PER_PAGE);
		assert.deepEqual(compacted.filter(block => block.type === 'body'), bodyBlocks);
	});

	it('maintains the image bound across adversarial generated layouts', () => {
		for (let seed = 1; seed <= 100; seed++) {
			const imageCount = MAX_IMAGE_BLOCKS_PER_PAGE + seed;
			const lines = Array.from({ length: imageCount }, (_, index) => line(index, `label ${index}`, [index % 17, index % 23, index % 17 + 1, index % 23 + 1], index));
			const blocks = [];
			for (let index = 0; index < imageCount; index++) {
				blocks.push({
					...imageFragment(index),
					flowClass: index % 3 ? 'auxiliary' : 'body',
					bbox: index % 19 ? [index % 17, index % 23, index % 17 + 1, index % 23 + 1] : null,
				});
				if ((index + seed) % 4 === 0) {
					blocks.push({ type: 'caption', flowClass: 'auxiliary', bbox: [0, 0, 1, 1], lines: [] });
				}
			}

			const compacted = compactExcessiveImageBlocks(blocks, lines, seed % 2 ? [0, 0, 100, 100] : null);
			const outputImageRects = compacted
				.filter(block => block.type === 'image' && block.bbox)
				.map(block => block.bbox);
			assert.ok(countImages(compacted) <= MAX_IMAGE_BLOCKS_PER_PAGE, `seed ${seed}`);
			for (const block of blocks.filter(block => block.type === 'image' && block.bbox)) {
				assert.ok(outputImageRects.some(rect => rectContains(rect, block.bbox)), `image coverage for seed ${seed}`);
			}
		}
	});

	it('enforces the bound for thousands of unrelated images', () => {
		const imageCount = 4096;
		const lines = Array.from({ length: imageCount }, (_, index) => line(index, '', [index % 64, Math.floor(index / 64), index % 64 + 1, Math.floor(index / 64) + 1], index));
		const blocks = Array.from({ length: imageCount }, (_, index) => ({
			...imageFragment(index),
			flowClass: 'body',
			bbox: [index % 64, Math.floor(index / 64), index % 64 + 1, Math.floor(index / 64) + 1],
		}));

		const compacted = compactExcessiveImageBlocks(blocks, lines, [0, 0, 64, 64]);

		assert.ok(countImages(compacted) <= MAX_IMAGE_BLOCKS_PER_PAGE);
	});
});

describe('enforceStandaloneGraphicQuality', () => {
	it('consolidates adjacent sub-figure images into one figure-scale image', () => {
		const lines = [
			line(0, 'left', [0, 0, 10, 10], 0),
			line(1, 'right', [10, 0, 20, 10], 1),
		];
		const blocks = [
			{ type: 'image', flowClass: 'auxiliary', bbox: [0, 0, 10, 10], lines: [0], startOffset: 0, endOffset: 0 },
			{ type: 'image', flowClass: 'auxiliary', bbox: [10, 0, 20, 10], lines: [1], startOffset: 1, endOffset: 1 },
		];

		const objectLines = [
			{ type: 'object', subtype: 'image', rect: [0, 0, 10, 10] },
			{ type: 'object', subtype: 'image', rect: [10, 0, 20, 10] },
		];
		const result = enforceStandaloneGraphicQuality(blocks, lines, [0, 0, 100, 100], objectLines);

		assert.equal(result.length, 1);
		assert.equal(result[0].type, 'image');
		assert.deepEqual(result[0].bbox, [0, 0, 20, 10]);
		assert.deepEqual(result[0].lines, [0, 1]);
	});

	it('demotes text-bearing tiny images and drops empty tiny images', () => {
		const lines = [line(0, 'axis tick', [1, 1, 5, 5], 0)];
		const textImage = { type: 'image', flowClass: 'auxiliary', bbox: [1, 1, 5, 5], lines: [0], startOffset: 0, endOffset: 0 };
		const emptyImage = { type: 'image', flowClass: 'auxiliary', bbox: [90, 90, 92, 92], lines: [], startOffset: 0, endOffset: -1 };

		const textResult = enforceStandaloneGraphicQuality([textImage], lines, [0, 0, 100, 100]);
		const emptyResult = enforceStandaloneGraphicQuality([emptyImage], lines, [0, 0, 100, 100]);

		assert.equal(textResult.length, 1);
		assert.equal(textResult[0].type, 'body');
		assert.deepEqual(emptyResult, []);
	});

	it('drops images with invalid geometry', () => {
		const blocks = [
			{ type: 'image', flowClass: 'auxiliary', bbox: null, lines: [], startOffset: 0, endOffset: -1 },
			{ type: 'image', flowClass: 'auxiliary', bbox: [1, 1, Number.NaN, 5], lines: [], startOffset: 0, endOffset: -1 },
		];

		assert.deepEqual(enforceStandaloneGraphicQuality(blocks, [], [0, 0, 100, 100]), []);
	});

	it('keeps figure-scale images and compact equations with generic mathematical evidence', () => {
		const lines = [line(0, 'x ⊗ y', [1, 1, 8, 5], 0)];
		const blocks = [
			{ type: 'image', flowClass: 'auxiliary', bbox: [10, 10, 50, 30], lines: [], startOffset: 0, endOffset: -1 },
			{ type: 'equation', flowClass: 'auxiliary', bbox: [1, 1, 8, 5], lines: [0], startOffset: 0, endOffset: 0 },
		];

		const objectLines = [
			{ type: 'object', subtype: 'image', rect: [10, 10, 50, 30] },
		];
		const result = enforceStandaloneGraphicQuality(blocks, lines, [0, 0, 100, 100], objectLines);

		assert.deepEqual(result.map(block => block.type), ['image', 'equation']);
	});

	it('rejects a model image backed only by a page substrate', () => {
		const lines = [line(0, 'OCR fragment', [20, 20, 80, 80], 0)];
		const blocks = [
			{ type: 'image', flowClass: 'auxiliary', bbox: [20, 20, 80, 80], lines: [0], startOffset: 0, endOffset: 0 },
		];
		const objectLines = [
			{ type: 'object', subtype: 'image', rect: [0, 0, 100, 100] },
		];

		const result = enforceStandaloneGraphicQuality(blocks, lines, [0, 0, 100, 100], objectLines);

		assert.equal(result.length, 1);
		assert.equal(result[0].type, 'body');
	});

	it('keeps an independently embedded figure over a page substrate', () => {
		const blocks = [
			{ type: 'image', flowClass: 'auxiliary', bbox: [20, 20, 60, 50], lines: [], startOffset: 0, endOffset: -1 },
		];
		const objectLines = [
			{ type: 'object', subtype: 'image', rect: [0, 0, 100, 100] },
			{ type: 'object', subtype: 'xobject', rect: [20, 20, 60, 50] },
		];

		const result = enforceStandaloneGraphicQuality(blocks, [], [0, 0, 100, 100], objectLines);

		assert.deepEqual(result, blocks);
	});

	it('keeps a figure with independent vector-component provenance', () => {
		const blocks = [
			{ type: 'image', flowClass: 'auxiliary', bbox: [20, 20, 60, 50], lines: [], startOffset: 0, endOffset: -1 },
		];
		const objectLines = [
			{ type: 'object', subtype: 'path', rect: [20, 20, 60, 50] },
		];

		const result = enforceStandaloneGraphicQuality(blocks, [], [0, 0, 100, 100], objectLines);

		assert.deepEqual(result, blocks);
	});

	it('demotes isolated low-information equation fragments across writing systems', () => {
		const lines = [
			line(0, '（٢٤）', [90, 40, 98, 46], 0),
			line(1, '(', [50, 20, 52, 26], 1),
		];
		const blocks = [
			{ type: 'equation', flowClass: 'auxiliary', bbox: [90, 40, 98, 46], lines: [0], startOffset: 0, endOffset: 0 },
			{ type: 'equation', flowClass: 'auxiliary', bbox: [50, 20, 52, 26], lines: [1], startOffset: 1, endOffset: 1 },
		];

		const result = enforceStandaloneGraphicQuality(blocks, lines, [0, 0, 100, 100]);

		assert.deepEqual(result.map(block => block.type), ['body', 'body']);
	});

	it('attaches an undersized aligned satellite without interpreting its text', () => {
		const lines = [
			line(0, 'x = y + z', [20, 40, 50, 60], 0),
			line(1, 'ref', [90, 48, 98, 55], 1),
		];
		const blocks = [
			{ type: 'equation', flowClass: 'auxiliary', bbox: [20, 40, 50, 60], lines: [0], startOffset: 0, endOffset: 0 },
			{ type: 'equation', flowClass: 'auxiliary', bbox: [90, 48, 98, 55], lines: [1], startOffset: 1, endOffset: 1 },
		];

		const result = enforceStandaloneGraphicQuality(blocks, lines, [0, 0, 100, 100]);

		assert.equal(result.length, 1);
		assert.equal(result[0].type, 'equation');
		assert.deepEqual(result[0].bbox, [20, 40, 98, 60]);
		assert.deepEqual(result[0].lines, [0, 1]);
	});
});

describe('refineGraphicBlocks', () => {
	it('splits interrupted graphic blocks and assigns visible objects to each piece', () => {
		const lines = [
			line(0, 'Upper figure label', [10, 70, 40, 80], 0),
			line(1, 'Lower figure label', [10, 10, 40, 20], 1),
		];
		const blocks = [
			{ type: 'body', bbox: [0, 40, 100, 50], lines: [], startOffset: 10, endOffset: 10 },
			{ type: 'image', flowClass: 'auxiliary', bbox: [10, 10, 40, 80], lines: [0, 1], startOffset: 0, endOffset: 1 },
		];
		const objectLines = [
			{ type: 'object', subtype: 'path', rect: [45, 70, 60, 80] },
			{ type: 'object', subtype: 'path', rect: [45, 10, 60, 20] },
		];

		const refined = refineGraphicBlocks(blocks, lines, objectLines);

		assert.deepEqual(refined.map(block => block.type), ['body', 'image', 'image']);
		assert.deepEqual(refined[1].lines, [0]);
		assert.deepEqual(refined[1].bbox, [10, 70, 60, 80]);
		assert.deepEqual(refined[2].lines, [1]);
		assert.deepEqual(refined[2].bbox, [10, 10, 60, 20]);
		assert.equal(refined[0].type, 'body');
	});

	it('merges adjacent images only when a full border can sweep without hitting another block', () => {
		const lines = [
			line(0, 'Left', [10, 10, 20, 20], 0),
			line(1, 'Right', [30, 10, 40, 20], 1),
		];
		const blocks = [
			{ type: 'image', bbox: [10, 10, 20, 20], lines: [0], startOffset: 0, endOffset: 0 },
			{ type: 'image', bbox: [30, 10, 40, 20], lines: [1], startOffset: 1, endOffset: 1 },
		];

		const refined = refineGraphicBlocks(blocks, lines, []);

		assert.equal(refined.length, 1);
		assert.deepEqual(refined[0].lines, [0, 1]);
		assert.deepEqual(refined[0].bbox, [10, 10, 40, 20]);
	});

	it('does not merge images when the swept border hits a blocker', () => {
		const lines = [
			line(0, 'Left', [10, 10, 20, 20], 0),
			line(1, 'Right', [30, 10, 40, 20], 1),
		];
		const blocks = [
			{ type: 'image', bbox: [10, 10, 20, 20], lines: [0], startOffset: 0, endOffset: 0 },
			{ type: 'image', bbox: [30, 10, 40, 20], lines: [1], startOffset: 1, endOffset: 1 },
			{ type: 'body', bbox: [24, 5, 26, 25], lines: [], startOffset: 2, endOffset: 2 },
		];

		const refined = refineGraphicBlocks(blocks, lines, []);

		assert.deepEqual(refined.map(block => block.type), ['image', 'image', 'body']);
		assert.deepEqual(refined[0].lines, [0]);
		assert.deepEqual(refined[1].lines, [1]);
	});

	it('does not merge table or equation blocks with each other', () => {
		const lines = [
			line(0, 'Left table', [10, 10, 20, 20], 0),
			line(1, 'Right table', [30, 10, 40, 20], 1),
			line(2, 'Left equation', [10, 40, 20, 50], 2),
			line(3, 'Right equation', [30, 40, 40, 50], 3),
		];
		const blocks = [
			{ type: 'table', bbox: [10, 10, 20, 20], lines: [0], startOffset: 0, endOffset: 0 },
			{ type: 'table', bbox: [30, 10, 40, 20], lines: [1], startOffset: 1, endOffset: 1 },
			{ type: 'equation', bbox: [10, 40, 20, 50], lines: [2], startOffset: 2, endOffset: 2 },
			{ type: 'equation', bbox: [30, 40, 40, 50], lines: [3], startOffset: 3, endOffset: 3 },
		];

		const refined = refineGraphicBlocks(blocks, lines, []);

		assert.deepEqual(refined.map(block => block.type), ['table', 'table', 'equation', 'equation']);
		assert.deepEqual(refined.map(block => block.lines), [[0], [1], [2], [3]]);
	});

	it('merges adjacent intersecting equation blocks', () => {
		const lines = [
			line(0, 'Left equation', [10, 40, 30, 50], 0),
			line(1, 'Right equation', [25, 35, 50, 55], 1),
		];
		const blocks = [
			{ type: 'equation', bbox: [10, 40, 30, 50], lines: [0], startOffset: 0, endOffset: 0 },
			{ type: 'equation', bbox: [25, 35, 50, 55], lines: [1], startOffset: 1, endOffset: 1 },
		];

		const refined = refineGraphicBlocks(blocks, lines, []);

		assert.equal(refined.length, 1);
		assert.equal(refined[0].type, 'equation');
		assert.deepEqual(refined[0].lines, [0, 1]);
		assert.deepEqual(refined[0].bbox, [10, 35, 50, 55]);
	});

	it('merges visually joined equation fragments without text continuation signals', () => {
		const lines = [
			line(0, 'Then, the following robust error estimate holds for QCBP ‖', [10, 78, 190, 108], 0),
			line(1, 'x̂(η) − x‖2 ≤ √Cs σs(x)1 + Dη + E L 1', [80, 70, 158, 92], 1),
			line(2, '2 max{‖n‖2 − η, 0}, (20)', [156, 64, 210, 88], 2),
		];
		const blocks = [
			{ type: 'body', bbox: [10, 78, 190, 108], lines: [0], startOffset: 0, endOffset: 0 },
			{ type: 'equation', flowClass: 'auxiliary', bbox: [80, 70, 158, 92], lines: [1], startOffset: 1, endOffset: 1 },
			{ type: 'equation', flowClass: 'auxiliary', bbox: [156, 64, 210, 88], lines: [2], startOffset: 2, endOffset: 2 },
		];

		const refined = refineGraphicBlocks(blocks, lines, []);

		assert.equal(refined.length, 2);
		assert.deepEqual(refined.map(block => block.type), ['body', 'equation']);
		assert.deepEqual(refined[1].lines, [1, 2]);
		assert.deepEqual(refined[1].bbox, [80, 64, 210, 92]);
	});

	it('does not merge stacked equations with only incidental bbox overlap', () => {
		const lines = [
			line(0, 'body blocker', [10, 85, 130, 105], 0),
			line(1, 'abcdefghijklmnopqrstuvwxyz abcdefghijklmnopqrstuvwxyz', [20, 80, 120, 100], 1),
			line(2, 'mnopqrstuvwxyz abcdefghijklmnopqrstuvwxyz abcdefghij', [20, 99.5, 120, 119.5], 2),
		];
		const blocks = [
			{ type: 'body', bbox: [10, 85, 130, 105], lines: [0], startOffset: 0, endOffset: 0 },
			{ type: 'equation', flowClass: 'auxiliary', bbox: [20, 80, 120, 100], lines: [1], startOffset: 1, endOffset: 1 },
			{ type: 'equation', flowClass: 'auxiliary', bbox: [20, 99.5, 120, 119.5], lines: [2], startOffset: 2, endOffset: 2 },
		];

		const refined = refineGraphicBlocks(blocks, lines, []);

		assert.equal(refined.length, 3);
		assert.deepEqual(refined.map(block => block.lines), [[0], [1], [2]]);
	});

	it('merges asymmetric stacked extraction shards from structural evidence', () => {
		const lines = [
			line(0, '12345678', [20, 90, 60, 100], 0),
			line(1, '90123456', [20, 80, 60, 90], 1),
			line(2, '123', [25, 72, 100, 82], 2),
			line(3, '456', [25, 69, 100, 72], 3),
			line(4, '789', [25, 66, 100, 69], 4),
			line(5, '012', [25, 63, 100, 66], 5),
			line(6, '345', [25, 60, 100, 63], 6),
			line(7, '678', [25, 58, 100, 60], 7),
		];
		const blocks = [
			{ type: 'body', bbox: [70, 95, 70, 95], lines: [], startOffset: 8, endOffset: 8 },
			{ type: 'equation', bbox: [20, 80, 60, 100], lines: [0, 1], startOffset: 0, endOffset: 1 },
			{ type: 'equation', bbox: [25, 58, 100, 82], lines: [2, 3, 4, 5, 6, 7], startOffset: 2, endOffset: 7 },
		];

		const refined = refineGraphicBlocks(blocks, lines, []);

		assert.equal(refined.length, 2);
		assert.deepEqual(refined[1].lines, [0, 1, 2, 3, 4, 5, 6, 7]);
	});

	it('keeps similarly complete stacked equations separate', () => {
		const lines = [
			line(0, '1234567890123456', [20, 80, 60, 100], 0),
			line(1, '1234567890123456', [25, 58, 100, 82], 1),
		];
		const blocks = [
			{ type: 'body', bbox: [70, 95, 70, 95], lines: [], startOffset: 2, endOffset: 2 },
			{ type: 'equation', bbox: [20, 80, 60, 100], lines: [0], startOffset: 0, endOffset: 0 },
			{ type: 'equation', bbox: [25, 58, 100, 82], lines: [1], startOffset: 1, endOffset: 1 },
		];

		const refined = refineGraphicBlocks(blocks, lines, []);

		assert.equal(refined.length, 3);
		assert.deepEqual(refined.slice(1).map(block => block.lines), [[0], [1]]);
	});

	it('keeps vertically aligned equation blocks in separate columns', () => {
		const lines = [
			line(0, '12', [20, 80, 40, 90], 0),
			line(1, '34', [20, 70, 40, 80], 1),
			line(2, '56', [120, 90, 150, 100], 2),
			line(3, '78', [120, 84, 150, 90], 3),
			line(4, '90', [120, 78, 150, 84], 4),
			line(5, '12', [120, 72, 150, 78], 5),
			line(6, '34', [120, 66, 150, 72], 6),
			line(7, '56', [120, 60, 150, 66], 7),
		];
		const blocks = [
			{ type: 'equation', bbox: [20, 70, 40, 90], lines: [0, 1], startOffset: 0, endOffset: 1 },
			{ type: 'equation', bbox: [120, 60, 150, 100], lines: [2, 3, 4, 5, 6, 7], startOffset: 2, endOffset: 7 },
		];

		const refined = refineGraphicBlocks(blocks, lines, []);

		assert.equal(refined.length, 2);
	});

	it('merges stacked display equation fragments with small gaps', () => {
		const lines = [
			line(0, 'λ := min', [80, 80, 125, 90], 0),
			line(1, 'J⊂Hs K(J)≥2K(s)', [92, 63, 138, 78], 1),
			line(2, '⎛', [140, 95, 148, 105], 2),
			line(3, 'max', [150, 88, 170, 97], 3),
			line(4, '|cν|/ων', [172, 88, 210, 98], 4),
			line(5, 'min', [150, 70, 170, 79], 5),
			line(6, 'ν∈J |cν|/ων', [150, 54, 210, 69], 6),
			line(7, '⎞', [212, 95, 220, 105], 7),
			line(8, '(4.15) ⎠ − 1.', [20, 78, 238, 90], 8),
		];
		const blocks = lines.map(item => ({
			type: 'equation',
			flowClass: 'auxiliary',
			bbox: item.rect.slice(),
			lines: [item.id],
			startOffset: item.startOffset,
			endOffset: item.endOffset,
		}));

		const refined = refineGraphicBlocks(blocks, lines, []);

		assert.equal(refined.length, 1);
		assert.equal(refined[0].type, 'equation');
		assert.deepEqual(refined[0].lines, [0, 1, 2, 3, 4, 5, 6, 7, 8]);
		assert.deepEqual(refined[0].bbox, [20, 54, 238, 105]);
	});

	it('merges display equation lines that continue with a leading operator', () => {
		const lines = [
			line(0, '∣∣∣‖Az‖22 − ‖z‖22∣∣∣ ≤ 4δ∫U |ψ(y,z)|2d + 5δ', [20, 80, 240, 110], 0),
			line(1, '≤ 12δ + δ/3 + (1 + 4δ)', [60, 61, 180, 72], 1),
			line(2, '∑ l∈L', [182, 50, 196, 80], 2),
			line(3, '(1 + δ)2lκl,', [198, 61, 250, 74], 3),
		];
		const blocks = lines.map(item => ({
			type: 'equation',
			flowClass: 'auxiliary',
			bbox: item.rect.slice(),
			lines: [item.id],
			startOffset: item.startOffset,
			endOffset: item.endOffset,
		}));

		const refined = refineGraphicBlocks(blocks, lines, []);

		assert.equal(refined.length, 1);
		assert.deepEqual(refined[0].lines, [0, 1, 2, 3]);
		assert.deepEqual(refined[0].bbox, [20, 50, 250, 110]);
	});

	it('merges display equation fragments across a small horizontal gap', () => {
		const lines = [
			line(0, 'g(y) =', [20, 60, 52, 69], 0),
			line(1, '[ ∏ d/2', [58, 70, 96, 84], 1),
			line(2, 'k=1 (1+4ky2 k)', [82, 58, 140, 68], 2),
			line(3, '∏d', [30, 46, 44, 55], 3),
			line(4, 'k=4 (100+5yk)', [46, 38, 120, 48], 4),
			line(5, ']1/d', [152, 70, 170, 84], 5),
		];
		const blocks = lines.map(item => ({
			type: 'equation',
			flowClass: 'auxiliary',
			bbox: item.rect.slice(),
			lines: [item.id],
			startOffset: item.startOffset,
			endOffset: item.endOffset,
		}));

		const refined = refineGraphicBlocks(blocks, lines, []);

		assert.equal(refined.length, 1);
		assert.deepEqual(refined[0].lines, [0, 1, 2, 3, 4, 5]);
		assert.deepEqual(refined[0].bbox, [20, 38, 170, 84]);
	});

	it('does not merge prose-dominant math blocks in another language', () => {
		const lines = [
			line(0, '|ψ(y, z)| > (1 + δ)l−1 − δ/2', [40, 80, 220, 110], 0),
			line(1, 'Cuando el valor no pertenece al conjunto, entonces ψ(y, z) = 0.', [42, 50, 218, 78], 1),
		];
		const blocks = lines.map(item => ({
			type: 'equation',
			flowClass: 'auxiliary',
			bbox: item.rect.slice(),
			lines: [item.id],
			startOffset: item.startOffset,
			endOffset: item.endOffset,
		}));

		const refined = refineGraphicBlocks(blocks, lines, []);

		assert.equal(refined.length, 2);
		assert.deepEqual(refined.map(block => block.lines), [[0], [1]]);
	});

	it('does not swallow an object that is closer to a nearby non-graphic block', () => {
		const lines = [
			line(0, 'Figure label', [10, 10, 20, 20], 0),
			line(1, 'Body text', [50, 10, 60, 20], 1),
		];
		const blocks = [
			{ type: 'image', bbox: [10, 10, 20, 20], lines: [0], startOffset: 0, endOffset: 0 },
			{ type: 'body', bbox: [50, 10, 60, 20], lines: [1], startOffset: 1, endOffset: 1 },
		];
		const objectLines = [
			{ type: 'object', subtype: 'path', rect: [42, 10, 45, 20] },
		];

		const refined = refineGraphicBlocks(blocks, lines, objectLines);

		assert.deepEqual(refined[0].bbox, [10, 10, 20, 20]);
	});

	it('swallows a nearby object when the current graphic block is closer than another block', () => {
		const lines = [
			line(0, 'Figure label', [10, 10, 20, 20], 0),
			line(1, 'Body text', [35, 10, 45, 20], 1),
		];
		const blocks = [
			{ type: 'image', bbox: [10, 10, 20, 20], lines: [0], startOffset: 0, endOffset: 0 },
			{ type: 'body', bbox: [35, 10, 45, 20], lines: [1], startOffset: 1, endOffset: 1 },
		];
		const objectLines = [
			{ type: 'object', subtype: 'path', rect: [22, 10, 28, 20] },
		];

		const refined = refineGraphicBlocks(blocks, lines, objectLines);

		assert.deepEqual(refined[0].bbox, [10, 10, 28, 20]);
	});

	it('does not let a page-covering object component hide local figure objects', () => {
		const lines = [
			line(0, 'Figure label', [45, 45, 55, 55], 0),
			line(1, 'Body text', [100, 100, 120, 120], 1),
		];
		const blocks = [
			{ type: 'image', bbox: [45, 45, 55, 55], lines: [0], startOffset: 0, endOffset: 0 },
			{ type: 'body', bbox: [100, 100, 120, 120], lines: [1], startOffset: 1, endOffset: 1 },
		];
		const objectLines = [
			{ type: 'object', subtype: 'path', rect: [0, 0, 200, 200] },
			{ type: 'object', subtype: 'path', rect: [30, 30, 70, 70] },
		];

		const refined = refineGraphicBlocks(blocks, lines, objectLines);

		assert.deepEqual(refined[0].bbox, [30, 30, 70, 70]);
	});

	it('inserts standalone image objects that do not intersect existing blocks', () => {
		const blocks = [
			{ type: 'body', bbox: [100, 350, 300, 370], lines: [], startOffset: 0, endOffset: 0 },
			{ type: 'caption', bbox: [100, 150, 300, 170], lines: [], startOffset: 1, endOffset: 1 },
		];
		const objectLines = [
			{ type: 'object', subtype: 'image', rect: [100, 200, 300, 330] },
		];

		const refined = refineGraphicBlocks(blocks, [], objectLines, [0, 0, 612, 792]);

		assert.deepEqual(refined.map(block => block.type), ['body', 'image', 'caption']);
		assert.equal(refined[1].flowClass, 'auxiliary');
		assert.deepEqual(refined[1].bbox, [100, 200, 300, 330]);
		assert.deepEqual(refined[1].lines, []);
	});

	it('does not insert standalone image objects below figure scale', () => {
		const objectLines = [
			{ type: 'object', subtype: 'image', rect: [10, 10, 35, 35] },
		];

		const refined = refineGraphicBlocks([], [], objectLines, [0, 0, 612, 792]);

		assert.deepEqual(refined, []);
	});

	it('does not insert a full-page raster substrate as an image', () => {
		const objectLines = [
			{ type: 'object', subtype: 'image', rect: [0, 0, 100, 100] },
		];

		const refined = refineGraphicBlocks([], [], objectLines, [0, 0, 100, 100]);

		assert.deepEqual(refined, []);
	});

	it('does not insert collectively page-covering raster tiles', () => {
		const objectLines = [
			{ type: 'object', subtype: 'image', rect: [0, 0, 50, 50] },
			{ type: 'object', subtype: 'image', rect: [50, 0, 100, 50] },
			{ type: 'object', subtype: 'image', rect: [0, 50, 50, 100] },
			{ type: 'object', subtype: 'image', rect: [50, 50, 100, 100] },
		];

		const refined = refineGraphicBlocks([], [], objectLines, [0, 0, 100, 100]);

		assert.deepEqual(refined, []);
	});

	it('does not insert an image object that intersects a non-image block', () => {
		const blocks = [
			{ type: 'body', bbox: [10, 50, 90, 70], lines: [], startOffset: 0, endOffset: 0 },
		];
		const objectLines = [
			{ type: 'object', subtype: 'image', rect: [20, 55, 80, 65] },
		];

		const refined = refineGraphicBlocks(blocks, [], objectLines);

		assert.equal(refined.length, 1);
		assert.equal(refined[0].type, 'body');
	});

	it('expands an overlapping image block to an xobject when it only intersects image blocks', () => {
		const blocks = [
			{ type: 'image', bbox: [100, 620, 240, 710], lines: [], startOffset: 0, endOffset: 0 },
		];
		const objectLines = [
			{ type: 'object', subtype: 'xobject', rect: [94, 581, 253, 720] },
		];

		const refined = refineGraphicBlocks(blocks, [], objectLines);

		assert.equal(refined.length, 1);
		assert.deepEqual(refined[0].bbox, [94, 581, 253, 720]);
	});

	it('does not include image objects that intersect non-image blocks', () => {
		const blocks = [
			{ type: 'image', bbox: [100, 620, 240, 710], lines: [], startOffset: 0, endOffset: 0 },
			{ type: 'caption', bbox: [130, 585, 210, 592], lines: [], startOffset: 1, endOffset: 1 },
		];
		const objectLines = [
			{ type: 'object', subtype: 'xobject', rect: [94, 581, 253, 720] },
		];

		const refined = refineGraphicBlocks(blocks, [], objectLines);

		assert.equal(refined.length, 2);
		assert.deepEqual(refined[0].bbox, [100, 620, 240, 710]);
		assert.equal(refined[1].type, 'caption');
	});

	it('creates an image block from an xobject and nearby included objects when no text blocks exist', () => {
		const objectLines = [
			{ type: 'object', subtype: 'xobject', rect: [100, 100, 300, 250] },
			{ type: 'object', subtype: 'path', rect: [99, 99, 301, 251] },
		];

		const refined = refineGraphicBlocks([], [], objectLines, [0, 0, 612, 792]);

		assert.equal(refined.length, 1);
		assert.equal(refined[0].type, 'image');
		assert.deepEqual(refined[0].bbox, [99, 99, 301, 251]);
		assert.deepEqual(refined[0].lines, []);
	});

	it('joins table fragments inside one ruled table grid', () => {
		const lines = [
			line(0, 'A1', [10, 70, 30, 80], 0),
			line(1, 'B1', [60, 70, 80, 80], 1),
			line(2, 'A2', [10, 50, 30, 60], 2),
			line(3, 'B2', [60, 50, 80, 60], 3),
		];
		const blocks = [
			{ type: 'table', bbox: [10, 70, 80, 80], lines: [0, 1], startOffset: 0, endOffset: 1 },
			{ type: 'table', bbox: [10, 50, 80, 60], lines: [2, 3], startOffset: 2, endOffset: 3 },
		];

		const refined = refineGraphicBlocks(blocks, lines, ruledGridObjects(), [0, 0, 100, 100]);

		assert.equal(refined.length, 1);
		assert.equal(refined[0].type, 'table');
		assert.deepEqual(refined[0].lines, [0, 1, 2, 3]);
		assert.deepEqual(refined[0].bbox, [5, 45, 85, 86]);
	});

	it('joins a ruled table row misclassified as text inside table fragments', () => {
		const lines = [
			line(0, 'Top row', [10, 80, 90, 90], 0),
			line(1, 'Middle row', [10, 65, 90, 75], 1),
			line(2, 'Bottom row', [10, 50, 90, 60], 2),
		];
		const blocks = [
			{ type: 'table', bbox: [10, 80, 90, 90], lines: [0], startOffset: 0, endOffset: 0 },
			{ type: 'caption', bbox: [10, 65, 90, 75], lines: [1], startOffset: 1, endOffset: 1 },
			{ type: 'table', bbox: [10, 50, 90, 60], lines: [2], startOffset: 2, endOffset: 2 },
		];
		const objects = [
			{ type: 'object', subtype: 'path', rect: [5, 95, 95, 96] },
			{ type: 'object', subtype: 'path', rect: [5, 78, 95, 79] },
			{ type: 'object', subtype: 'path', rect: [5, 62, 95, 63] },
			{ type: 'object', subtype: 'path', rect: [5, 45, 95, 46] },
		];

		const refined = refineGraphicBlocks(blocks, lines, objects, [0, 0, 100, 100]);

		assert.equal(refined.length, 1);
		assert.equal(refined[0].type, 'table');
		assert.deepEqual(refined[0].lines, [0, 1, 2]);
		assert.deepEqual(refined[0].bbox, [5, 45, 95, 96]);
	});

	it('keeps merged table metadata from a table seed when ruled text leads the run', () => {
		const lines = [
			line(0, 'Top row', [10, 80, 90, 90], 0),
			line(1, 'Bottom row', [10, 65, 90, 75], 1),
		];
		const blocks = [
			{ type: 'caption', flowClass: 'auxiliary', bbox: [10, 80, 90, 90], lines: [0], startOffset: 0, endOffset: 0 },
			{ type: 'table', bbox: [10, 65, 90, 75], lines: [1], startOffset: 1, endOffset: 1 },
		];
		const objects = [
			{ type: 'object', subtype: 'path', rect: [5, 95, 95, 96] },
			{ type: 'object', subtype: 'path', rect: [5, 78, 95, 79] },
			{ type: 'object', subtype: 'path', rect: [5, 60, 95, 61] },
		];

		const refined = refineGraphicBlocks(blocks, lines, objects, [0, 0, 100, 100]);

		assert.equal(refined.length, 1);
		assert.equal(refined[0].type, 'table');
		assert.equal(refined[0].flowClass, undefined);
		assert.deepEqual(refined[0].lines, [0, 1]);
	});

	it('joins a large column-wise table fragment run with a header rule', () => {
		const lines = [
			line(0, 'Header', [10, 80, 90, 90], 0),
			line(1, 'Left 1', [10, 60, 45, 70], 1),
			line(2, 'Left 2', [10, 50, 45, 60], 2),
			line(3, 'Left 3', [10, 40, 45, 50], 3),
			line(4, 'Left 4', [10, 30, 45, 40], 4),
			line(5, 'Right 1', [55, 60, 90, 70], 5),
			line(6, 'Right 2', [55, 50, 90, 60], 6),
			line(7, 'Right 3', [55, 40, 90, 50], 7),
		];
		const blocks = lines.map(item => ({
			type: 'table',
			bbox: item.rect.slice(),
			lines: [item.id],
			startOffset: item.startOffset,
			endOffset: item.endOffset,
		}));
		const objects = [
			{ type: 'object', subtype: 'path', rect: [5, 90, 95, 91] },
			{ type: 'object', subtype: 'path', rect: [5, 10, 95, 11] },
		];

		const refined = refineGraphicBlocks(blocks, lines, objects, [0, 0, 100, 100]);

		assert.equal(refined.length, 1);
		assert.equal(refined[0].type, 'table');
		assert.deepEqual(refined[0].lines, [0, 1, 2, 3, 4, 5, 6, 7]);
		assert.deepEqual(refined[0].bbox, [5, 30, 95, 91]);
	});

	it('joins dense scanned table fragments after a nearby caption', () => {
		const lines = [
			line(0, 'TABLE I.-Smoking by disease group', [10, 90, 90, 98], 0),
			line(1, 'Disease Group', [10, 75, 45, 83], 1),
			line(2, 'Males:', [10, 65, 25, 73], 2),
			line(3, 'Lung-carcinoma', [10, 55, 45, 63], 3),
			line(4, 'patients (647)', [16, 45, 45, 53], 4),
			line(5, '24 208 196 174 45', [52, 55, 95, 63], 5),
			line(6, '(3.7%) (32.1%)', [52, 45, 90, 53], 6),
		];
		const blocks = [
			{ type: 'caption', flowClass: 'auxiliary', bbox: [10, 90, 90, 98], lines: [0], startOffset: 0, endOffset: 0 },
			{ type: 'table', flowClass: 'auxiliary', bbox: [10, 75, 45, 83], lines: [1], startOffset: 1, endOffset: 1 },
			{ type: 'table', flowClass: 'auxiliary', bbox: [10, 65, 25, 73], lines: [2], startOffset: 2, endOffset: 2 },
			{ type: 'table', flowClass: 'auxiliary', bbox: [10, 55, 45, 63], lines: [3], startOffset: 3, endOffset: 3 },
			{ type: 'table', flowClass: 'auxiliary', bbox: [16, 45, 45, 53], lines: [4], startOffset: 4, endOffset: 4 },
			{ type: 'table', flowClass: 'auxiliary', bbox: [52, 55, 95, 63], lines: [5], startOffset: 5, endOffset: 5 },
			{ type: 'table', flowClass: 'auxiliary', bbox: [52, 45, 90, 53], lines: [6], startOffset: 6, endOffset: 6 },
		];
		const objects = [
			{ type: 'object', subtype: 'image', rect: [0, 0, 200, 100] },
		];

		const refined = refineGraphicBlocks(blocks, lines, objects, [0, 0, 200, 100]);

		assert.equal(refined.length, 2);
		assert.equal(refined[0].type, 'caption');
		assert.equal(refined[1].type, 'table');
		assert.equal(refined[1].flowClass, 'auxiliary');
		assert.deepEqual(refined[1].lines, [1, 2, 3, 4, 5, 6]);
		assert.deepEqual(refined[1].bbox, [10, 45, 95, 83]);
	});

	it('joins dense scanned table fragments from an in-run caption', () => {
		const lines = [
			line(0, 'BRITISH', [70, 90, 85, 98], 0),
			line(1, 'MEDICAL JOURNAL', [64, 86, 90, 94], 1),
			line(2, 'TABLE I.-Caption mislabeled as table', [10, 72, 90, 80], 2),
			line(3, 'Age 0 1-4 5-14', [10, 62, 90, 70], 3),
			line(4, '25- 0 11 2', [10, 52, 90, 60], 4),
			line(5, '35- 2 9 43', [10, 42, 90, 50], 5),
		];
		const blocks = lines.map(item => ({
			type: 'table',
			flowClass: 'auxiliary',
			bbox: item.rect.slice(),
			lines: [item.id],
			startOffset: item.startOffset,
			endOffset: item.endOffset,
		}));
		const objects = [
			{ type: 'object', subtype: 'image', rect: [0, 0, 200, 100] },
		];

		const refined = refineGraphicBlocks(blocks, lines, objects, [0, 0, 200, 100]);

		assert.equal(refined.length, 3);
		assert.deepEqual(refined.map(block => block.type), ['body', 'body', 'table']);
		assert.deepEqual(refined.map(block => block.flowClass), ['excluded', 'excluded', 'auxiliary']);
		assert.deepEqual(refined.map(block => block.lines), [[0], [1], [2, 3, 4, 5]]);
		assert.deepEqual(refined[2].bbox, [10, 42, 90, 80]);
	});

	it('does not join dense scanned table fragments across a large visual gap', () => {
		const lines = [
			line(0, 'TABLE I.-One table', [10, 90, 90, 98], 0),
			line(1, 'A 1', [10, 80, 90, 88], 1),
			line(2, 'B 2', [10, 70, 90, 78], 2),
			line(3, 'C 3', [10, 20, 90, 28], 3),
			line(4, 'D 4', [10, 10, 90, 18], 4),
		];
		const blocks = lines.map(item => ({
			type: 'table',
			flowClass: 'auxiliary',
			bbox: item.rect.slice(),
			lines: [item.id],
			startOffset: item.startOffset,
			endOffset: item.endOffset,
		}));
		const objects = [
			{ type: 'object', subtype: 'image', rect: [0, 0, 200, 100] },
		];

		const refined = refineGraphicBlocks(blocks, lines, objects, [0, 0, 200, 100]);

		assert.equal(refined.length, blocks.length);
		assert.deepEqual(refined.map(block => block.lines), [[0], [1], [2], [3], [4]]);
	});

	it('does not join dense scanned table fragments without a caption signal', () => {
		const lines = [
			line(0, 'Age 0 1-4 5-14', [10, 72, 90, 80], 0),
			line(1, '0 Cigs. Cigs. Cigs.', [10, 62, 90, 70], 1),
			line(2, '25- 0 11 2', [10, 52, 90, 60], 2),
			line(3, '35- 2 9 43', [10, 42, 90, 50], 3),
		];
		const blocks = lines.map(item => ({
			type: 'table',
			flowClass: 'auxiliary',
			bbox: item.rect.slice(),
			lines: [item.id],
			startOffset: item.startOffset,
			endOffset: item.endOffset,
		}));
		const objects = [
			{ type: 'object', subtype: 'image', rect: [0, 0, 100, 100] },
		];

		const refined = refineGraphicBlocks(blocks, lines, objects, [0, 0, 100, 100]);

		assert.equal(refined.length, blocks.length);
		assert.deepEqual(refined.map(block => block.lines), [[0], [1], [2], [3]]);
	});

	it('excludes tiny scanned table junk fragments', () => {
		const lines = [
			line(0, '-1', [10, 72, 13, 80], 0),
			line(1, '25- 0 11 2 6 28 - 4', [10, 52, 130, 60], 1),
		];
		const blocks = [
			{ type: 'table', flowClass: 'auxiliary', bbox: [10, 72, 13, 80], lines: [0], startOffset: 0, endOffset: 0 },
			{ type: 'table', flowClass: 'auxiliary', bbox: [10, 52, 130, 60], lines: [1], startOffset: 1, endOffset: 1 },
		];
		const objects = [
			{ type: 'object', subtype: 'image', rect: [0, 0, 200, 100] },
		];

		const refined = refineGraphicBlocks(blocks, lines, objects, [0, 0, 200, 100]);

		assert.deepEqual(refined.map(block => block.type), ['body', 'table']);
		assert.deepEqual(refined.map(block => block.flowClass), ['excluded', 'auxiliary']);
		assert.deepEqual(refined.map(block => block.lines), [[0], [1]]);
	});

	it('does not let one-column rules merge table-labeled text from another column', () => {
		const lines = [
			line(0, 'Left 1', [10, 80, 45, 90], 0),
			line(1, 'Left 2', [10, 70, 45, 80], 1),
			line(2, 'Left 3', [10, 60, 45, 70], 2),
			line(3, 'Left 4', [10, 50, 45, 60], 3),
			line(4, 'Right 1', [55, 80, 90, 90], 4),
			line(5, 'Right 2', [55, 70, 90, 80], 5),
			line(6, 'Right 3', [55, 60, 90, 70], 6),
			line(7, 'Right 4', [55, 50, 90, 60], 7),
		];
		const blocks = lines.map(item => ({
			type: 'table',
			bbox: item.rect.slice(),
			lines: [item.id],
			startOffset: item.startOffset,
			endOffset: item.endOffset,
		}));
		const objects = [
			{ type: 'object', subtype: 'path', rect: [55, 90, 95, 91] },
			{ type: 'object', subtype: 'path', rect: [55, 45, 95, 46] },
		];

		const refined = refineGraphicBlocks(blocks, lines, objects, [0, 0, 100, 100]);

		assert.equal(refined.length, 5);
		assert.deepEqual(refined.map(block => block.lines), [[0], [1], [2], [3], [4, 5, 6, 7]]);
	});

	it('does not join table fragments without two aligned horizontal rules', () => {
		const lines = [
			line(0, 'A1', [10, 70, 30, 80], 0),
			line(1, 'B1', [60, 70, 80, 80], 1),
			line(2, 'A2', [10, 50, 30, 60], 2),
			line(3, 'B2', [60, 50, 80, 60], 3),
		];
		const blocks = [
			{ type: 'table', bbox: [10, 70, 80, 80], lines: [0, 1], startOffset: 0, endOffset: 1 },
			{ type: 'table', bbox: [10, 50, 80, 60], lines: [2, 3], startOffset: 2, endOffset: 3 },
		];
		const objects = [
			{ type: 'object', subtype: 'path', rect: [5, 45, 85, 46] },
			{ type: 'object', subtype: 'path', rect: [5, 10, 85, 11] },
		];

		const refined = refineGraphicBlocks(blocks, lines, objects, [0, 0, 100, 100]);

		assert.equal(refined.length, 2);
		assert.deepEqual(refined.map(block => block.lines), [[0, 1], [2, 3]]);
	});

	it('does not join through a distant table-like fragment on the same rail', () => {
		const lines = [
			line(0, 'A1', [10, 70, 30, 80], 0),
			line(1, 'B1', [60, 70, 80, 80], 1),
			line(2, 'Footer text', [10, 10, 80, 20], 2),
		];
		const blocks = [
			{ type: 'table', bbox: [10, 70, 80, 80], lines: [0, 1], startOffset: 0, endOffset: 1 },
			{ type: 'table', bbox: [10, 10, 80, 20], lines: [2], startOffset: 2, endOffset: 2 },
		];
		const objects = [
			{ type: 'object', subtype: 'path', rect: [5, 65, 85, 66] },
			{ type: 'object', subtype: 'path', rect: [5, 85, 85, 86] },
		];

		const refined = refineGraphicBlocks(blocks, lines, objects, [0, 0, 100, 100]);

		assert.equal(refined.length, 2);
		assert.deepEqual(refined.map(block => block.lines), [[0, 1], [2]]);
	});

	it('does not join ruled table fragments with degraded text extraction', () => {
		const badText = String.fromCharCode(0xfffd).repeat(12);
		const lines = [
			line(0, badText, [10, 70, 30, 80], 0),
			line(1, badText, [60, 70, 80, 80], 1),
			line(2, badText, [10, 50, 30, 60], 2),
			line(3, badText, [60, 50, 80, 60], 3),
		];
		const blocks = [
			{ type: 'table', bbox: [10, 70, 80, 80], lines: [0, 1], startOffset: 0, endOffset: 1 },
			{ type: 'table', bbox: [10, 50, 80, 60], lines: [2, 3], startOffset: 2, endOffset: 3 },
		];

		const refined = refineGraphicBlocks(blocks, lines, ruledGridObjects(), [0, 0, 100, 100]);

		assert.equal(refined.length, 2);
		assert.deepEqual(refined.map(block => block.lines), [[0, 1], [2, 3]]);
	});
});

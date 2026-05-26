import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
	applyBlockClassifierPredictions,
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
});

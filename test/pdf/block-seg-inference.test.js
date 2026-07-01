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

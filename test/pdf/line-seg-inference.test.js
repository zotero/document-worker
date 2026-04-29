import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
	buildInferenceErrorFallbackBlocks,
	buildParagraphFallbackBlocks,
	inference,
	preparePageDataForInference
} from '../../src/pdf/structure/model/line-seg/inference.js';

function createPageData(objectCount) {
	return {
		pageIndex: 7,
		viewBox: [0, 0, 100, 100],
		chars: [
			{
				c: 'A',
				rect: [10, 10, 20, 20],
				fontSize: 10,
				lineBreakAfter: true,
			},
		],
		objects: Array.from({ length: objectCount }, (_, seq) => ({
			type: 'path',
			rect: [seq % 10, 0, (seq % 10) + 0.1, 0.1],
			seq,
		})),
	};
}

function createDenseTextPageData(lineCount, paragraphEvery = 0) {
	return {
		pageIndex: 2,
		viewBox: [0, 0, 100, 100],
		chars: Array.from({ length: lineCount }, (_, i) => ({
			c: String.fromCharCode(65 + (i % 26)),
			rect: [10, i, 20, i + 0.8],
			fontSize: 10,
			lineBreakAfter: true,
			...(paragraphEvery && (i + 1) % paragraphEvery === 0 ? { paragraphBreakAfter: true } : {}),
		})),
		objects: [],
	};
}

describe('line segmentation inference input preparation', () => {
	it('keeps object lines below the dense-object guard', () => {
		let val = {};
		let [page] = preparePageDataForInference([createPageData(2)], val);

		assert.equal(page.lines.filter(line => line.type === 'object').length, 2);
		assert.equal(val.layoutFallbacks, undefined);
	});

	it('falls back to text-only layout when a page has too many objects', () => {
		let val = {};
		let originalWarn = console.warn;
		let warnings = [];
		console.warn = (...args) => warnings.push(args.join(' '));
		try {
			let [page] = preparePageDataForInference([createPageData(501)], val);

			assert.equal(page.lines.length, 1);
			assert.equal(page.lines[0].text, 'A');
			assert.equal(page.lines.some(line => line.type === 'object'), false);
			assert.deepEqual(val.layoutFallbacks, [
				{
					type: 'text_only_layout',
					reason: 'too_many_objects',
					pageIndex: 7,
					pageNumber: 8,
					objectLineCount: 501,
					rawObjectCount: 501,
					limit: 500,
				},
			]);
			assert.match(warnings[0], /using text-only layout inference/);
		}
		finally {
			console.warn = originalWarn;
		}
	});

	it('builds paragraph-only fallback blocks from paragraphBreakAfter', () => {
		let blocks = buildParagraphFallbackBlocks(createDenseTextPageData(5, 2));

		assert.deepEqual(blocks.map(block => block.type), ['body', 'body', 'body']);
		assert.deepEqual(blocks.map(block => [block.startOffset, block.endOffset]), [
			[0, 1],
			[2, 3],
			[4, 4],
		]);
		assert.deepEqual(blocks.map(block => block.lines), [
			[0, 1],
			[2, 3],
			[4],
		]);
	});

	it('coalesces excessive paragraph fallback blocks', () => {
		let val = {};
		let blocks = buildParagraphFallbackBlocks(createDenseTextPageData(250, 1), val);

		assert.equal(blocks.length, 200);
		assert.deepEqual(blocks.map(block => block.type).every(type => type === 'body'), true);
		assert.equal(blocks[0].startOffset, 0);
		assert.equal(blocks.at(-1).endOffset, 249);
		assert.deepEqual(blocks.flatMap(block => block.lines), Array.from({ length: 250 }, (_, i) => i));
		assert.equal(val.layoutFallbacks.length, 1);
		assert.equal(val.layoutFallbacks[0].reason, 'fallback_blocks_coalesced');
		assert.equal(val.layoutFallbacks[0].blockCount, 250);
		assert.equal(val.layoutFallbacks[0].coalescedBlockCount, 200);
		assert.equal(val.layoutFallbacks[0].limit, 200);
	});

	it('uses paragraph fallback instead of initializing the model for too many lines', async () => {
		let val = {};
		let originalWarn = console.warn;
		let warnings = [];
		console.warn = (...args) => warnings.push(args.join(' '));
		try {
			let blocks = await inference(
				[createDenseTextPageData(1001, 500)],
				() => {
					throw new Error('onnx runtime should not be initialized');
				},
				() => {
					throw new Error('model should not be loaded');
				},
				val
			);

			assert.deepEqual(blocks.map(block => block.type), ['body', 'body', 'body']);
			assert.equal(val.layoutFallbacks.length, 1);
			assert.equal(val.layoutFallbacks[0].reason, 'too_many_lines');
			assert.equal(val.layoutFallbacks[0].lineCount, 1001);
			assert.equal(val.layoutFallbacks[0].limit, 1000);
			assert.match(warnings[0], /paragraph-only layout fallback/);
		}
		finally {
			console.warn = originalWarn;
		}
	});

	it('records inference-error paragraph fallback metadata', () => {
		let val = {};
		let originalWarn = console.warn;
		console.warn = () => {};
		try {
			let blocks = buildInferenceErrorFallbackBlocks(
				createDenseTextPageData(2, 1),
				val,
				new TypeError('run failed')
			);

			assert.deepEqual(blocks.map(block => block.type), ['body', 'body']);
			assert.equal(val.layoutFallbacks.length, 1);
			assert.equal(val.layoutFallbacks[0].reason, 'inference_error');
			assert.equal(val.layoutFallbacks[0].errorName, 'TypeError');
			assert.equal(val.layoutFallbacks[0].errorMessage, 'run failed');
		}
		finally {
			console.warn = originalWarn;
		}
	});
});

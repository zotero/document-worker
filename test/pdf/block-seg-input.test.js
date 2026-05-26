import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
	BLOCK_SEG_LINE_FEATURE_DIM,
	CORRECT_Y_GAP_TO_PREV_INDEX,
	READING_ORDER_Y_BACKTRACK_TO_PREV_INDEX,
	buildInferenceErrorFallbackBlocks,
	buildParagraphFallbackBlocks,
	prepareBlockSegPageInput,
} from '../../src/pdf/structure/model/block-seg/input.js';
import { inference } from '../../src/pdf/structure/model/block-seg/inference.js';
import clustererRuntimeMetadata from '../../src/pdf/structure/model/block-seg/clusterer/runtime.json' with { type: 'json' };
import { BlockClusterRuntime } from '../../src/pdf/structure/model/block-seg/clusterer/runtime.js';

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

function createDenseObjectPageData() {
	const objects = Array.from({ length: 300 }, (_, seq) => ({
		type: 'path',
		rect: [0, 0, 0.01, 0.01],
		seq,
	}));
	objects[20] = { type: 'path', rect: [0, 0, 100, 0], seq: 20 };
	objects[200] = { type: 'path', rect: [0, 0, 0, 80], seq: 200 };
	objects[290] = { type: 'xobject', rect: [0, 0, 50, 50], seq: 290 };
	return {
		...createPageData(0),
		objects,
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

function createDirectionalGapPageData() {
	return {
		pageIndex: 3,
		viewBox: [0, 0, 100, 100],
		chars: [
			{
				c: 'A',
				rect: [10, 80, 20, 90],
				fontSize: 10,
				lineBreakAfter: true,
			},
			{
				c: 'B',
				rect: [10, 67, 20, 77],
				fontSize: 10,
				lineBreakAfter: true,
			},
			{
				c: 'C',
				rect: [60, 85, 70, 95],
				fontSize: 10,
				lineBreakAfter: true,
			},
		],
		objects: [],
	};
}

describe('block segmentation input preparation', () => {
	it('keeps object lines as model and graphic context', () => {
		let page = prepareBlockSegPageInput(createPageData(2));

		assert.equal(page.textLines.length, 1);
		assert.equal(page.objectLines.length, 2);
		assert.equal(page.objectFeatures.length, 2);
	});

	it('keeps all objects at the layout object limit', () => {
		let page = prepareBlockSegPageInput(createPageData(256));

		assert.equal(page.textLines.length, 1);
		assert.equal(page.textLines[0].text, 'A');
		assert.equal(page.objectLines.length, 256);
		assert.equal(page.objectFeatures.length, 256);
	});

	it('caps dense objects by normalized perimeter while preserving original order', () => {
		let page = prepareBlockSegPageInput(createDenseObjectPageData());
		let seqs = page.objectLines.map(object => object.seq);

		assert.equal(page.objectLines.length, 256);
		assert.equal(page.objectFeatures.length, 256);
		assert.deepEqual(seqs, seqs.slice().sort((a, b) => a - b));
		assert.ok(seqs.includes(20));
		assert.ok(seqs.includes(200));
		assert.ok(seqs.includes(290));
		assert.equal(seqs.includes(299), false);
	});

	it('emits clean-v3-directional line feature geometry', () => {
		let page = prepareBlockSegPageInput(createDirectionalGapPageData());
		let features = page.lineFeatures;

		assert.equal(clustererRuntimeMetadata.lineFeatureTransform, 'clean-v3-directional');
		assert.equal(clustererRuntimeMetadata.shapeMode, 'dynamic');
		assert.equal(clustererRuntimeMetadata.fixedShape.maxTextTokens, 512);
		assert.equal(clustererRuntimeMetadata.inputFeatureDim, BLOCK_SEG_LINE_FEATURE_DIM);
		assert.equal(READING_ORDER_Y_BACKTRACK_TO_PREV_INDEX, 13);
		assert.equal(CORRECT_Y_GAP_TO_PREV_INDEX, 21);
		assert.deepEqual(clustererRuntimeMetadata.outputs, ['emissions', 'object_rule_logits']);
		assert.deepEqual(features.map(row => row.length), [BLOCK_SEG_LINE_FEATURE_DIM, BLOCK_SEG_LINE_FEATURE_DIM, BLOCK_SEG_LINE_FEATURE_DIM]);

		assert.equal(features[1][CORRECT_Y_GAP_TO_PREV_INDEX], 0.3);

		assert.equal(features[2][CORRECT_Y_GAP_TO_PREV_INDEX], 0);
		assert.equal(features[2][READING_ORDER_Y_BACKTRACK_TO_PREV_INDEX], 0.8);
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
		const limit = clustererRuntimeMetadata.fixedShape.maxTextTokens;
		let blocks = await inference(
			[createDenseTextPageData(limit + 1, Math.floor(limit / 2))],
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
		assert.equal(val.layoutFallbacks[0].lineCount, limit + 1);
		assert.equal(val.layoutFallbacks[0].limit, limit);
	});

	it('feeds dynamic line and object lengths while enforcing maxTextTokens', async () => {
		let calls = [];
		let fakeOrt = {
			Tensor: class {
				constructor(type, data, dims) {
					this.type = type;
					this.data = data;
					this.dims = dims;
				}
			},
		};
		let fakeSession = {
			async run(feeds) {
				calls.push({
					lineDims: feeds.line_features.dims,
					lineMaskDims: feeds.line_pad_mask.dims,
					objectDims: feeds.object_features.dims,
					objectMaskDims: feeds.object_pad_mask.dims,
					objectMask: Array.from(feeds.object_pad_mask.data),
				});
				return {
					emissions: { data: new Float32Array(feeds.line_features.dims[1] * 18) },
					object_rule_logits: { data: new Float32Array(feeds.object_features.dims[1] * 2) },
				};
			},
		};
		let runtime = new BlockClusterRuntime(
			fakeOrt,
			fakeSession,
			{
				inputFeatureDim: BLOCK_SEG_LINE_FEATURE_DIM,
				maxTextTokens: clustererRuntimeMetadata.fixedShape.maxTextTokens,
				maxObjects: clustererRuntimeMetadata.fixedShape.maxObjects,
			},
			{}
		);
		runtime.repairLabels = (_emissions, lines, objects, _objectLogits, objectCount) => {
			assert.equal(lines.length, 7);
			assert.equal(objects.length, 3);
			assert.equal(objectCount, 3);
			return Array(lines.length).fill(1);
		};

		let lines = Array.from({ length: 7 }, () => Array(BLOCK_SEG_LINE_FEATURE_DIM).fill(0));
		let objects = Array.from({ length: 3 }, () => Array(BLOCK_SEG_LINE_FEATURE_DIM).fill(0));
		let result = await runtime.run(lines, objects);

		assert.deepEqual(result.labels, Array(7).fill(1));
		assert.deepEqual(calls[0].lineDims, [1, 7, BLOCK_SEG_LINE_FEATURE_DIM]);
		assert.deepEqual(calls[0].lineMaskDims, [1, 7]);
		assert.deepEqual(calls[0].objectDims, [1, 3, BLOCK_SEG_LINE_FEATURE_DIM]);
		assert.deepEqual(calls[0].objectMaskDims, [1, 3]);
		assert.deepEqual(calls[0].objectMask, [0, 0, 0]);

		await assert.rejects(
			() => runtime.run(
				Array.from(
					{ length: clustererRuntimeMetadata.fixedShape.maxTextTokens + 1 },
					() => Array(BLOCK_SEG_LINE_FEATURE_DIM).fill(0)
				),
				[]
			),
			/at most 512 lines/
		);
		assert.equal(calls.length, 1);
	});

	it('records inference-error paragraph fallback metadata', () => {
		let val = {};
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
	});
});

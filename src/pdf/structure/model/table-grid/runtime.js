import {
	EDGE_FEATURE_DIM,
	NODE_FEATURE_DIM,
	buildPageFeatureArrays,
	createOnnxFeatureArrays,
} from './features.js';
import {
	buildAxisMergeInputs,
	buildCells,
	groupLabels,
	logitsToScores,
	mergeAxisLabels,
} from './decoder.js';

const SESSION_OPTIONS = {
	executionProviders: ['wasm'],
	graphOptimizationLevel: 'all',
	executionMode: 'sequential',
};

const ROW_MERGE_CONFIG = {
	threshold: 0.94,
	scoreThreshold: 0.99,
	cellThreshold: 0.98,
	pairRankGap: 10,
	maxCenterDeltaBase: 20,
};

const COL_MERGE_CONFIG = {
	threshold: 0.82,
	scoreThreshold: 0.99,
	cellThreshold: 0.98,
	pairRankGap: 8,
	maxCenterDeltaBase: 12,
};

function makeFeeds(ort, arrays) {
	const { n, k } = arrays;
	return {
		node_feats: new ort.Tensor('float32', arrays.nodeFeats, [
			1,
			n,
			NODE_FEATURE_DIM,
		]),
		edge_index: new ort.Tensor('int64', arrays.edgeIndex, [1, n, k]),
		edge_feats: new ort.Tensor('float32', arrays.edgeFeats, [
			1,
			n,
			k,
			EDGE_FEATURE_DIM,
		]),
		node_mask: new ort.Tensor('float32', arrays.nodeMask, [1, n]),
		edge_mask: new ort.Tensor('float32', arrays.edgeMask, [1, n, k]),
	};
}

function makeMergeFeeds(ort, features) {
	return {
		features: new ort.Tensor('float32', features, [features.length / 24, 24]),
	};
}

function outputData(outputs, name) {
	const tensor = outputs[name];
	if (!tensor?.data) throw new Error(`ONNX output ${name} was not returned`);
	return tensor.data;
}

function sigmoidArray(logits) {
	const out = new Float32Array(logits.length);
	for (let index = 0; index < logits.length; index++) {
		out[index] = 1 / (1 + Math.exp(-logits[index]));
	}
	return out;
}

async function runMerger(ort, session, mergeInput) {
	if (!mergeInput.features.length) return new Float32Array(0);
	const outputs = await session.run(makeMergeFeeds(ort, mergeInput.features));
	return sigmoidArray(outputData(outputs, 'logits'));
}

function requireModel(models, name) {
	const value = models?.[name];
	if (!value) throw new Error(`Missing table-grid model ${name}`);
	return value;
}

export async function createCompactTableRuntime({ ort, models } = {}) {
	if (!ort)
		throw new Error('table-grid runtime requires an ONNX runtime provider');

	const [singleScorerSession, rowMergeSession, colMergeSession] =
		await Promise.all([
			ort.InferenceSession.create(
				requireModel(models, 'singleScorer'),
				SESSION_OPTIONS,
			),
			ort.InferenceSession.create(
				requireModel(models, 'rowMerge'),
				SESSION_OPTIONS,
			),
			ort.InferenceSession.create(
				requireModel(models, 'colMerge'),
				SESSION_OPTIONS,
			),
		]);

	async function infer(page) {
		const features = buildPageFeatureArrays(page);
		const actualN = features.n;
		if (actualN === 0) {
			return {
				atoms: [],
				rowLabels: [],
				colLabels: [],
				rows: [],
				cols: [],
				cells: [],
			};
		}

		const feeds = makeFeeds(ort, createOnnxFeatureArrays(features));

		const outputs = await singleScorerSession.run(feeds);

		const sameCellScores = logitsToScores(
			outputData(outputs, 'same_box_logits'),
			actualN,
			features.k,
		);
		const rowScores = logitsToScores(
			outputData(outputs, 'same_line_logits'),
			actualN,
			features.k,
		);
		const colScores = logitsToScores(
			outputData(outputs, 'next_in_line_logits'),
			actualN,
			features.k,
		);

		const record = {
			atoms: features.atoms,
			pageW: features.pageW,
			pageH: features.pageH,
			edgeIndex: features.edgeIndex,
			edgeMask: features.edgeMask,
			k: features.k,
		};

		const rowInput = buildAxisMergeInputs(
			record,
			'row',
			rowScores,
			sameCellScores,
			ROW_MERGE_CONFIG,
		);
		const rowMergeScores = await runMerger(ort, rowMergeSession, rowInput);

		const colInput = buildAxisMergeInputs(
			record,
			'col',
			colScores,
			sameCellScores,
			COL_MERGE_CONFIG,
		);
		const colMergeScores = await runMerger(ort, colMergeSession, colInput);

		const rowLabels = mergeAxisLabels(
			record,
			rowInput.baseLabels,
			rowInput.pairs,
			rowMergeScores,
			ROW_MERGE_CONFIG.threshold,
		);
		const colLabels = mergeAxisLabels(
			record,
			colInput.baseLabels,
			colInput.pairs,
			colMergeScores,
			COL_MERGE_CONFIG.threshold,
		);
		const rows = groupLabels(record.atoms, rowLabels, rowInput.axis);
		const cols = groupLabels(record.atoms, colLabels, colInput.axis);
		const cells = buildCells(record.atoms, rowLabels, colLabels);

		return {
			atoms: record.atoms,
			rowLabels,
			colLabels,
			rows,
			cols,
			cells,
		};
	}

	async function release() {
		await Promise.all([
			singleScorerSession.release?.(),
			rowMergeSession.release?.(),
			colMergeSession.release?.(),
		]);
	}

	return {
		infer,
		release,
	};
}

import runtimeMetadata from './runtime.json' with { type: 'json' };
import { onnxMutex, getRuntime } from '../../onnx/runtime.js';

const NUM_CLASSES = 18;
const EPS = 1e-5;

let runtimePromise = null;

function toArrayBuffer(data) {
	if (data instanceof ArrayBuffer) {
		return data;
	}
	if (ArrayBuffer.isView(data)) {
		return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
	}
	return new Uint8Array(data).buffer;
}

function float16ToFloat32(values) {
	const out = new Float32Array(values.length);
	for (let i = 0; i < values.length; i++) {
		const x = values[i];
		const sign = (x & 0x8000) ? -1 : 1;
		const exp = (x >> 10) & 31;
		const mantissa = x & 1023;
		out[i] = exp
			? sign * Math.pow(2, exp - 15) * (1 + mantissa / 1024)
			: sign * Math.pow(2, -14) * (mantissa / 1024);
	}
	return out;
}

function loadArrays(meta, binData) {
	const buf = toArrayBuffer(binData);
	const arrays = {};
	for (const item of meta.arrays) {
		const byteOffset = item.byteOffset ?? item.offset * 4;
		if (item.dtype === 'f16') {
			arrays[item.name] = float16ToFloat32(new Uint16Array(buf, byteOffset, item.length));
		}
		else {
			arrays[item.name] = new Float32Array(buf, byteOffset, item.length);
		}
	}
	return arrays;
}

async function createRuntime(onnxRuntimeProvider, modelProvider) {
	const ort = await getRuntime(onnxRuntimeProvider);
	const modelBytes = await modelProvider('block-seg/clusterer/model.onnx');
	const repairBytes = await modelProvider('block-seg/clusterer/repair.onnx');
	const binBytes = await modelProvider('block-seg/clusterer/runtime.bin');
	const meta = normalizeMetadata(runtimeMetadata);
	const arrays = loadArrays(meta, binBytes);
	return await onnxMutex.runExclusive(async () => {
		const options = {
			executionProviders: ['wasm'],
			graphOptimizationLevel: 'all',
		};
		const [session, repairSession] = await Promise.all([
			ort.InferenceSession.create(modelBytes, options),
			ort.InferenceSession.create(repairBytes, options),
		]);
		return new BlockClusterRuntime(ort, session, repairSession, meta, arrays);
	});
}

export async function getBlockClusterRuntime(onnxRuntimeProvider, modelProvider) {
	if (!runtimePromise) {
		runtimePromise = createRuntime(onnxRuntimeProvider, modelProvider);
	}
	return runtimePromise;
}

export class BlockClusterRuntime {
	constructor(ort, session, repairSession, meta, arrays) {
		if (arrays === undefined) {
			arrays = meta;
			meta = repairSession;
			repairSession = null;
		}
		this.ort = ort;
		this.session = session;
		this.repairSession = repairSession;
		this.meta = meta;
		this.arrays = arrays;
	}

	async run(lineFeatures, objectFeatures = []) {
		const T = lineFeatures.length;
		const F = this.meta.inputFeatureDim;
		if (!T) {
			return { labels: [] };
		}
		if (T > this.meta.maxTextTokens) {
			throw new Error(`Block cluster model supports at most ${this.meta.maxTextTokens} lines, got ${T}`);
		}

		const objectCount = Math.min(objectFeatures.length, this.meta.maxObjects);
		const objectRows = Math.max(1, objectCount);
		const objectInput = objectFeatures.slice(0, objectCount);
		const feeds = {
			line_features: new this.ort.Tensor('float32', flattenRows(lineFeatures, F), [1, T, F]),
			line_pad_mask: new this.ort.Tensor('bool', new Uint8Array(T), [1, T]),
			object_features: new this.ort.Tensor('float32', flattenRows(objectInput, F, objectRows), [1, objectRows, F]),
			object_pad_mask: new this.ort.Tensor('bool', buildObjectMask(objectCount, objectRows), [1, objectRows]),
		};
		const out = objectCount > 0
			? await this.session.run(feeds)
			: await this.session.run(feeds, ['emissions']);
		const emissions = out.emissions?.data;
		if (!emissions) {
			throw new Error('Block cluster model did not return emissions');
		}
		const objectLogits = objectCount > 0 ? out.object_rule_logits?.data : new Float32Array(0);
		if (!objectLogits && objectCount > 0) {
			throw new Error('Block cluster model did not return object rule logits');
		}
		return {
			labels: await this.repairLabels(emissions, lineFeatures, objectInput, objectLogits, objectCount),
		};
	}

	async repairLabels(emissions, lines, objects, objectLogits, objectCount) {
		const labels = viterbi(
			emissions,
			lines.length,
			this.arrays['crf.transitions'],
			this.arrays['crf.start'],
			this.arrays['crf.end'],
		);
		const classCount = objectCount > 0 ? objectLogits.length / objectCount : 0;
		const tableProbs = objectTableProbs(objectLogits, objectCount, classCount);
		const objectSummary = legacyObjectSummary(lines, objects, tableProbs);
		return await this.repairAllGapLabelsBatched(emissions, lines, labels, objectSummary);
	}

	async repairAllGapLabelsBatched(emissions, lines, labels, objectSummary) {
		const repaired = labels.slice();
		const transitions = this.arrays['crf.transitions'];
		const scratch = createRepairScratch(this.meta.repairDims);
		const threshold = Number(this.meta.threshold);
		const featureDim = this.meta.repairDims[0];
		const candidateFeatures = new Float32Array(Math.max(0, labels.length - 1) * featureDim);
		const candidateIndexes = [];
		const candidateBases = [];
		for (let t = 1; t < labels.length; t++) {
			const leftLabel = labels[t - 1];
			const rightLabel = labels[t];
			const leftBase = this.meta.classToBaseArray[leftLabel] ?? -1;
			const rightBase = this.meta.classToBaseArray[rightLabel] ?? -1;
			if (!this.meta.primaryBaseMask[rightBase]) {
				continue;
			}
			if (!this.meta.primaryBaseMask[leftBase]) {
				repaired[t] = this.meta.startLabelForBase[rightBase] ?? rightLabel;
				continue;
			}
			fillGapFeature(
				candidateFeatures,
				candidateIndexes.length * featureDim,
				scratch,
				transitions,
				emissions,
				lines,
				leftLabel,
				rightLabel,
				leftBase,
				rightBase,
				t,
				objectSummary,
				this.meta,
			);
			candidateIndexes.push(t);
			candidateBases.push(rightBase);
		}
		if (!candidateIndexes.length) {
			return repaired;
		}
		const inputData = candidateFeatures.subarray(0, candidateIndexes.length * featureDim);
		const out = await this.repairSession.run({
			features: new this.ort.Tensor('float32', inputData, [candidateIndexes.length, featureDim]),
		});
		const logits = out.logits?.data;
		if (!logits) {
			throw new Error('Block cluster repair model did not return logits');
		}
		for (let i = 0; i < candidateIndexes.length; i++) {
			const t = candidateIndexes[i];
			const rightBase = candidateBases[i];
			const rightLabel = labels[t];
			const p = sigmoid(logits[i]);
			const split = p >= threshold;
			repaired[t] = split
				? (this.meta.startLabelForBase[rightBase] ?? rightLabel)
				: (this.meta.contLabelForBase[rightBase] ?? rightLabel);
		}
		return repaired;
	}
}

function normalizeMetadata(meta) {
	const fixedShape = meta.fixedShape || {};
	const repairDims = meta.repairDims || [
		meta.repair?.featureDim,
		meta.repair?.hiddenDim,
		meta.repair?.midDim,
	];
	const normalized = {
		...meta,
		inputFeatureDim: Number(meta.inputFeatureDim ?? fixedShape.inputFeatureDim),
		baseLineFeatureDim: Number(meta.baseLineFeatureDim),
		maxTextTokens: Number(meta.maxTextTokens ?? fixedShape.maxTextTokens),
		maxObjects: Number(meta.maxObjects ?? fixedShape.maxObjects),
		repairDims: repairDims.map(Number),
	};
	if (![
		normalized.inputFeatureDim,
		normalized.baseLineFeatureDim,
		normalized.maxTextTokens,
		normalized.maxObjects,
		...normalized.repairDims,
	].every(Number.isFinite)) {
		throw new Error('Invalid block cluster metadata');
	}
	normalized.classToBaseArray = denseLookup(meta.classToBase, NUM_CLASSES, -1);
	normalized.startOfArray = denseLookup(meta.startOf, NUM_CLASSES, -1);
	normalized.contClassMask = boolMask(meta.contClasses, NUM_CLASSES);
	normalized.primaryBaseMask = boolMask(meta.primaryBases, Number(meta.numBaseTypes || 0));
	normalized.startLabelForBase = new Array(Number(meta.numBaseTypes || 0)).fill(null);
	normalized.contLabelForBase = new Array(Number(meta.numBaseTypes || 0)).fill(null);
	for (let base = 0; base < normalized.startLabelForBase.length; base++) {
		normalized.startLabelForBase[base] = base;
		const cont = base + Number(meta.numBaseTypes || 0);
		if (normalized.contClassMask[cont]) {
			normalized.contLabelForBase[base] = cont;
		}
	}
	return normalized;
}

function denseLookup(source, length, fallback) {
	const out = new Array(length).fill(fallback);
	if (!source) {
		return out;
	}
	for (const [key, value] of Object.entries(source)) {
		const index = Number(key);
		if (Number.isInteger(index) && index >= 0 && index < length) {
			out[index] = value;
		}
	}
	return out;
}

function boolMask(values, length) {
	const out = new Array(length).fill(false);
	for (const value of values || []) {
		if (Number.isInteger(value) && value >= 0 && value < length) {
			out[value] = true;
		}
	}
	return out;
}

function buildObjectMask(validCount, totalCount) {
	const mask = new Uint8Array(totalCount);
	if (validCount === 0) {
		mask.fill(1);
	}
	return mask;
}

function flattenRows(rows, width, minRows = rows.length) {
	const out = new Float32Array(Math.max(minRows, rows.length) * width);
	for (let i = 0; i < rows.length; i++) {
		const row = rows[i];
		for (let j = 0; j < width; j++) {
			out[i * width + j] = Number.isFinite(row?.[j]) ? row[j] : 0;
		}
	}
	return out;
}

function viterbi(emissions, T, transitions, start, end) {
	let score = new Float32Array(NUM_CLASSES);
	let next = new Float32Array(NUM_CLASSES);
	const backpointers = new Int16Array(T * NUM_CLASSES);
	for (let j = 0; j < NUM_CLASSES; j++) {
		score[j] = start[j] + emissions[j];
	}
	for (let t = 1; t < T; t++) {
		for (let j = 0; j < NUM_CLASSES; j++) {
			let bestIndex = 0;
			let bestScore = -Infinity;
			for (let i = 0; i < NUM_CLASSES; i++) {
				const s = score[i] + transitions[i * NUM_CLASSES + j];
				if (s > bestScore) {
					bestScore = s;
					bestIndex = i;
				}
			}
			next[j] = bestScore + emissions[t * NUM_CLASSES + j];
			backpointers[t * NUM_CLASSES + j] = bestIndex;
		}
		const tmp = score;
		score = next;
		next = tmp;
	}
	let last = 0;
	let best = -Infinity;
	for (let j = 0; j < NUM_CLASSES; j++) {
		const s = score[j] + end[j];
		if (s > best) {
			best = s;
			last = j;
		}
	}
	const path = new Array(T);
	path[T - 1] = last;
	for (let t = T - 1; t > 0; t--) {
		path[t - 1] = backpointers[t * NUM_CLASSES + path[t]];
	}
	return path;
}

function objectTableProbs(logits, objectCount, classCount) {
	const out = new Float32Array(objectCount);
	if (!objectCount || !classCount) {
		return out;
	}
	for (let i = 0; i < objectCount; i++) {
		let max = -Infinity;
		let sum = 0;
		let table = 0;
		for (let k = 0; k < classCount; k++) {
			max = Math.max(max, logits[i * classCount + k]);
		}
		for (let k = 0; k < classCount; k++) {
			const e = Math.exp(logits[i * classCount + k] - max);
			sum += e;
			if (k > 0) {
				table += e;
			}
		}
		out[i] = table / Math.max(sum, EPS);
	}
	return out;
}

function legacyObjectSummary(lines, objects, probs) {
	const n = lines.length;
	const o = objects.length;
	const out = new Float64Array(n * 12);
	if (!o) {
		return out;
	}
	let maxP = 0;
	for (const p of probs) {
		maxP = Math.max(maxP, p);
	}
	for (let i = 0; i < n; i++) {
		const line = lines[i];
		const lcx = (line[0] + line[2]) / 2;
		const lcy = (line[1] + line[3]) / 2;
		const lw = Math.max(line[2] - line[0], EPS);
		const lh = Math.max(line[3] - line[1], EPS);
		let sum = 0;
		let near = 0;
		let leftRight = 0;
		let aboveBelow = 0;
		let overlapXMax = 0;
		let overlapYMax = 0;
		let bestDx = 0;
		let bestDy = 0;
		let best = -Infinity;
		let top1 = 0;
		let top2 = 0;
		let top3 = 0;
		for (let j = 0; j < o; j++) {
			const object = objects[j];
			const ocx = (object[0] + object[2]) / 2;
			const ocy = (object[1] + object[3]) / 2;
			const dx = Math.abs(ocx - lcx);
			const dy = Math.abs(ocy - lcy);
			const p = probs[j];
			const affinity = Math.exp(-(dx / 0.08 + dy / 0.04)) * p;
			sum += affinity;
			if (affinity > top1) {
				top3 = top2;
				top2 = top1;
				top1 = affinity;
			}
			else if (affinity > top2) {
				top3 = top2;
				top2 = affinity;
			}
			else if (affinity > top3) {
				top3 = affinity;
			}
			if (affinity > best) {
				best = affinity;
				bestDx = Math.min(dx, 1);
				bestDy = Math.min(dy, 1);
			}
			const iw = Math.max(0, Math.min(object[2], line[2]) - Math.max(object[0], line[0]));
			const ih = Math.max(0, Math.min(object[3], line[3]) - Math.max(object[1], line[1]));
			overlapXMax = Math.max(overlapXMax, Math.min(iw / lw, 1));
			overlapYMax = Math.max(overlapYMax, Math.min(ih / lh, 1));
			if (dx < 0.10 && dy < 0.08) {
				near += p;
			}
			if (object[0] <= lcx && object[2] >= lcx) {
				leftRight = Math.max(leftRight, p);
			}
			if (object[1] <= lcy && object[3] >= lcy) {
				aboveBelow = Math.max(aboveBelow, p);
			}
		}
		const k = Math.min(3, o);
		const top = (top1 + (k > 1 ? top2 : 0) + (k > 2 ? top3 : 0)) / k;
		const offset = i * 12;
		out[offset] = Math.max(0, best);
		out[offset + 1] = Math.min(sum, 8) / 8;
		out[offset + 2] = top;
		out[offset + 3] = maxP;
		out[offset + 4] = bestDx;
		out[offset + 5] = bestDy;
		out[offset + 6] = overlapXMax;
		out[offset + 7] = overlapYMax;
		out[offset + 8] = Math.min(near, 8) / 8;
		out[offset + 9] = leftRight;
		out[offset + 10] = aboveBelow;
		out[offset + 11] = Math.min(o, 128) / 128;
	}
	return out;
}

function createRepairScratch(dims) {
	return {
		feature: new Array(dims[0]),
		hidden: new Array(dims[1]),
		mid: new Array(dims[2]),
		leftProb: new Array(NUM_CLASSES),
		rightProb: new Array(NUM_CLASSES),
	};
}

function fillGapFeature(feature, featureOffset, scratch, transitions, emissions, lineFeatures, leftLabel, rightLabel, leftBase, rightBase, t, objectSummary, meta) {
	const leftIndex = t - 1;
	const rightIndex = t;
	const left = lineFeatures[leftIndex];
	const right = lineFeatures[rightIndex];
	const baseDim = meta.baseLineFeatureDim || 21;
	const leftProb = scratch.leftProb;
	const rightProb = scratch.rightProb;
	const leftTop = softmaxLineInto(emissions, leftIndex, leftProb);
	const rightTop = softmaxLineInto(emissions, rightIndex, rightProb);
	const predBoundary = !meta.contClassMask[rightLabel] || leftBase !== rightBase ? 1 : 0;
	const rightStart = meta.startOfArray[rightLabel] >= 0 ? meta.startOfArray[rightLabel] : rightLabel;
	const rightCont = rightStart + meta.numBaseTypes;
	const transStart = validLabel(leftLabel) && validLabel(rightStart)
		? transitions[leftLabel * NUM_CLASSES + rightStart]
		: 0;
	const transCont = validLabel(leftLabel) && validLabel(rightCont)
		? transitions[leftLabel * NUM_CLASSES + rightCont]
		: 0;
	const scoreStart = validLabel(rightStart) ? emissions[rightIndex * NUM_CLASSES + rightStart] : 0;
	const scoreCont = validLabel(rightCont) ? emissions[rightIndex * NUM_CLASSES + rightCont] : 0;

	let index = featureOffset;
	for (let i = 0; i < baseDim; i++) {
		feature[index++] = left[i];
	}
	for (let i = 0; i < baseDim; i++) {
		feature[index++] = right[i];
	}
	for (let i = 0; i < 16; i++) {
		feature[index++] = right[i] - left[i];
	}
	const [lx1, ly1, lx2, ly2] = left;
	const [rx1, ry1, rx2, ry2] = right;
	const lw = Math.max(Math.abs(lx2 - lx1), EPS);
	const lh = Math.max(Math.abs(ly2 - ly1), EPS);
	const rw = Math.max(Math.abs(rx2 - rx1), EPS);
	const rh = Math.max(Math.abs(ry2 - ry1), EPS);
	const lcx = 0.5 * (lx1 + lx2);
	const lcy = 0.5 * (ly1 + ly2);
	const rcx = 0.5 * (rx1 + rx2);
	const rcy = 0.5 * (ry1 + ry2);
	const xOverlap = Math.max(0, Math.min(lx2, rx2) - Math.max(lx1, rx1));
	const yOverlap = Math.max(0, Math.min(ly2, ry2) - Math.max(ly1, ry1));
	feature[index++] = rcx - lcx;
	feature[index++] = rcy - lcy;
	feature[index++] = Math.abs(rx1 - lx1);
	feature[index++] = Math.abs(rx2 - lx2);
	feature[index++] = Math.abs(ry1 - ly1);
	feature[index++] = Math.abs(ry2 - ly2);
	feature[index++] = xOverlap / Math.max(Math.min(lw, rw), EPS);
	feature[index++] = yOverlap / Math.max(Math.min(lh, rh), EPS);
	feature[index++] = rw / lw;
	feature[index++] = rh / lh;
	feature[index++] = Math.max(0, ry1 - ly2);
	feature[index++] = Math.max(0, ly1 - ry2);

	const leftEmissionStart = leftIndex * NUM_CLASSES;
	const rightEmissionStart = rightIndex * NUM_CLASSES;
	for (let i = 0; i < NUM_CLASSES; i++) {
		feature[index++] = emissions[leftEmissionStart + i];
	}
	for (let i = 0; i < NUM_CLASSES; i++) {
		feature[index++] = emissions[rightEmissionStart + i];
	}
	for (let i = 0; i < NUM_CLASSES; i++) {
		feature[index++] = leftProb[i];
	}
	for (let i = 0; i < NUM_CLASSES; i++) {
		feature[index++] = rightProb[i];
	}
	for (let i = 0; i < NUM_CLASSES; i++) {
		feature[index++] = i === leftLabel ? 1 : 0;
	}
	for (let i = 0; i < NUM_CLASSES; i++) {
		feature[index++] = i === rightLabel ? 1 : 0;
	}
	let objectOffset = leftIndex * 12;
	for (let i = 0; i < 12; i++) {
		feature[index++] = objectSummary[objectOffset + i];
	}
	objectOffset = rightIndex * 12;
	for (let i = 0; i < 12; i++) {
		feature[index++] = objectSummary[objectOffset + i];
	}
	feature[index++] = leftTop.first;
	feature[index++] = rightTop.first;
	feature[index++] = leftTop.first - leftTop.second;
	feature[index++] = rightTop.first - rightTop.second;
	feature[index++] = predBoundary;
	feature[index++] = leftBase === rightBase ? 1 : 0;
	feature[index++] = leftBase / 10;
	feature[index++] = rightBase / 10;
	feature[index++] = scoreStart;
	feature[index++] = scoreCont;
	feature[index++] = scoreStart - scoreCont;
	feature[index++] = transStart;
	feature[index++] = transCont;
	feature[index++] = transStart - transCont;
	for (let i = baseDim; i < left.length; i++) {
		feature[index++] = left[i];
	}
	for (let i = baseDim; i < right.length; i++) {
		feature[index++] = right[i];
	}
	for (let i = baseDim; i < right.length; i++) {
		feature[index++] = right[i] - left[i];
	}
	const written = index - featureOffset;
	if (written !== meta.repairDims[0]) {
		throw new Error(`Unexpected gap-repair feature length ${written}, expected ${meta.repairDims[0]}`);
	}
}

function softmaxLineInto(emissions, index, out) {
	const start = index * NUM_CLASSES;
	let max = -Infinity;
	for (let i = 0; i < NUM_CLASSES; i++) {
		max = Math.max(max, emissions[start + i]);
	}
	let sum = 0;
	for (let i = 0; i < NUM_CLASSES; i++) {
		const value = Math.exp(emissions[start + i] - max);
		out[i] = value;
		sum += value;
	}
	const denom = Math.max(sum, EPS);
	let first = -Infinity;
	let second = -Infinity;
	for (let i = 0; i < NUM_CLASSES; i++) {
		const value = out[i] / denom;
		out[i] = value;
		if (value > first) {
			second = first;
			first = value;
		}
		else if (value > second) {
			second = value;
		}
	}
	return { first, second };
}

function validLabel(label) {
	return Number.isInteger(label) && label >= 0 && label < NUM_CLASSES;
}

function sigmoid(x) {
	return 1 / (1 + Math.exp(-x));
}

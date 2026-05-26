import { onnxMutex, getRuntime } from '../../onnx/runtime.js';
import metadata from './metadata.json' with { type: 'json' };

let runtimePromise = null;

async function createRuntime(onnxRuntimeProvider, modelProvider) {
	const ort = await getRuntime(onnxRuntimeProvider);
	return await onnxMutex.runExclusive(async () => {
		const [modelBytes, statsBytes] = await Promise.all([
			modelProvider('block-seg/classifier/model.onnx'),
			modelProvider('block-seg/classifier/stats.bin'),
		]);
		const session = await ort.InferenceSession.create(modelBytes, {
			executionProviders: ['wasm'],
			graphOptimizationLevel: 'all',
		});
		const meta = normalizeMetadata(metadata);
		return new BlockSegClassifierRuntime(ort, session, meta, loadStats(statsBytes, meta));
	});
}

export async function getBlockSegClassifierRuntime(onnxRuntimeProvider, modelProvider) {
	if (!runtimePromise) {
		runtimePromise = createRuntime(onnxRuntimeProvider, modelProvider);
	}
	return runtimePromise;
}

export class BlockSegClassifierRuntime {
	constructor(ort, session, meta, stats) {
		this.ort = ort;
		this.session = session;
		this.meta = meta;
		this.stats = stats;
		this.typeNames = this.meta.typeNames;
		this.flowNames = this.meta.flowNames;
		this.maxBlocks = this.meta.maxBlocks;
	}

	async run(features) {
		const count = features.blockCount || 0;
		if (!count) {
			return [];
		}
		const outputs = [];
		for (let start = 0; start < count; start += this.maxBlocks) {
			const length = Math.min(this.maxBlocks, count - start);
			const chunk = sliceFeatureChunk(features, start, length, this.stats, this.meta);
			const feeds = {};
			addFeed(this.ort, feeds, this.meta, 'regular_features', 'float32', chunk.regular, [1, length, this.meta.regularDim]);
			addFeed(this.ort, feeds, this.meta, 'rich_features', 'float32', chunk.rich, [1, length, this.meta.richDim]);
			addFeed(this.ort, feeds, this.meta, 'hash_slots', 'int64', toBigInt64Array(chunk.hashSlots), [1, length, this.meta.hashSlots]);
			addFeed(this.ort, feeds, this.meta, 'char_slots', 'int64', toBigInt64Array(chunk.charSlots), [1, length, this.meta.charSlots]);
			addFeed(this.ort, feeds, this.meta, 'pad_mask', 'bool', chunk.padMask, [1, length]);
			const result = await this.session.run(feeds);
			const blockLogits = result.type_logits?.data;
			const flowLogits = result.flow_logits?.data;
			if (!blockLogits || !flowLogits) {
				throw new Error('Block segmentation classifier did not return expected logits');
			}
			for (let i = 0; i < length; i++) {
				const blockType = argmax(blockLogits, i * this.typeNames.length, this.typeNames.length);
				const flowClass = argmax(flowLogits, i * this.flowNames.length, this.flowNames.length);
				outputs.push({
					blockType,
					blockTypeName: this.typeNames[blockType],
					flowClass,
					flowClassName: this.flowNames[flowClass],
				});
			}
		}
		return outputs;
	}
}

function loadStats(data, meta) {
	const buffer = toArrayBuffer(data);
	const regularMean = readStatsArray(buffer, meta, 'regular_mean');
	const regularStd = readStatsArray(buffer, meta, 'regular_std');
	const richMean = readStatsArray(buffer, meta, 'rich_mean');
	const richStd = readStatsArray(buffer, meta, 'rich_std');
	return { regularMean, regularStd, richMean, richStd };
}

function readStatsArray(buffer, meta, name) {
	const item = Array.isArray(meta.stats) ? meta.stats.find(x => x.name === name) : null;
	if (!item) {
		throw new Error(`Missing block classifier stats entry ${name}`);
	}
	return new Float32Array(buffer, item.byteOffset, item.length);
}

function toArrayBuffer(data) {
	if (data instanceof ArrayBuffer) {
		return data;
	}
	if (ArrayBuffer.isView(data)) {
		return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
	}
	return new Uint8Array(data).buffer;
}

function sliceFeatureChunk(features, start, length, stats, meta) {
	const regular = new Float32Array(length * meta.regularDim);
	const rich = new Float32Array(length * meta.richDim);
	const hashSlots = new Int32Array(length * meta.hashSlots);
	const charSlots = new Int32Array(length * meta.charSlots);
	const padMask = new Uint8Array(length);
	for (let i = 0; i < length; i++) {
		const src = start + i;
		normalizeSelectedInto(
			regular,
			i * meta.regularDim,
			features.regular,
			src * meta.regularSourceDim,
			stats.regularMean,
			stats.regularStd,
			meta.regularKeepIndices,
		);
		normalizeSelectedInto(
			rich,
			i * meta.richDim,
			features.rich,
			src * meta.richSourceDim,
			stats.richMean,
			stats.richStd,
			meta.richKeepIndices,
		);
		copySelected(hashSlots, i * meta.hashSlots, features.hashSlots, src * (features.hashSlotsDim || meta.hashSourceSlots), meta.hashSlotKeepIndices);
		copySelected(charSlots, i * meta.charSlots, features.charSlots, src * (features.charSlotsDim || meta.charSourceSlots), meta.charSlotKeepIndices);
	}
	return { regular, rich, hashSlots, charSlots, padMask };
}

function normalizeSelectedInto(out, outOffset, source, sourceOffset, mean, std, indices) {
	for (let i = 0; i < indices.length; i++) {
		const sourceIndex = sourceOffset + indices[i];
		out[outOffset + i] = (source[sourceIndex] - mean[i]) / std[i];
	}
}

function copySelected(out, outOffset, source, sourceOffset, indices) {
	for (let i = 0; i < indices.length; i++) {
		out[outOffset + i] = source[sourceOffset + indices[i]] || 0;
	}
}

function toBigInt64Array(values) {
	const out = new BigInt64Array(values.length);
	for (let i = 0; i < values.length; i++) {
		out[i] = BigInt(values[i]);
	}
	return out;
}

function argmax(values, offset, length) {
	let index = 0;
	let best = -Infinity;
	for (let i = 0; i < length; i++) {
		const value = values[offset + i];
		if (value > best) {
			best = value;
			index = i;
		}
	}
	return index;
}

function normalizeMetadata(meta) {
	const requiredArrays = [
		'inputs',
		'typeNames',
		'flowNames',
		'regularKeepIndices',
		'richKeepIndices',
	];
	for (const key of requiredArrays) {
		if (!Array.isArray(meta[key]) || !meta[key].length) {
			throw new Error(`Invalid block classifier metadata: missing ${key}`);
		}
	}

	const normalized = {
		...meta,
		inputNames: new Set(meta.inputs),
		maxBlocks: Number(meta.maxBlocks),
		regularDim: Number(meta.regularDim),
		richDim: Number(meta.richDim),
		regularSourceDim: Number(meta.regularSourceDim),
		richSourceDim: Number(meta.richSourceDim),
		hashSlots: Number(meta.hashSlots),
		hashSourceSlots: Number(meta.hashSourceSlots ?? meta.hashSlots),
		hashSlotKeepIndices: meta.hashSlotKeepIndices || range(meta.hashSlots),
		charSlots: Number(meta.charSlots),
		charSourceSlots: Number(meta.charSourceSlots ?? meta.charSlots),
		charSlotKeepIndices: meta.charSlotKeepIndices || range(meta.charSlots),
	};
	if (![
		normalized.maxBlocks,
		normalized.regularDim,
		normalized.richDim,
		normalized.regularSourceDim,
		normalized.richSourceDim,
		normalized.hashSlots,
		normalized.hashSourceSlots,
		normalized.charSlots,
		normalized.charSourceSlots,
	].every(Number.isFinite)) {
		throw new Error('Invalid block classifier metadata dimensions');
	}
	return normalized;
}

function addFeed(ort, feeds, meta, name, type, data, dims) {
	if (meta.inputNames.has(name)) {
		feeds[name] = new ort.Tensor(type, data, dims);
	}
}

function range(length) {
	return Array.from({ length }, (_, i) => i);
}

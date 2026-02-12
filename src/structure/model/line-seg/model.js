import { onnxMutex, getRuntime } from '../onnx/runtime.js';

const isNode =
	typeof process !== 'undefined' &&
	!!process.versions?.node &&
	typeof window === 'undefined';

let ort = null;
let model = null;

async function getModelCRFJSON() {
	if (isNode) {
		const { readFile } = await import(/* webpackIgnore: true */ 'node:fs/promises');
		const { fileURLToPath } = await import(/* webpackIgnore: true */ 'node:url');
		const path = fileURLToPath(new URL('./model.crf.json', import.meta.url));
		const text = await readFile(path, 'utf8');
		return JSON.parse(text);
	}
	const url = new URL('./model.crf.json', import.meta.url).toString();
	const res = await fetch(url, { cache: 'no-cache' });
	if (!res.ok) {
		throw new Error(`Failed to fetch model (${res.status} ${res.statusText})`);
	}
	return await res.json();
}

async function getModelBuf() {
	if (isNode) {
		const { readFile } = await import(/* webpackIgnore: true */ 'node:fs/promises');
		const { fileURLToPath } = await import(/* webpackIgnore: true */ 'node:url');
		const path = fileURLToPath(new URL('./model.onnx', import.meta.url));
		const buf = await readFile(path);
		// Return a standalone ArrayBuffer view over the file contents
		return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
	}
	// Webpack inlines the asset into a data: URL at build time.
	const url = new URL('./model.onnx', import.meta.url).toString();
	// Convert using fetch() which supports data: URLs and returns ArrayBuffer efficiently
	return fetch(url, { cache: 'no-cache' }).then((r) => {
		if (!r.ok) throw new Error(`Failed to load embedded model (${r.status} ${r.statusText})`);
		return r.arrayBuffer();
	});
}

export async function initModel(onnxRuntimeProvider) {
	ort = await getRuntime(onnxRuntimeProvider);
	return await onnxMutex.runExclusive(async () => {
		if (!model) {
			const modelBuf = await getModelBuf();
			const crfJSON = await getModelCRFJSON();
			model = await loadModel(modelBuf, crfJSON);
		}
		return model;
	});
}

function formatBytes(bytes) {
	const mb = bytes / (1024 * 1024);
	return `${mb.toFixed(2)} MB`;
}

async function logMemory(label, extra = {}) {
	try {
		if (typeof performance.measureUserAgentSpecificMemory === 'function') {
			// Most detailed (Chromium-based, gated behind a flag in some versions)
			const report = await performance.measureUserAgentSpecificMemory();
			const total = report.bytes ?? 0;
			console.log(`[mem] ${label}: UA-specific total=${formatBytes(total)}`, { report, ...extra });
			return;
		}
	} catch {
		// ignore
	}
	const pm = performance && performance.memory;
	if (pm && typeof pm.usedJSHeapSize === 'number') {
		console.log(
			`[mem] ${label}: usedJSHeap=${formatBytes(pm.usedJSHeapSize)} / totalJSHeap=${formatBytes(pm.totalJSHeapSize)} / jsHeapLimit=${formatBytes(pm.jsHeapSizeLimit)}`,
			extra,
		);
		return;
	}
	// Fallback: no platform memory APIs; log only what we know
	console.log(`[mem] ${label}`, extra);
}

// ------------ Config ------------
/**
 * Number of features per line.
 *
 * Updated to match the Python model:
 * NUM_LINE_FEATURES = 21 (18 base + 3 word hashes)
 *
 * Layout per line:
 * [x1, y1, x2, y2,
 *  width, height, area, char_area_ratio, uppercase_ratio,
 *  first_char_cat, last_char_cat,
 *  some_font_to_prev_ratio, deltaXToPrev, deltaYToPrev,
 *  has_caption_label, bold_italic_ratio,
 *  extra_cat1_binary, extra_cat2_quaternary,
 *  first_word_hash1, first_word_hash2, first_word_hash3]
 */
const NUM_FEATURES = 21;

// Optional: fix wasm file hosting path if needed
// ort.env.wasm.wasmPaths = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.18.0/dist/";

// ------------ Internal helpers ------------
function softmax(vec) {
	const m = Math.max(...vec);
	const exps = vec.map((v) => Math.exp(v - m));
	const s = exps.reduce((a, b) => a + b, 0);
	return exps.map((v) => v / s);
}

function argmax(vec) {
	let imax = 0;
	let vmax = -Infinity;
	for (let i = 0; i < vec.length; i++) {
		if (vec[i] > vmax) {
			vmax = vec[i];
			imax = i;
		}
	}
	return imax;
}

function padOrTruncateLines(lines, T) {
	const padded = new Array(T);
	const n = Math.min(lines.length, T);
	for (let i = 0; i < n; i++) {
		const row = lines[i];
		if (!Array.isArray(row) || row.length !== NUM_FEATURES) {
			throw new Error(`Line ${i} must be an array of length ${NUM_FEATURES}`);
		}
		padded[i] = row;
	}
	const zeroRow = Array(NUM_FEATURES).fill(0);
	for (let i = n; i < T; i++) padded[i] = zeroRow.slice();
	return { padded, validCount: n };
}

function buildMask(B, T, validCounts) {
	// bool mask for the ONNX model: true (1) where padded, false (0) where valid.
	// Matches Python forward(mask): mask is padding mask (True for padded positions).
	const mask = new Uint8Array(B * T);
	let k = 0;
	for (let b = 0; b < B; b++) {
		const n = validCounts[b];
		for (let t = 0; t < T; t++) mask[k++] = t >= n ? 1 : 0;
	}
	return mask;
}

function flattenFeatures(batched, B, T) {
	const a = new Float32Array(B * T * NUM_FEATURES);
	let k = 0;
	for (let b = 0; b < B; b++) {
		for (let t = 0; t < T; t++) {
			const row = batched[b][t];
			for (let j = 0; j < NUM_FEATURES; j++) a[k++] = row[j];
		}
	}
	return a;
}

/**
 * Default class-to-type mapping.
 *
 * Python label structure summary:
 * - Base types: 0..9 (10 total base types)
 * - With continuation: base 0..7 => START: base, CONT: base + 10
 * - Singleton-only: base 8..9 => SINGLE labels are 8 and 9
 * - Total classes: 18 (0..17)
 *
 * For most consumers, you want the "base type" as the output "type".
 * So we map:
 *   0..9   -> 0..9
 *   10..17 -> 0..7 (subtract 10)
 */
const DEFAULT_CLASS_TO_TYPE = (() => {
	const m = {};
	const TOTAL_BASE_TYPES = 10;
	const NUM_CLASSES = 18;
	for (let cls = 0; cls < NUM_CLASSES; cls++) {
		m[cls] = cls < TOTAL_BASE_TYPES ? cls : cls - TOTAL_BASE_TYPES;
	}
	return m;
})();

// ------------ CRF runtime (Viterbi) ------------
function viterbiDecodeBatch(emissions, B, T, C, validCounts, crfParams) {
	// emissions: Float32Array length B*T*C, layout [b,t,c]
	// validCounts: number of valid tokens in each sequence
	// crfParams: { transitions [C*C], start [C], end [C] }
	const { transitions, start, end } = crfParams;

	const paths = new Array(B);
	const score = new Float32Array(C);
	const prevScore = new Float32Array(C);

	for (let b = 0; b < B; b++) {
		const n = validCounts[b];
		if (n <= 0) {
			paths[b] = [];
			continue;
		}
		// backpointers size: n * C (int16 is fine for C<=32767; here C is small)
		const backpointers = new Int16Array(n * C);

		// t = 0
		const base0 = (b * T + 0) * C;
		for (let j = 0; j < C; j++) {
			score[j] = start[j] + emissions[base0 + j];
			backpointers[j] = 0; // unused at t=0
		}

		// t = 1..n-1
		for (let t = 1; t < n; t++) {
			for (let j = 0; j < C; j++) prevScore[j] = score[j];
			const base = (b * T + t) * C;

			for (let j = 0; j < C; j++) {
				let bestI = 0;
				let bestVal = prevScore[0] + transitions[0 * C + j];
				for (let i = 1; i < C; i++) {
					const val = prevScore[i] + transitions[i * C + j];
					if (val > bestVal) {
						bestVal = val;
						bestI = i;
					}
				}
				score[j] = bestVal + emissions[base + j];
				backpointers[t * C + j] = bestI;
			}
		}

		// end
		let bestLast = 0;
		let bestLastScore = score[0] + end[0];
		for (let j = 1; j < C; j++) {
			const v = score[j] + end[j];
			if (v > bestLastScore) {
				bestLastScore = v;
				bestLast = j;
			}
		}

		// backtrack
		const seq = new Array(n);
		seq[n - 1] = bestLast;
		for (let t = n - 1; t >= 1; t--) {
			seq[t - 1] = backpointers[t * C + seq[t]];
		}
		paths[b] = seq;
	}

	return paths;
}

function ensureFloat32Flat(arr, expectedLength, name) {
	// Accept:
	// - Float32Array / TypedArray
	// - flat number[]
	// - 2D number[][] (flattened row-major)
	if (arr == null) {
		throw new Error(`CRF ${name} is missing`);
	}

	if (ArrayBuffer.isView(arr) && typeof arr.length === 'number') {
		const out = new Float32Array(arr);
		if (expectedLength != null && out.length !== expectedLength) {
			throw new Error(`CRF ${name} has length ${out.length}, expected ${expectedLength}`);
		}
		return out;
	}

	if (!Array.isArray(arr)) {
		throw new Error(`CRF ${name} must be an array`);
	}

	const first = arr[0];
	if (Array.isArray(first)) {
		const rows = arr.length;
		const cols = first.length;
		for (let r = 0; r < rows; r++) {
			if (!Array.isArray(arr[r]) || arr[r].length !== cols) {
				throw new Error(`CRF ${name} must be a rectangular 2D array [${rows}][${cols}]`);
			}
		}
		const flat = new Float32Array(rows * cols);
		let k = 0;
		for (let r = 0; r < rows; r++) {
			for (let c = 0; c < cols; c++) {
				const v = arr[r][c];
				flat[k++] = Number.isFinite(v) ? v : 0;
			}
		}
		if (expectedLength != null && flat.length !== expectedLength) {
			throw new Error(`CRF ${name} has flattened length ${flat.length}, expected ${expectedLength}`);
		}
		return flat;
	}

	const out = new Float32Array(arr.length);
	for (let i = 0; i < arr.length; i++) {
		const v = arr[i];
		out[i] = Number.isFinite(v) ? v : 0;
	}
	if (expectedLength != null && out.length !== expectedLength) {
		throw new Error(`CRF ${name} has length ${out.length}, expected ${expectedLength}`);
	}
	return out;
}

// ------------ Public API ------------

/**
 * Loads an ONNX model and optional CRF parameters JSON.
 *
 * @param {ArrayBuffer} model - ONNX model bytes
 * @param {Object} crfData - CRF JSON parameters
 * @returns {Promise<{
 *   session: ort.InferenceSession,
 *   io: { featureInputName: string, maskInputName: string, outputName: string },
 *   classToType: Record<number, number>,
 *   crf: null | {
 *     numTags: number,
 *     transitions: Float32Array, // [C*C] row-major i->j
 *     start: Float32Array,       // [C]
 *     end: Float32Array          // [C]
 *   }
 * }>}
 */
export async function loadModel(model, crfData) {
	const session = await ort.InferenceSession.create(model, {
		executionProviders: ['wasm'],
		graphOptimizationLevel: 'all',
	});

	// Derive I/O names from model metadata with safe fallbacks
	const inputs = session.inputNames || [];
	const outputs = session.outputNames || [];
	const inMeta = session.inputMetadata || {};

	let featureInputName = 'line_features';
	let maskInputName = 'pad_mask';
	let outputName = outputs[0] || 'emissions';

	const byRank3 = inputs.find((n) => (inMeta?.[n]?.dimensions?.length === 3));
	const byRank2 = inputs.find((n) => (inMeta?.[n]?.dimensions?.length === 2));
	if (byRank3) featureInputName = byRank3;
	if (byRank2) maskInputName = byRank2;
	if (outputs.length > 0) outputName = outputs[0];

	// Optional: load CRF params JSON
	let crf = null;
	let classToType = { ...DEFAULT_CLASS_TO_TYPE };

	const j = crfData;
	const numBaseTypes = Number(j?.num_base_types ?? j?.numBaseTypes ?? 10);

	// CRF is optional at runtime, but if JSON is present we expect it to be valid.
	const numTags = Number(j?.num_tags ?? j?.numTags);
	if (!Number.isInteger(numTags) || numTags <= 0) {
		throw new Error('CRF JSON missing valid num_tags/numTags');
	}

	const transitions = ensureFloat32Flat(j.transitions, numTags * numTags, 'transitions');
	const start = ensureFloat32Flat(
		j.start_transitions ?? j.start,
		numTags,
		'start_transitions',
	);
	const end = ensureFloat32Flat(j.end_transitions ?? j.end, numTags, 'end_transitions');

	if (j.class_to_type) {
		// Some historical CRF JSONs incorrectly stored an identity mapping of class->class.
		// We normalize to "base type" indices (0..numBaseTypes-1), consistent with training labels:
		// - START/SINGLE classes: 0..numBaseTypes-1
		// - CONT classes: base + numBaseTypes
		const raw = {};
		for (const [k, v] of Object.entries(j.class_to_type)) raw[Number(k)] = Number(v);

		let looksLikeBaseTypeMap = true;
		for (let cls = 0; cls < numTags; cls++) {
			if (!(cls in raw)) continue;
			const v = raw[cls];
			if (!Number.isInteger(v) || v < 0 || v >= numBaseTypes) {
				looksLikeBaseTypeMap = false;
				break;
			}
		}

		if (looksLikeBaseTypeMap) {
			classToType = { ...DEFAULT_CLASS_TO_TYPE, ...raw };
		} else if (j.start_of && typeof j.start_of === 'object') {
			// Prefer explicit start_of mapping when available.
			classToType = { ...DEFAULT_CLASS_TO_TYPE };
			for (let cls = 0; cls < numTags; cls++) {
				const start = j.start_of[String(cls)];
				if (start != null) classToType[cls] = Number(start);
				else if (cls < numBaseTypes) classToType[cls] = cls;
			}
		} else {
			// Fall back to the default START/CONT layout (cls>=numBaseTypes => cls-numBaseTypes).
			classToType = {};
			for (let cls = 0; cls < numTags; cls++) {
				classToType[cls] = cls < numBaseTypes ? cls : cls - numBaseTypes;
			}
		}
	}

	crf = { numTags, transitions, start, end };

	return {
		session,
		io: { featureInputName, maskInputName, outputName },
		classToType,
		crf,
	};
}

/**
 * Runs inference on a batch of records.
 *
 * @param {Object} args
 * @param {ort.InferenceSession} args.session
 * @param {{ featureInputName: string, maskInputName: string, outputName: string }} args.io
 * @param {Record<number, number>} args.classToType
 * @param {{ lines: number[][] }[]} args.records - Array of records; each record has a "lines" array (NUM_FEATURES features per line)
 * @param {{ T: number }} args.shape - Sequence length (max tokens per sequence)
 * @param {{ numTags:number, transitions:Float32Array, start:Float32Array, end:Float32Array }=} args.crf - Optional CRF params to use Viterbi decoding
 * @returns {Promise<{
 *   predictions: Array<Array<{ t: number, class: number, type: number, confidence: number }>>,
 *   logitsShape: [number, number, number]
 * }>}
 */
export async function runInference({ session, io, classToType, records, shape: { T }, crf = null }) {
	if (!session) throw new Error('Session is required.');
	if (!io) throw new Error('I/O names are required.');
	if (!Array.isArray(records) || records.length === 0) {
		throw new Error('records must be a non-empty array.');
	}
	if (!Number.isInteger(T) || T <= 0) throw new Error('shape.T must be a positive integer.');

	const B = records.length;

	// await logMemory("before build batch", { B, T });

	// Build batch
	const batched = new Array(B);
	const validCounts = new Array(B);
	for (let b = 0; b < B; b++) {
		const rec = records[b];
		if (!rec || !Array.isArray(rec.lines)) {
			throw new Error(`records[${b}] must contain a "lines" array.`);
		}
		const { padded, validCount } = padOrTruncateLines(rec.lines, T);
		batched[b] = padded;
		validCounts[b] = validCount;
	}

	const features = flattenFeatures(batched, B, T);
	const padMask = buildMask(B, T, validCounts); // bool mask: 1 for padded, 0 for valid

	// Known allocations (input tensors)
	const inputBytes = features.byteLength + padMask.byteLength;
	void inputBytes; // keep for optional debugging

	// await logMemory("after input build");

	const feeds = {};
	feeds[io.featureInputName] = new ort.Tensor('float32', features, [B, T, NUM_FEATURES]);
	feeds[io.maskInputName] = new ort.Tensor('bool', padMask, [B, T]);

	const t0 = performance.now();
	const results = await session.run(feeds);
	const dt = performance.now() - t0;
	void dt; // keep for optional debugging

	const out = results[io.outputName];
	if (!out) throw new Error(`Output ${io.outputName} not found.`);

	const dims = out.dims; // expected [B, T, C]
	if (dims.length !== 3 || dims[0] !== B || dims[1] !== T) {
		throw new Error(`Unexpected output shape ${dims.join('x')} (expected ${B}x${T}xC).`);
	}

	const C = dims[2];
	const emissions = out.data; // Float32Array length B*T*C

	let decodedPaths = null;
	if (crf) {
		if (crf.numTags !== C) {
			throw new Error(`CRF numTags (${crf.numTags}) != emissions classes (${C})`);
		}
		decodedPaths = viterbiDecodeBatch(emissions, B, T, C, validCounts, {
			transitions: crf.transitions,
			start: crf.start,
			end: crf.end,
		});
	}

	// Convert to predictions on valid tokens only
	const predictions = [];
	let k = 0; // index into emissions for the non-CRF path
	for (let b = 0; b < B; b++) {
		const seq = [];
		const n = validCounts[b];

		if (crf && decodedPaths) {
			// Use CRF-decoded classes
			const path = decodedPaths[b];
			for (let t = 0; t < n; t++) {
				const v = new Array(C);
				const base = (b * T + t) * C;
				for (let c = 0; c < C; c++) v[c] = emissions[base + c];
				const probs = softmax(v);
				const cls = path[t];
				seq.push({
					t,
					class: cls,
					type: (classToType?.[cls] ?? DEFAULT_CLASS_TO_TYPE[cls]),
					confidence: Number(((probs[cls] ?? 0)).toFixed(4)),
				});
			}
			// Advance k to skip entire sequence (we used direct indexing above)
			k += T * C;
		} else {
			// Fallback: per-token argmax on emissions (no CRF)
			for (let t = 0; t < n; t++) {
				const v = new Array(C);
				for (let c = 0; c < C; c++) v[c] = emissions[k++];
				const probs = softmax(v);
				const cls = argmax(v);
				seq.push({
					t,
					class: cls,
					type: (classToType?.[cls] ?? DEFAULT_CLASS_TO_TYPE[cls]),
					confidence: Number(probs[cls].toFixed(4)),
				});
			}
			// Skip remaining padded tokens' emissions
			k += (T - n) * C;
		}

		predictions.push(seq);
	}

	return {
		predictions,
		logitsShape: [B, T, C],
	};
}

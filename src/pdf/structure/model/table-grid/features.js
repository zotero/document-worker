export const NODE_FEATURE_DIM = 32;
export const EDGE_FEATURE_DIM = 32;
const DEFAULT_K = 24;
const DEFAULT_MAX_ATOMS = 1536;

const PUNCTUATION = new Set(
	Array.from(
		'!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~' + '•·–—−()[]{}.,:;!?/\\|$€£¥%',
	),
);
const TEXT_ANALYSIS_CACHE_LIMIT = 50000;
const textAnalysisCache = new Map();

export function safeFloat(value, fallback = 0) {
	const out = Number(value);
	return Number.isFinite(out) ? out : fallback;
}

export function normalizeBbox(raw) {
	const values =
		Array.isArray(raw) || ArrayBuffer.isView(raw) ? raw : [0, 0, 0, 0];
	let x0 = safeFloat(values[0]);
	let y0 = safeFloat(values[1]);
	let x1 = safeFloat(values[2]);
	let y1 = safeFloat(values[3]);
	if (x1 < x0) [x0, x1] = [x1, x0];
	if (y1 < y0) [y0, y1] = [y1, y0];
	return [x0, y0, x1, y1];
}

function textChars(text) {
	return Array.from(String(text || ''));
}

function analyzeText(text) {
	text = String(text ?? '');
	const cached = textAnalysisCache.get(text);
	if (cached) return cached;

	const chars = textChars(text);
	const stripped = text.trim();
	const compact = stripped.replace('.', '').replace(',', '');
	let digit = 0;
	let alpha = 0;
	let upper = 0;
	let lower = 0;
	let punct = 0;
	let script = 0;
	for (const ch of chars) {
		if (/\p{Nd}/u.test(ch)) digit += 1;
		if (/\p{Alphabetic}/u.test(ch)) alpha += 1;
		if (/\p{Uppercase}/u.test(ch)) upper += 1;
		if (/\p{Lowercase}/u.test(ch)) lower += 1;
		if (PUNCTUATION.has(ch)) punct += 1;
		if (script === 0) {
			const cp = ch.codePointAt(0) || 0;
			if (cp >= 0x0400 && cp <= 0x052f) script = 1;
			else if (cp >= 0x0370 && cp <= 0x03ff) script = 2;
			else if (cp >= 0x0590 && cp <= 0x08ff) script = 3;
			else if ((cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf))
				script = 4;
			else if (cp >= 0x3040 && cp <= 0x30ff) script = 5;
			else if ((cp >= 0x0e00 && cp <= 0x0eff) || (cp >= 0x1780 && cp <= 0x17ff))
				script = 6;
			else if (cp >= 0x0900 && cp <= 0x0d7f) script = 7;
			else if ((cp >= 0x2200 && cp <= 0x22ff) || (cp >= 0x2190 && cp <= 0x21ff))
				script = 8;
		}
	}
	if (!chars.length) {
		const empty = {
			chars,
			frac: { digit: 0, alpha: 0, upper: 0, lower: 0, punct: 0 },
			script: 0,
			isNum: 0,
			punctOnly: 0,
			startsBullet: 0,
			endsHyphen: 0,
		};
		textAnalysisCache.set(text, empty);
		return empty;
	}
	const count = Math.max(1, chars.length);
	const frac = {
		digit: digit / count,
		alpha: alpha / count,
		upper: upper / count,
		lower: lower / count,
		punct: punct / count,
	};
	const result = {
		chars,
		frac,
		script,
		isNum: compact.length > 0 && /^\p{Nd}+$/u.test(compact) ? 1 : 0,
		punctOnly: text && frac.punct > 0.8 ? 1 : 0,
		startsBullet: ['•', '·', '-', '–', '—', '*'].includes(stripped.slice(0, 1))
			? 1
			: 0,
		endsHyphen:
			stripped.endsWith('-') || stripped.endsWith('‐') || stripped.endsWith('‑')
				? 1
				: 0,
	};
	if (textAnalysisCache.size >= TEXT_ANALYSIS_CACHE_LIMIT) {
		textAnalysisCache.clear();
	}
	textAnalysisCache.set(text, result);
	return result;
}

function baselineY(atom, fallback) {
	const baseline = atom?.baseline;
	if (
		(Array.isArray(baseline) || ArrayBuffer.isView(baseline)) &&
		baseline.length >= 4
	) {
		return 0.5 * (safeFloat(baseline[1]) + safeFloat(baseline[3]));
	}
	return fallback;
}

function baselineAngle(atom) {
	const baseline = atom?.baseline;
	if (
		(Array.isArray(baseline) || ArrayBuffer.isView(baseline)) &&
		baseline.length >= 4
	) {
		const bx0 = safeFloat(baseline[0]);
		const by0 = safeFloat(baseline[1]);
		const bx1 = safeFloat(baseline[2]);
		const by1 = safeFloat(baseline[3]);
		return Math.atan2(by1 - by0, Math.max(1e-6, bx1 - bx0));
	}
	return 0;
}

function writeAtomNodeFeatures(
	out,
	offset,
	atom,
	pageW,
	pageH,
	localSparseScore = 0,
) {
	const [x0, y0, x1, y1] = normalizeBbox(atom?.bbox);
	const w = Math.max(1e-6, x1 - x0);
	const h = Math.max(1e-6, y1 - y0);
	const cx = x0 + 0.5 * w;
	const cy = y0 + 0.5 * h;
	const text = String(atom?.text ?? '');
	const analysis = analyzeText(text);
	const chars = analysis.chars;
	const frac = analysis.frac;
	const fontSize = safeFloat(atom?.font_size, h);
	const rotation = safeFloat(atom?.rotation, 0);
	const rotRad = (rotation * Math.PI) / 180;
	const slot25 = localSparseScore;
	out.set(
		[
			x0 / pageW,
			y0 / pageH,
			x1 / pageW,
			y1 / pageH,
			cx / pageW,
			cy / pageH,
			w / pageW,
			h / pageH,
			Math.log1p(w / Math.max(h, 1e-6)),
			(w * h) / Math.max(pageW * pageH, 1e-6),
			baselineY(atom, y1) / pageH,
			baselineAngle(atom) / Math.PI,
			Math.sin(rotRad),
			Math.cos(rotRad),
			fontSize / Math.max(pageH, 1e-6),
			Math.log1p(Math.max(fontSize, 0)) / 10,
			Math.min(chars.length, 64) / 64,
			frac.digit,
			frac.alpha,
			frac.upper,
			frac.lower,
			frac.punct,
			String(atom?.direction ?? 'ltr').toLowerCase() === 'rtl' ? 1 : 0,
			atom?.bold ? 1 : 0,
			atom?.italic ? 1 : 0,
			slot25,
			Math.log1p(chars.length) / 8,
			analysis.isNum,
			analysis.punctOnly,
			analysis.startsBullet,
			analysis.endsHyphen,
			analysis.script / 8,
		],
		offset,
	);
}

function writePairEdgeFeatures(
	out,
	offset,
	a,
	b,
	pageW,
	pageH,
	sourceRank = 1,
	reverseRank = 1,
	mutualCandidate = 0,
) {
	const [ax0, ay0, ax1, ay1] = normalizeBbox(a?.bbox);
	const [bx0, by0, bx1, by1] = normalizeBbox(b?.bbox);
	const aw = Math.max(1e-6, ax1 - ax0);
	const ah = Math.max(1e-6, ay1 - ay0);
	const bw = Math.max(1e-6, bx1 - bx0);
	const bh = Math.max(1e-6, by1 - by0);
	const acx = ax0 + 0.5 * aw;
	const acy = ay0 + 0.5 * ah;
	const bcx = bx0 + 0.5 * bw;
	const bcy = by0 + 0.5 * bh;
	const avgH = Math.max(1e-6, 0.5 * (ah + bh));
	const dx = bcx - acx;
	const dy = bcy - acy;
	const dist = Math.sqrt(dx * dx + dy * dy);
	const xOverlap =
		Math.max(0, Math.min(ax1, bx1) - Math.max(ax0, bx0)) /
		Math.max(1e-6, Math.min(aw, bw));
	const yOverlap =
		Math.max(0, Math.min(ay1, by1) - Math.max(ay0, by0)) /
		Math.max(1e-6, Math.min(ah, bh));
	const afs = safeFloat(a?.font_size, ah);
	const bfs = safeFloat(b?.font_size, bh);
	const aby = baselineY(a, ay1);
	const bby = baselineY(b, by1);
	const fontSame =
		String(a?.font_id ?? '') === String(b?.font_id ?? '') ? 1 : 0;
	const colorSame = String(a?.color ?? '') === String(b?.color ?? '') ? 1 : 0;
	const styleSame =
		Boolean(a?.bold) === Boolean(b?.bold) &&
		Boolean(a?.italic) === Boolean(b?.italic)
			? 1
			: 0;
	const scriptSame =
		analyzeText(a?.text).script === analyzeText(b?.text).script ? 1 : 0;
	const dirSame =
		String(a?.direction ?? 'ltr').toLowerCase() ===
		String(b?.direction ?? 'ltr').toLowerCase()
			? 1
			: 0;
	const hGap = bcx >= acx ? Math.max(0, bx0 - ax1) : Math.max(0, ax0 - bx1);
	const vGap = bcy >= acy ? Math.max(0, by0 - ay1) : Math.max(0, ay0 - by1);
	const leftAlign = Math.abs(ax0 - bx0) / avgH;
	const rightAlign = Math.abs(ax1 - bx1) / avgH;
	const sameRowish = yOverlap > 0.25 || Math.abs(dy) / avgH < 0.75 ? 1 : 0;
	const sameColish = xOverlap > 0.25 || Math.abs(dx) / avgH < 1.5 ? 1 : 0;
	const slot17 = Math.min(leftAlign, 8) / 8;
	const slot18 = Math.min(rightAlign, 8) / 8;
	const slot27 = sameRowish;
	const slot28 = sameColish;
	const slot29 = sourceRank;
	const slot30 = reverseRank;
	const slot31 = mutualCandidate;
	const slot23 = scriptSame;
	const slot24 = dirSame;
	out.set(
		[
			dx / pageW,
			dy / pageH,
			Math.abs(dx) / pageW,
			Math.abs(dy) / pageH,
			dist / Math.max(pageW, pageH),
			dx / avgH,
			dy / avgH,
			dist / avgH,
			xOverlap,
			yOverlap,
			Math.abs(bby - aby) / avgH,
			Math.log(Math.max(ah / bh, 1e-6)),
			Math.log(Math.max(aw / bw, 1e-6)),
			Math.log(Math.max(afs / Math.max(bfs, 1e-6), 1e-6)),
			fontSame,
			colorSame,
			styleSame,
			slot17,
			slot18,
			dx > 0 ? 1 : 0,
			dx < 0 ? 1 : 0,
			dy < 0 ? 1 : 0,
			dy > 0 ? 1 : 0,
			slot23,
			slot24,
			hGap / avgH,
			vGap / avgH,
			slot27,
			slot28,
			slot29,
			slot30,
			slot31,
		],
		offset,
	);
}

function topCandidatesForSource(source, n, take, scoreAt) {
	const selected = [];
	let worstIndex = -1;
	let worstScore = -Infinity;
	for (let target = 0; target < n; target += 1) {
		if (target === source) continue;
		const score = scoreAt(target);
		if (selected.length < take) {
			selected.push({ target, score });
			if (score > worstScore) {
				worstScore = score;
				worstIndex = selected.length - 1;
			}
			continue;
		}
		if (score < worstScore) {
			selected[worstIndex] = { target, score };
			worstScore = -Infinity;
			worstIndex = -1;
			for (let i = 0; i < selected.length; i += 1) {
				if (selected[i].score > worstScore) {
					worstScore = selected[i].score;
					worstIndex = i;
				}
			}
		}
	}
	return selected;
}

function buildCandidateGraph(atoms, pageW, pageH, k = DEFAULT_K) {
	const n = atoms.length;
	const edgeIndex = new Int32Array(n * k);
	const edgeMask = new Float32Array(n * k);
	if (n <= 1) {
		return { edgeIndex, edgeMask };
	}

	const centersX = new Float32Array(n);
	const centersY = new Float32Array(n);
	const sizesH = new Float32Array(n);
	const drawOrders = new Float32Array(n);
	for (let index = 0; index < n; index += 1) {
		const [x0, y0, x1, y1] = normalizeBbox(atoms[index]?.bbox);
		centersX[index] = (x0 + x1) * 0.5;
		centersY[index] = (y0 + y1) * 0.5;
		sizesH[index] = Math.max(1, y1 - y0);
		drawOrders[index] = safeFloat(atoms[index]?.draw_order, index);
	}

	let drawMin = Infinity;
	let drawMax = -Infinity;
	for (const value of drawOrders) {
		drawMin = Math.min(drawMin, value);
		drawMax = Math.max(drawMax, value);
	}
	const hasDrawOrderSignal = drawMax - drawMin > 1e-6;
	let drawRank = [];
	let posInRank = new Int32Array(n);
	if (hasDrawOrderSignal) {
		drawRank = Array.from({ length: n }, (_, index) => index).sort(
			(a, b) => drawOrders[a] - drawOrders[b],
		);
		posInRank = new Int32Array(n);
		drawRank.forEach((index, pos) => {
			posInRank[index] = pos;
		});
	}

	const spatialTake = Math.min(Math.max(k * 2, k), n - 1);
	const scoreAt = (source, target) => {
		const dx = (centersX[source] - centersX[target]) / Math.max(1, pageW);
		const dy = (centersY[source] - centersY[target]) / Math.max(1, pageH);
		const sameishYBonus =
			Math.abs(dy) <
			Math.max(sizesH[source], sizesH[target]) / Math.max(1, pageH)
				? 0.05
				: 0;
		return dx * dx + dy * dy - sameishYBonus;
	};

	for (let source = 0; source < n; source += 1) {
		const candidates = topCandidatesForSource(
			source,
			n,
			spatialTake,
			(target) => scoreAt(source, target),
		).map((entry) => entry.target);
		if (hasDrawOrderSignal) {
			const drawPos = posInRank[source];
			for (const nearby of [
				drawPos - 2,
				drawPos - 1,
				drawPos + 1,
				drawPos + 2,
			]) {
				if (nearby >= 0 && nearby < n) {
					const candidate = drawRank[nearby];
					if (candidate !== source) candidates.push(candidate);
				}
			}
		}

		const seen = new Set();
		let selected = [];
		for (const candidate of candidates) {
			if (candidate !== source && !seen.has(candidate)) {
				selected.push(candidate);
				seen.add(candidate);
			}
		}
		selected.sort((a, b) => {
			const delta = scoreAt(source, a) - scoreAt(source, b);
			return delta || a - b;
		});
		selected = selected.slice(0, k);
		for (let slot = 0; slot < selected.length; slot += 1) {
			edgeIndex[source * k + slot] = selected[slot];
			edgeMask[source * k + slot] = 1;
		}
	}
	return { edgeIndex, edgeMask };
}

function localSparseScores(
	atoms,
	edgeIndex,
	edgeMask,
	pageW,
	pageH,
	k = DEFAULT_K,
) {
	const n = atoms.length;
	const out = new Float32Array(n);
	if (n <= 1) return out;
	const centersX = new Float32Array(n);
	const centersY = new Float32Array(n);
	const heights = new Float32Array(n);
	for (let index = 0; index < n; index += 1) {
		const [x0, y0, x1, y1] = normalizeBbox(atoms[index]?.bbox);
		centersX[index] = (x0 + x1) * 0.5;
		centersY[index] = (y0 + y1) * 0.5;
		heights[index] = Math.max(1, y1 - y0);
	}
	for (let source = 0; source < n; source += 1) {
		const distances = [];
		for (let slot = 0; slot < k; slot += 1) {
			const flat = source * k + slot;
			if (edgeMask[flat] <= 0) continue;
			const target = edgeIndex[flat];
			if (target < 0 || target >= n) continue;
			const dx = centersX[target] - centersX[source];
			const dy = centersY[target] - centersY[source];
			const avgH = Math.max(1, 0.5 * (heights[source] + heights[target]));
			distances.push(Math.sqrt(dx * dx + dy * dy) / avgH);
		}
		if (distances.length) {
			distances.sort((a, b) => a - b);
			const take = Math.min(8, distances.length);
			let sum = 0;
			for (let index = 0; index < take; index += 1) sum += distances[index];
			out[source] = Math.min(sum / take, 16) / 16;
		}
	}
	return out;
}

function candidateRankFeatures(edgeIndex, edgeMask, n, k = DEFAULT_K) {
	const denom = Math.max(1, k - 1);
	const reverseLookup = new Map();
	for (let source = 0; source < n; source += 1) {
		for (let slot = 0; slot < k; slot += 1) {
			const flat = source * k + slot;
			if (edgeMask[flat] > 0)
				reverseLookup.set(source * n + edgeIndex[flat], slot);
		}
	}
	const sourceRank = new Float32Array(n * k);
	const reverseRank = new Float32Array(n * k);
	const mutual = new Float32Array(n * k);
	reverseRank.fill(1);
	sourceRank.fill(1);
	for (let source = 0; source < n; source += 1) {
		for (let slot = 0; slot < k; slot += 1) {
			const flat = source * k + slot;
			if (edgeMask[flat] <= 0) continue;
			const target = edgeIndex[flat];
			sourceRank[flat] = slot / denom;
			const reverseSlot = reverseLookup.get(target * n + source);
			if (reverseSlot != null) {
				reverseRank[flat] = reverseSlot / denom;
				mutual[flat] = 1;
			}
		}
	}
	return { sourceRank, reverseRank, mutual };
}

function preparePageAtoms(page) {
	const pageW = Math.max(1, safeFloat(page?.width, 1));
	const pageH = Math.max(1, safeFloat(page?.height, 1));
	let atoms = Array.from(page?.atoms || page?.words || []);
	if (atoms.length > DEFAULT_MAX_ATOMS) {
		atoms = atoms
			.slice()
			.sort((a, b) => {
				const ab = normalizeBbox(a?.bbox);
				const bb = normalizeBbox(b?.bbox);
				return ab[1] - bb[1] || ab[0] - bb[0];
			})
			.slice(0, DEFAULT_MAX_ATOMS);
	}
	return { pageW, pageH, atoms };
}

export function buildPageFeatureArrays(page) {
	const k = DEFAULT_K;
	const { pageW, pageH, atoms } = preparePageAtoms(page);
	const n = atoms.length;
	const { edgeIndex, edgeMask } = buildCandidateGraph(atoms, pageW, pageH, k);
	const sparseScores = localSparseScores(
		atoms,
		edgeIndex,
		edgeMask,
		pageW,
		pageH,
		k,
	);
	const { sourceRank, reverseRank, mutual } = candidateRankFeatures(
		edgeIndex,
		edgeMask,
		n,
		k,
	);
	const nodeFeats = new Float32Array(n * NODE_FEATURE_DIM);
	const edgeFeats = new Float32Array(n * k * EDGE_FEATURE_DIM);
	const nodeMask = new Float32Array(n);

	for (let index = 0; index < n; index += 1) {
		writeAtomNodeFeatures(
			nodeFeats,
			index * NODE_FEATURE_DIM,
			atoms[index],
			pageW,
			pageH,
			sparseScores[index],
		);
		nodeMask[index] = 1;
	}

	for (let source = 0; source < n; source += 1) {
		for (let slot = 0; slot < k; slot += 1) {
			const flat = source * k + slot;
			if (edgeMask[flat] <= 0) continue;
			const target = edgeIndex[flat];
			writePairEdgeFeatures(
				edgeFeats,
				flat * EDGE_FEATURE_DIM,
				atoms[source],
				atoms[target],
				pageW,
				pageH,
				sourceRank[flat],
				reverseRank[flat],
				mutual[flat],
			);
		}
	}

	return {
		pageW,
		pageH,
		atoms,
		n,
		k,
		nodeFeats,
		edgeIndex,
		edgeFeats,
		nodeMask,
		edgeMask,
	};
}

export function createOnnxFeatureArrays(features) {
	const { n, k } = features;
	const edgeIndex = new BigInt64Array(features.edgeIndex.length);
	for (let index = 0; index < features.edgeIndex.length; index += 1) {
		edgeIndex[index] = BigInt(features.edgeIndex[index]);
	}
	return {
		nodeFeats: features.nodeFeats,
		edgeIndex,
		edgeFeats: features.edgeFeats,
		nodeMask: features.nodeMask,
		edgeMask: features.edgeMask,
		n,
		k,
	};
}

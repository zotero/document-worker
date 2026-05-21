import { normalizeBbox, safeFloat } from './features.js';

class UnionFind {
	constructor(size) {
		this.parent = Array.from({ length: size }, (_, index) => index);
		this.rank = new Array(size).fill(0);
	}

	find(value) {
		while (this.parent[value] !== value) {
			this.parent[value] = this.parent[this.parent[value]];
			value = this.parent[value];
		}
		return value;
	}

	union(left, right) {
		let rootLeft = this.find(left);
		let rootRight = this.find(right);
		if (rootLeft === rootRight) return;
		if (this.rank[rootLeft] < this.rank[rootRight]) {
			[rootLeft, rootRight] = [rootRight, rootLeft];
		}
		this.parent[rootRight] = rootLeft;
		if (this.rank[rootLeft] === this.rank[rootRight]) this.rank[rootLeft] += 1;
	}

	labels() {
		return this.parent.map((_value, index) => this.find(index));
	}
}

function sigmoid(value) {
	return 1 / (1 + Math.exp(-value));
}

export function logitsToScores(logits, actualN, k) {
	const out = new Float32Array(actualN * k);
	for (let index = 0; index < out.length; index += 1) {
		out[index] = sigmoid(logits[index]);
	}
	return out;
}

export function bbox(atom) {
	return normalizeBbox(atom?.bbox);
}

function median(values, fallback = 1) {
	if (!values.length) return fallback;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2
		? sorted[mid]
		: 0.5 * (sorted[mid - 1] + sorted[mid]);
}

function pageStats(atoms) {
	const boxes = atoms.map((atom) => bbox(atom));
	const widths = boxes.map((box) => Math.max(1e-6, box[2] - box[0]));
	const heights = boxes.map((box) => Math.max(1e-6, box[3] - box[1]));
	return {
		medianW: median(widths),
		medianH: median(heights),
		x0: Math.min(0, ...boxes.map((box) => box[0])),
		y0: Math.min(0, ...boxes.map((box) => box[1])),
		x1: Math.max(1, ...boxes.map((box) => box[2])),
		y1: Math.max(1, ...boxes.map((box) => box[3])),
	};
}

export function tableRowAxis(atoms, stats = pageStats(atoms)) {
	const xSpan = Math.max(1, stats.x1 - stats.x0);
	const ySpan = Math.max(1, stats.y1 - stats.y0);
	const pageAspect = ySpan / xSpan;
	const textAspect = stats.medianH / Math.max(1e-6, stats.medianW);
	if (pageAspect >= 3) return 'x';
	if (textAspect >= 1.5 && pageAspect >= 1.5) return 'x';
	return 'y';
}

function targetAxis(atoms, axisKind, stats) {
	const rowAxis = tableRowAxis(atoms, stats);
	if (axisKind === 'row') return rowAxis;
	return rowAxis === 'x' ? 'y' : 'x';
}

function baseClusters(
	record,
	axisScores,
	sameCellScores,
	scoreThreshold,
	cellThreshold,
) {
	const { atoms, edgeIndex, edgeMask, k } = record;
	const uf = new UnionFind(atoms.length);
	for (let source = 0; source < atoms.length; source += 1) {
		for (let slot = 0; slot < k; slot += 1) {
			const flat = source * k + slot;
			if (edgeMask[flat] <= 0.5) continue;
			if (
				axisScores[flat] < scoreThreshold &&
				sameCellScores[flat] < cellThreshold
			)
				continue;
			const target = edgeIndex[flat];
			if (target >= 0 && target < atoms.length && target !== source)
				uf.union(source, target);
		}
	}
	return uf.labels();
}

function segmentClusters(record, baseLabels) {
	const byCluster = new Map();
	baseLabels.forEach((label, index) => {
		if (!byCluster.has(label)) byCluster.set(label, []);
		byCluster.get(label).push(index);
	});
	const segments = [];
	for (const indices of byCluster.values()) {
		const boxes = indices.map((index) => bbox(record.atoms[index]));
		segments.push({
			indices,
			bbox: [
				Math.min(...boxes.map((box) => box[0])),
				Math.min(...boxes.map((box) => box[1])),
				Math.max(...boxes.map((box) => box[2])),
				Math.max(...boxes.map((box) => box[3])),
			],
		});
	}
	return segments;
}

function sortSegments(segments, axis) {
	const lo = axis === 'y' ? 1 : 0;
	const hi = axis === 'y' ? 3 : 2;
	return [...segments].sort(
		(left, right) =>
			0.5 * (left.bbox[lo] + left.bbox[hi]) -
			0.5 * (right.bbox[lo] + right.bbox[hi]),
	);
}

function candidatePairs(
	segments,
	record,
	axis,
	pairRankGap,
	maxCenterDeltaBase,
	stats,
) {
	const base = axis === 'y' ? stats.medianH : stats.medianW;
	const lo = axis === 'y' ? 1 : 0;
	const hi = axis === 'y' ? 3 : 2;
	const centers = segments.map(
		(segment) => 0.5 * (segment.bbox[lo] + segment.bbox[hi]),
	);
	const pairs = [];
	for (let left = 0; left < segments.length; left += 1) {
		for (
			let right = left + 1;
			right < Math.min(segments.length, left + 1 + pairRankGap);
			right += 1
		) {
			if (
				Math.abs(centers[right] - centers[left]) / Math.max(1e-6, base) <=
				maxCenterDeltaBase
			) {
				pairs.push([left, right]);
			}
		}
	}
	return pairs;
}

function writePairFeatures(
	out,
	offset,
	record,
	left,
	right,
	axis,
	axisScores,
	sameCellScores,
	stats,
) {
	const xSpan = Math.max(1, stats.x1 - stats.x0);
	const ySpan = Math.max(1, stats.y1 - stats.y0);
	const base = axis === 'y' ? stats.medianH : stats.medianW;
	const axisSpan = axis === 'y' ? ySpan : xSpan;
	const orthSpan = axis === 'y' ? xSpan : ySpan;

	const [ax0, ay0, ax1, ay1] = left.bbox;
	const [bx0, by0, bx1, by1] = right.bbox;
	const [leftLo, leftHi] = axis === 'y' ? [ay0, ay1] : [ax0, ax1];
	const [rightLo, rightHi] = axis === 'y' ? [by0, by1] : [bx0, bx1];
	const [leftOrthLo, leftOrthHi] = axis === 'y' ? [ax0, ax1] : [ay0, ay1];
	const [rightOrthLo, rightOrthHi] = axis === 'y' ? [bx0, bx1] : [by0, by1];
	const gap = Math.max(0, rightLo - leftHi);
	const centerDelta = 0.5 * (rightLo + rightHi) - 0.5 * (leftLo + leftHi);
	const axisOverlap = Math.max(
		0,
		Math.min(leftHi, rightHi) - Math.max(leftLo, rightLo),
	);
	const orthOverlap = Math.max(
		0,
		Math.min(leftOrthHi, rightOrthHi) - Math.max(leftOrthLo, rightOrthLo),
	);
	const orthUnion =
		Math.max(leftOrthHi, rightOrthHi) - Math.min(leftOrthLo, rightOrthLo);
	const minAxis = Math.max(1e-6, Math.min(leftHi - leftLo, rightHi - rightLo));
	const minOrth = Math.max(
		1e-6,
		Math.min(leftOrthHi - leftOrthLo, rightOrthHi - rightOrthLo),
	);

	const rightIndices = new Set(right.indices);
	const leftIndices = new Set(left.indices);
	const axisValues = [];
	const cellValues = [];
	for (const source of left.indices) {
		for (let slot = 0; slot < record.k; slot += 1) {
			const flat = source * record.k + slot;
			if (
				record.edgeMask[flat] > 0.5 &&
				rightIndices.has(record.edgeIndex[flat])
			) {
				axisValues.push(axisScores[flat]);
				cellValues.push(sameCellScores[flat]);
			}
		}
	}
	for (const source of right.indices) {
		for (let slot = 0; slot < record.k; slot += 1) {
			const flat = source * record.k + slot;
			if (
				record.edgeMask[flat] > 0.5 &&
				leftIndices.has(record.edgeIndex[flat])
			) {
				axisValues.push(axisScores[flat]);
				cellValues.push(sameCellScores[flat]);
			}
		}
	}
	const mean = (values) =>
		values.length
			? values.reduce((sum, value) => sum + value, 0) / values.length
			: 0;
	out.set(
		[
			axis === 'x' ? 1 : 0,
			gap / Math.max(1e-6, base),
			centerDelta / Math.max(1e-6, base),
			gap / axisSpan,
			centerDelta / axisSpan,
			axisOverlap / minAxis,
			orthOverlap / minOrth,
			orthOverlap / Math.max(1e-6, orthUnion),
			orthUnion / orthSpan,
			left.indices.length,
			right.indices.length,
			Math.log1p(left.indices.length),
			Math.log1p(right.indices.length),
			(leftHi - leftLo) / Math.max(1e-6, base),
			(rightHi - rightLo) / Math.max(1e-6, base),
			(leftOrthHi - leftOrthLo) / orthSpan,
			(rightOrthHi - rightOrthLo) / orthSpan,
			stats.medianH / Math.max(1e-6, stats.medianW),
			ySpan / xSpan,
			axisValues.length ? Math.max(...axisValues) : 0,
			mean(axisValues),
			axisValues.length,
			cellValues.length ? Math.max(...cellValues) : 0,
			mean(cellValues),
		],
		offset,
	);
}

export function buildAxisMergeInputs(
	record,
	axisKind,
	axisScores,
	sameCellScores,
	config,
) {
	const stats = pageStats(record.atoms);
	const axis = targetAxis(record.atoms, axisKind, stats);
	const baseLabels = baseClusters(
		record,
		axisScores,
		sameCellScores,
		safeFloat(config?.scoreThreshold, 0.99),
		safeFloat(config?.cellThreshold, 0.98),
	);
	const segments = segmentClusters(record, baseLabels);
	const ordered = sortSegments(segments, axis);
	const pairs = candidatePairs(
		ordered,
		record,
		axis,
		Number(config?.pairRankGap ?? 4),
		safeFloat(config?.maxCenterDeltaBase, 8),
		stats,
	).map(([left, right]) => [ordered[left], ordered[right], axis]);
	const features = new Float32Array(pairs.length * 24);
	for (let index = 0; index < pairs.length; index += 1) {
		const [left, right, pairAxis] = pairs[index];
		writePairFeatures(
			features,
			index * 24,
			record,
			left,
			right,
			pairAxis,
			axisScores,
			sameCellScores,
			stats,
		);
	}
	return { axis, baseLabels, pairs, features };
}

export function mergeAxisLabels(
	record,
	baseLabels,
	pairs,
	probabilities,
	threshold,
) {
	const uf = new UnionFind(record.atoms.length);
	const byBase = new Map();
	baseLabels.forEach((label, index) => {
		if (!byBase.has(label)) byBase.set(label, []);
		byBase.get(label).push(index);
	});
	for (const indices of byBase.values()) {
		for (let index = 1; index < indices.length; index += 1)
			uf.union(indices[0], indices[index]);
	}
	for (let index = 0; index < pairs.length; index += 1) {
		if (probabilities[index] >= threshold) {
			const [left, right] = pairs[index];
			uf.union(left.indices[0], right.indices[0]);
		}
	}
	return uf.labels();
}

export function groupLabels(atoms, labels, axis = 'y') {
	const byLabel = new Map();
	labels.forEach((label, index) => {
		if (!byLabel.has(label)) byLabel.set(label, []);
		byLabel.get(label).push(index);
	});
	const groups = [];
	for (const [label, indices] of byLabel.entries()) {
		const boxes = indices.map((index) => bbox(atoms[index]));
		groups.push({
			label,
			indices,
			bbox: [
				Math.min(...boxes.map((box) => box[0])),
				Math.min(...boxes.map((box) => box[1])),
				Math.max(...boxes.map((box) => box[2])),
				Math.max(...boxes.map((box) => box[3])),
			],
			text: indices
				.map((index) => String(atoms[index]?.text ?? ''))
				.filter(Boolean)
				.join(' '),
		});
	}
	const lo = axis === 'y' ? 1 : 0;
	const hi = axis === 'y' ? 3 : 2;
	groups.sort(
		(left, right) =>
			0.5 * (left.bbox[lo] + left.bbox[hi]) -
			0.5 * (right.bbox[lo] + right.bbox[hi]),
	);
	return groups;
}

export function buildCells(atoms, rowLabels, colLabels) {
	const cells = new Map();
	for (let index = 0; index < atoms.length; index += 1) {
		const key = `${rowLabels[index]}:${colLabels[index]}`;
		if (!cells.has(key))
			cells.set(key, {
				rowLabel: rowLabels[index],
				colLabel: colLabels[index],
				indices: [],
			});
		cells.get(key).indices.push(index);
	}
	return Array.from(cells.values()).map((cell) => {
		const boxes = cell.indices.map((index) => bbox(atoms[index]));
		return {
			...cell,
			bbox: [
				Math.min(...boxes.map((box) => box[0])),
				Math.min(...boxes.map((box) => box[1])),
				Math.max(...boxes.map((box) => box[2])),
				Math.max(...boxes.map((box) => box[3])),
			],
			text: cell.indices
				.map((index) => String(atoms[index]?.text ?? ''))
				.filter(Boolean)
				.join(' '),
		};
	});
}

const HASH_MOD = 32768;
const WORD_HASH_MAX = 32767;
const EXTRA_DIM = 31;
const EXTRA_HASHES = 12;
const REGULAR_DIM = 226;
const RICH_DIM = 422;

function fnv1a32(str) {
	let h = 0x811c9dc5;
	for (let i = 0; i < str.length; i++) {
		h ^= str.charCodeAt(i);
		h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
	}
	return h >>> 0;
}

function hashToBucket(str) {
	return fnv1a32(str) % HASH_MOD;
}

function tokenize(text) {
	const raw = String(text || '').normalize('NFKC').match(/[\p{L}]+|\d+|[()[\]{}.,:;!?'"“”‘’\-–—=+×*/<>≤≥#%@&]/gu) || [];
	return raw.map((token) => {
		const x = token.toLowerCase();
		return /^\d+$/.test(x) ? '<NUM>' : x;
	}).filter(Boolean);
}

function extraHashes(text) {
	const toks = tokenize(text);
	const selected = [
		...toks.slice(0, 8),
		...toks.slice(Math.max(0, toks.length - 4)),
	].slice(0, EXTRA_HASHES);
	const out = Array(EXTRA_HASHES).fill(0);
	for (let i = 0; i < selected.length; i++) {
		out[i] = hashToBucket(selected[i]);
	}
	return out;
}

function median(values) {
	const xs = values.filter(v => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
	if (!xs.length) {
		return 0;
	}
	const mid = Math.floor(xs.length / 2);
	return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

function mean(values) {
	return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

function std(values) {
	if (!values.length) {
		return 0;
	}
	const m = mean(values);
	return Math.sqrt(mean(values.map(v => (v - m) * (v - m))));
}

function clamp01(value) {
	return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function round(value) {
	return Math.round((Number.isFinite(value) ? value : 0) * 1000) / 1000;
}

function fontSizes(line) {
	const chars = Array.isArray(line?.chars) ? line.chars : [];
	return chars.map(ch => Number(ch?.fontSize || 0)).filter(v => Number.isFinite(v) && v > 0);
}

function fontNames(line) {
	const chars = Array.isArray(line?.chars) ? line.chars : [];
	return chars.map(ch => ch?.fontName).filter(Boolean);
}

function lineText(line) {
	if (typeof line?.text === 'string') {
		return line.text;
	}
	if (Array.isArray(line?.words)) {
		return line.words.map(w => w?.text || '').join(' ');
	}
	return '';
}

function lineExtra(line, pageMedianFont) {
	const text = lineText(line);
	const toks = tokenize(text);
	const words = toks.filter(t => /[\p{L}]|<NUM>/u.test(t));
	const chars = Array.from(text);
	const len = chars.length || 1;
	let digits = 0;
	let alpha = 0;
	let upperAlpha = 0;
	let punct = 0;
	let math = 0;
	let brackets = 0;
	for (const ch of chars) {
		if (/\p{Nd}/u.test(ch)) digits++;
		if (/\p{L}/u.test(ch)) {
			alpha++;
			if (ch === ch.toUpperCase() && ch !== ch.toLowerCase()) {
				upperAlpha++;
			}
		}
		if (/\p{P}/u.test(ch)) punct++;
		if (/[=+\-−×*/<>≤≥∑∫√^_]/u.test(ch)) math++;
		if (/[()[\]{}]/u.test(ch)) brackets++;
	}
	const sizes = fontSizes(line);
	const avgFont = mean(sizes);
	const minFont = sizes.length ? Math.min(...sizes) : 0;
	const maxFont = sizes.length ? Math.max(...sizes) : 0;
	const stdFont = std(sizes);
	const denomFont = pageMedianFont || avgFont || 1;
	const fonts = new Set(fontNames(line));
	const startsNumbered = /^\(?\d+(?:[.\u2024]\d+)*\)?[.)\p{Dash}:]/u.test(text) ? 1 : 0;
	const startsRoman = /^\(?[ivxlcdm]+\)?[.)\p{Dash}:]/iu.test(text) ? 1 : 0;
	const startsLettered = /^\(?\p{L}\)?[.)\p{Dash}:]/u.test(text) ? 1 : 0;
	const startsBullet = /^[•·‣◦●○▪▫■□◆◇▶►❖*+]/u.test(text) ? 1 : 0;
	const startsCaptionWord = /^(fig(?:ure)?|table|scheme|plate|algorithm)\b/i.test(text) ? 1 : 0;
	const containsEqWord = /\b(eq|equation)\b/i.test(text) ? 1 : 0;
	const containsRefWord = /\b(references|bibliography)\b/i.test(text) ? 1 : 0;
	const smallCharFrac = sizes.length && avgFont > 0 ? sizes.filter(v => v < avgFont * 0.82).length / sizes.length : 0;
	const bigCharFrac = sizes.length && avgFont > 0 ? sizes.filter(v => v > avgFont * 1.18).length / sizes.length : 0;
	const avgWordLen = words.length ? mean(words.map(w => w.length)) : 0;
	const firstTok = toks[0] || '';
	const lastTok = toks[toks.length - 1] || '';
	return [
		clamp01(chars.length / 220),
		clamp01(toks.length / 60),
		clamp01(words.length / 60),
		clamp01(avgWordLen / 18),
		digits / len,
		alpha / len,
		upperAlpha / Math.max(alpha, 1),
		punct / len,
		math / len,
		brackets / len,
		/^[\p{Nd}]/u.test(text) ? 1 : 0,
		/^[\p{Ll}]/u.test(text) ? 1 : 0,
		/^[\p{Lu}]/u.test(text) ? 1 : 0,
		startsNumbered,
		startsRoman,
		startsLettered,
		startsBullet,
		startsCaptionWord,
		containsEqWord,
		containsRefWord,
		/[.!?;:]$/u.test(text) ? 1 : 0,
		/\p{Dash}$/u.test(text) ? 1 : 0,
		clamp01(avgFont / denomFont / 2),
		clamp01(minFont / denomFont / 2),
		clamp01(maxFont / denomFont / 2),
		clamp01(stdFont / denomFont),
		clamp01(fonts.size / 8),
		smallCharFrac,
		bigCharFrac,
		firstTok === '<NUM>' ? 1 : 0,
		lastTok === '<NUM>' ? 1 : 0,
	].map(round);
}

function blockGeometry(rows) {
	let x1 = Infinity;
	let y1 = Infinity;
	let x2 = -Infinity;
	let y2 = -Infinity;
	for (const row of rows) {
		x1 = Math.min(x1, row[0]);
		y1 = Math.min(y1, row[1]);
		x2 = Math.max(x2, row[2]);
		y2 = Math.max(y2, row[3]);
	}
	if (!rows.length) {
		x1 = y1 = x2 = y2 = 0;
	}
	const w = Math.abs(x2 - x1);
	const h = Math.abs(y2 - y1);
	const cx = 0.5 * (x1 + x2);
	const cy = 0.5 * (y1 + y2);
	return [x1, y1, x2, y2, w, h, cx, cy, w * h];
}

function lineStats(rows, start, end) {
	const dim = end - start;
	const out = new Array(dim * 6).fill(0);
	if (!rows.length) {
		return out;
	}
	for (let j = 0; j < dim; j++) {
		let sum = 0;
		let max = -Infinity;
		let min = Infinity;
		for (const row of rows) {
			const value = Number.isFinite(row[start + j]) ? row[start + j] : 0;
			sum += value;
			max = Math.max(max, value);
			min = Math.min(min, value);
		}
		const avg = sum / rows.length;
		let variance = 0;
		for (const row of rows) {
			const value = Number.isFinite(row[start + j]) ? row[start + j] : 0;
			variance += (value - avg) * (value - avg);
		}
		out[j] = avg;
		out[dim + j] = max;
		out[dim * 2 + j] = min;
		out[dim * 3 + j] = Math.sqrt(variance / rows.length);
		out[dim * 4 + j] = Number.isFinite(rows[0][start + j]) ? rows[0][start + j] : 0;
		out[dim * 5 + j] = Number.isFinite(rows[rows.length - 1][start + j]) ? rows[rows.length - 1][start + j] : 0;
	}
	return out;
}

function lineStatsFromRows(rows) {
	if (!rows.length) {
		return [];
	}
	return lineStats(rows, 0, rows[0].length);
}

function catHist(rows, column, bins) {
	const out = new Array(bins).fill(0);
	if (!rows.length) {
		return out;
	}
	for (const row of rows) {
		let value = Math.trunc(row[column] || 0);
		value = Math.max(0, Math.min(bins - 1, value));
		out[value] += 1 / rows.length;
	}
	return out;
}

function adjacentBlockFeatures(boxes) {
	const out = boxes.map(() => new Array(12).fill(0));
	for (let i = 0; i < boxes.length; i++) {
		const [x1, y1, x2, y2, w, , cx, cy] = boxes[i];
		if (i > 0) {
			const [px1, py1, px2, py2, pw, , pcx, pcy] = boxes[i - 1];
			out[i][0] = y1 - py2;
			out[i][1] = x1 - px1;
			out[i][2] = x2 - px2;
			out[i][3] = cx - pcx;
			out[i][4] = cy - pcy;
			const overlap = Math.max(0, Math.min(x2, px2) - Math.max(x1, px1));
			out[i][5] = overlap / Math.max(Math.min(w, pw), 1e-6);
		}
		if (i + 1 < boxes.length) {
			const [nx1, ny1, nx2, , nw, , ncx, ncy] = boxes[i + 1];
			out[i][6] = ny1 - y2;
			out[i][7] = nx1 - x1;
			out[i][8] = nx2 - x2;
			out[i][9] = ncx - cx;
			out[i][10] = ncy - cy;
			const overlap = Math.max(0, Math.min(x2, nx2) - Math.max(x1, nx1));
			out[i][11] = overlap / Math.max(Math.min(w, nw), 1e-6);
		}
	}
	return out;
}

function bboxParts(row) {
	let [x1, y1, x2, y2] = row;
	if (x2 < x1) [x1, x2] = [x2, x1];
	if (y2 < y1) [y1, y2] = [y2, y1];
	return [x1, y1, x2, y2];
}

function overlap1d(a1, a2, b1, b2) {
	return Math.max(0, Math.min(a2, b2) - Math.max(a1, b1));
}

function pairGapFeatures(lines, objects) {
	if (lines.length <= 1) {
		return [];
	}
	const objectBoxes = objects.filter(obj => obj.length >= 4).map(bboxParts);
	const out = [];
	for (let i = 1; i < lines.length; i++) {
		const prev = lines[i - 1];
		const curr = lines[i];
		const [px1, py1, px2, py2] = bboxParts(prev);
		const [cx1, cy1, cx2, cy2] = bboxParts(curr);
		const pw = Math.max(px2 - px1, 1e-6);
		const ph = Math.max(py2 - py1, 1e-6);
		const cw = Math.max(cx2 - cx1, 1e-6);
		const ch = Math.max(cy2 - cy1, 1e-6);
		const pcx = 0.5 * (px1 + px2);
		const pcy = 0.5 * (py1 + py2);
		const ccx = 0.5 * (cx1 + cx2);
		const ccy = 0.5 * (cy1 + cy2);
		const xOverlap = overlap1d(px1, px2, cx1, cx2);
		const yGap = ccy >= pcy ? Math.max(0, Math.max(cy1, py1) - Math.min(cy2, py2)) : Math.max(0, py1 - cy2);
		let gapLow;
		let gapHigh;
		if (ccy >= pcy) {
			gapLow = py2;
			gapHigh = cy1;
		}
		else {
			gapLow = cy2;
			gapHigh = py1;
		}
		if (gapHigh < gapLow) {
			[gapLow, gapHigh] = [gapHigh, gapLow];
		}
		const bandLow = Math.min(py1, cy1) - 0.01;
		const bandHigh = Math.max(py2, cy2) + 0.01;
		const xLow = Math.min(px1, cx1) - 0.01;
		const xHigh = Math.max(px2, cx2) + 0.01;
		let nearObjects = 0;
		let hRules = 0;
		let vRules = 0;
		let enclosing = 0;
		for (const [ox1, oy1, ox2, oy2] of objectBoxes) {
			const ow = Math.max(ox2 - ox1, 1e-6);
			const oh = Math.max(oy2 - oy1, 1e-6);
			const ocx = 0.5 * (ox1 + ox2);
			const ocy = 0.5 * (oy1 + oy2);
			const nearGap = (gapLow - 0.01) <= ocy && ocy <= (gapHigh + 0.01);
			const overlapsX = overlap1d(ox1, ox2, xLow, xHigh) > 0;
			const overlapsY = overlap1d(oy1, oy2, bandLow, bandHigh) > 0;
			if (overlapsX && overlapsY) nearObjects++;
			if (nearGap && overlapsX && ow > 0.05 && oh < 0.006) hRules++;
			if (overlapsY && xLow <= ocx && ocx <= xHigh && oh > 0.03 && ow < 0.006) vRules++;
			if (ox1 <= Math.min(px1, cx1) && ox2 >= Math.max(px2, cx2) && oy1 <= Math.min(py1, cy1) && oy2 >= Math.max(py2, cy2)) {
				enclosing++;
			}
		}
		out.push([
			ccx - pcx,
			ccy - pcy,
			Math.abs(cx1 - px1),
			Math.abs(cx2 - px2),
			xOverlap / Math.max(Math.min(pw, cw), 1e-6),
			yGap,
			cw / pw,
			ch / ph,
			curr[11] || 0,
			curr[12] || 0,
			curr[13] || 0,
			Math.min(1, nearObjects / 8),
			Math.min(1, hRules / 4),
			Math.min(1, vRules / 8),
			Math.min(1, enclosing / 2),
		]);
	}
	return out;
}

function blockHashSlots(blockRows) {
	const n = blockRows.length;
	const out = [];
	const positions = [0, Math.min(1, n - 1), Math.max(0, n - 2), n - 1];
	for (const pos of positions) {
		const row = blockRows[pos] || [];
		for (let i = 18; i < 21; i++) {
			out.push(Math.max(0, Math.min(WORD_HASH_MAX, Math.trunc(row[i] || 0))));
		}
	}
	return out;
}

function blockExtraHashSlots(extraHashRows, lineIndexes) {
	const out = [];
	const n = lineIndexes.length;
	const positions = [0, Math.min(1, n - 1), Math.max(0, n - 2), n - 1];
	for (const pos of positions) {
		const row = extraHashRows[lineIndexes[pos]] || [];
		for (let i = 0; i < 6; i++) {
			out.push(Math.max(0, Math.min(WORD_HASH_MAX, Math.trunc(row[i] || 0))));
		}
	}
	while (out.length < 24) {
		out.push(0);
	}
	return out.slice(0, 24);
}

function blockCatSlots(blockRows) {
	const n = blockRows.length;
	const first = blockRows[0] || [];
	const last = blockRows[n - 1] || [];
	const charSlots = [
		Math.trunc(first[9] || 0),
		Math.trunc(first[10] || 0),
		Math.trunc(last[9] || 0),
		Math.trunc(last[10] || 0),
	].map(v => Math.max(0, Math.min(63, v)));
	return { charSlots };
}

function pageContextFeatures(features, boxes, blockSpans, lines, gapFeatures) {
	const nBlocks = features.length;
	const adjacent = adjacentBlockFeatures(boxes);
	const activeLineHeights = lines.map(row => row[5]).filter(Number.isFinite).sort((a, b) => a - b);
	const medianLineHeight = Math.max(median(activeLineHeights), 1e-6);
	const pageTextBox = blockGeometry(lines);
	const pageWidth = Math.max(pageTextBox[4], 1e-6);
	const pageHeight = Math.max(pageTextBox[5], 1e-6);
	const zeroGap = new Array(15).fill(0);
	for (let i = 0; i < nBlocks; i++) {
		const [start, end] = blockSpans[i];
		const blockRows = lines.slice(start, end + 1);
		const blockBox = boxes[i];
		const rankDenom = Math.max(nBlocks - 1, 1);
		const lineDenom = Math.max(lines.length - 1, 1);
		const meanLineHeight = Math.max(mean(blockRows.map(row => row[5])), 1e-6);
		const pageAug = [
			i / rankDenom,
			(nBlocks - 1 - i) / rankDenom,
			Math.log1p(nBlocks),
			nBlocks / 64,
			start / lineDenom,
			(lines.length - 1 - end) / lineDenom,
			(blockBox[0] - pageTextBox[0]) / pageWidth,
			(blockBox[2] - pageTextBox[0]) / pageWidth,
			(blockBox[1] - pageTextBox[1]) / pageHeight,
			(blockBox[3] - pageTextBox[1]) / pageHeight,
			meanLineHeight / medianLineHeight,
			blockBox[5] / medianLineHeight,
			blockBox[1] > 0.70 ? 1 : 0,
			blockBox[1] > 0.80 ? 1 : 0,
			blockBox[3] > 0.90 ? 1 : 0,
		];
		const before = start > 0 && gapFeatures.length ? gapFeatures[start - 1] : zeroGap;
		const after = end < gapFeatures.length && gapFeatures.length ? gapFeatures[end] : zeroGap;
		let inside = zeroGap;
		let insideMax = zeroGap;
		if (end > start && gapFeatures.length) {
			const rows = gapFeatures.slice(start, end);
			inside = lineStatsFromRows(rows).slice(0, 15);
			insideMax = lineStatsFromRows(rows).slice(15, 30);
		}
		features[i].push(...adjacent[i], ...pageAug, ...before, ...after, ...inside, ...insideMax);
	}
}

function blockLineIndexes(block) {
	return Array.isArray(block?.lines) ? block.lines.filter(Number.isInteger) : [];
}

function makeExtraRows(lines) {
	const pageMedianFont = median(lines.flatMap(line => fontSizes(line)));
	return {
		extraFeatures: lines.map(line => lineExtra(line, pageMedianFont)),
		extraHashes: lines.map(line => extraHashes(lineText(line))),
	};
}

export function buildBlockClassifierFeatures({ blocks, lines, lineFeatures, objectFeatures }) {
	const blockCount = blocks.length;
	const regular = new Float32Array(blockCount * REGULAR_DIM);
	const rich = new Float32Array(blockCount * RICH_DIM);
	const hashSlots = new Int32Array(blockCount * 36);
	const charSlots = new Int32Array(blockCount * 4);
	if (!blockCount) {
		return { blockCount, regular, rich, hashSlots, charSlots };
	}

	const { extraFeatures, extraHashes: extraHashRows } = makeExtraRows(lines);
	const gapFeatures = pairGapFeatures(lineFeatures, objectFeatures);
	const regularRows = [];
	const richFullRows = [];
	const boxes = [];
	const blockSpans = [];

	for (const block of blocks) {
		const lineIndexes = blockLineIndexes(block);
		const blockRows = lineIndexes.map(index => lineFeatures[index]).filter(Boolean);
		const nLines = Math.max(blockRows.length, 1);
		const start = lineIndexes.length ? Math.min(...lineIndexes) : 0;
		const end = lineIndexes.length ? Math.max(...lineIndexes) : start;
		const hashes = blockRows.map(row => [row[18] / WORD_HASH_MAX, row[19] / WORD_HASH_MAX, row[20] / WORD_HASH_MAX]);
		const extras = lineIndexes.map(index => extraFeatures[index] || new Array(EXTRA_DIM).fill(0));
		const geometry = blockGeometry(blockRows);
		const regularBase = [
			...geometry,
			Math.log1p(nLines),
			nLines / 32,
			start / 256,
			end / 256,
			...lineStats(blockRows, 0, 18),
			...lineStatsFromRows(hashes),
		];
		const width = Math.max(geometry[4], 1e-6);
		const height = Math.max(geometry[5], 1e-6);
		const richBase = [
			...geometry,
			Math.log1p(nLines),
			nLines / 32,
			start / 256,
			end / 256,
			geometry[4] / Math.max(height, 1e-6),
			geometry[8] / (width * height),
			...lineStats(blockRows, 0, 18),
			...lineStatsFromRows(hashes),
			...catHist(blockRows, 9, 64),
			...catHist(blockRows, 10, 64),
			...catHist(blockRows, 16, 2),
			...catHist(blockRows, 17, 4),
			...lineStatsFromRows(extras),
		];
		regularRows.push(regularBase);
		richFullRows.push(richBase);
		boxes.push(geometry);
		blockSpans.push([start, end]);

		const blockIndex = regularRows.length - 1;
		const { charSlots: c } = blockCatSlots(blockRows);
		hashSlots.set([...blockHashSlots(blockRows), ...blockExtraHashSlots(extraHashRows, lineIndexes)], blockIndex * 36);
		charSlots.set(c, blockIndex * 4);
	}

	pageContextFeatures(regularRows, boxes, blockSpans, lineFeatures, gapFeatures);
	pageContextFeatures(richFullRows, boxes, blockSpans, lineFeatures, gapFeatures);

	for (let i = 0; i < blockCount; i++) {
		if (regularRows[i].length !== REGULAR_DIM) {
			throw new Error(`Unexpected regular block feature length ${regularRows[i].length}, expected ${REGULAR_DIM}`);
		}
		const compactRich = [
			...richFullRows[i].slice(0, 15),
			...richFullRows[i].slice(141, 548),
		];
		if (compactRich.length !== RICH_DIM) {
			throw new Error(`Unexpected rich block feature length ${compactRich.length}, expected ${RICH_DIM}`);
		}
		regular.set(regularRows[i], i * REGULAR_DIM);
		rich.set(compactRich, i * RICH_DIM);
	}

	return {
		blockCount,
		regular,
		rich,
		hashSlots,
		charSlots,
		regularDim: REGULAR_DIM,
		richDim: RICH_DIM,
		hashSlotsDim: 36,
		charSlotsDim: 4,
	};
}

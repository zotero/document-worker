import {
	HEADER_LAST_IS_SOFT_HYPHEN,
	HEADER_AXIS_DIR_SHIFT,
	HEADER_DIR_RTL,
	EPS,
	isVertical,
} from './constants.js';

// ───────────────────────────── Style Helpers ─────────────────────────────

const sameStyle = (a, b) =>
	a && b &&
	!!a.bold === !!b.bold &&
	!!a.italic === !!b.italic &&
	!!a.sub === !!b.sub &&
	!!a.sup === !!b.sup &&
	!!a.code === !!b.code;

function styleFromChar(ch) {
	const s = {};
	if (ch.bold) s.bold = true;
	if (ch.italic) s.italic = true;
	if (ch.sub) s.sub = true;
	if (ch.sup) s.sup = true;
	if (ch.code) s.code = true;
	if (ch.sup) s._fontSize = ch.fontSize;
	return Object.keys(s).length ? s : undefined;
}

function sameLineRect(a, b, axisDir) {
	if (!a || !b) return false;
	return isVertical(axisDir)
		? Math.abs(a[0] - b[0]) <= EPS && Math.abs(a[2] - b[2]) <= EPS
		: Math.abs(a[1] - b[1]) <= EPS && Math.abs(a[3] - b[3]) <= EPS;
}

// ───────────────────────────── Run Optimization ─────────────────────────────

function roundShortest(value, maxError) {
	if (!Number.isFinite(value)) return value;
	for (let d = 0; d <= 6; d++) {
		const f = 10 ** d;
		const rounded = Math.round(value * f) / f;
		if (Math.abs(rounded - value) <= maxError + 1e-9) return rounded;
	}
	return value;
}

function optimizeRun(run, maxError = 0.25) {
	if (!run || run.length < 6) return run;

	const [header, pageIndex, minX, minY, maxX, maxY, ...widths] = run;
	const result = [
		header,
		pageIndex,
		roundShortest(minX, maxError),
		roundShortest(minY, maxError),
		roundShortest(maxX, maxError),
		roundShortest(maxY, maxError),
	];

	let cumErr = result[2] - minX;

	for (const w of widths) {
		if (Array.isArray(w)) {
			const [delta, width] = w;
			const targetDelta = delta - cumErr;
			const roundedDelta = roundShortest(targetDelta, maxError);
			cumErr = roundedDelta - targetDelta;

			let targetWidth = width - cumErr;
			if (targetWidth < 0) { cumErr += targetWidth; targetWidth = 0; }
			const roundedWidth = roundShortest(targetWidth, maxError);
			cumErr = roundedWidth - targetWidth;

			result.push([roundedDelta, roundedWidth]);
		} else {
			let targetWidth = w - cumErr;
			if (targetWidth < 0) { cumErr += targetWidth; targetWidth = 0; }
			const roundedWidth = roundShortest(targetWidth, maxError);
			cumErr = roundedWidth - targetWidth;

			result.push(roundedWidth);
		}
	}

	return result;
}

// ───────────────────────────── Char → TextNode ─────────────────────────────

export function charsToTextNodes(pageIndex, chars) {
	if (!chars?.length) return [];

	const nodes = [];
	let node = null;

	const flushRun = () => {
		const run = node?.currentRun;
		if (!run) return;
		node.currentRun = null;

		const { axisDir, rtl, glyphs, minX, minY, maxX, maxY, hasTrailingSoftHyphen } = run;
		if (!glyphs.length && !hasTrailingSoftHyphen) return;
		if ([minX, minY, maxX, maxY].some(v => v == null)) return;

		let header = (axisDir & 0b11) << HEADER_AXIS_DIR_SHIFT;
		if (hasTrailingSoftHyphen) header |= HEADER_LAST_IS_SOFT_HYPHEN;
		if (rtl) header |= HEADER_DIR_RTL;

		// Build widths: space becomes delta on next char, clusters get 0-width continuation
		const widths = [];
		for (let i = 0; i < glyphs.length; i++) {
			const { width, delta, clusterLen } = glyphs[i];
			const hasDelta = delta !== null && (delta < -EPS || delta > EPS);

			if (hasDelta) {
				widths.push([delta, width]);
			} else {
				widths.push(width);
			}

			// Add zero-width entries for cluster continuation (UTF-16 units after first)
			for (let j = 1; j < clusterLen; j++) {
				widths.push(0);
			}
		}

		// Single char optimization: no widths needed, bbox defines position
		const finalWidths = widths.length === 1 && !Array.isArray(widths[0]) ? [] : widths;

		const original = [header, pageIndex, minX, minY, maxX, maxY, ...finalWidths];
		const optimized = optimizeRun(original);

		node.runs.push(optimized);
	};

	const flushNode = () => {
		if (!node) return;
		flushRun();

		const text = node.textParts.join('');
		const style = node.style;
		const anchor = node.runs.length ? { textMap: JSON.stringify(node.runs) } : null;

		const leadingMatch = text.match(/^ +/);
		const trailingMatch = text.match(/ +$/);

		const leadingCount = leadingMatch ? leadingMatch[0].length : 0;
		const trailingCount = trailingMatch ? trailingMatch[0].length : 0;

		const coreText = text.slice(leadingCount, text.length - trailingCount);

		const pushNode = (t, withAnchor, withStyle) => {
			if (!t) return;
			const out = { text: t };
			if (withStyle && style) out.style = style;
			if (withAnchor && anchor) out.anchor = anchor;
			nodes.push(out);
		};

		// Leading spaces as separate nodes (no style/anchor)
		for (let i = 0; i < leadingCount; i++) {
			pushNode(' ', false, false);
		}

		// Core text (no leading/trailing spaces) keeps style/anchor
		pushNode(coreText, true, true);

		// Trailing spaces as separate nodes (no style/anchor)
		for (let i = 0; i < trailingCount; i++) {
			pushNode(' ', false, false);
		}

		node = null;
	};

	const getExtent = (rect, axisDir) =>
		rect ? (isVertical(axisDir) ? rect[3] - rect[1] : rect[2] - rect[0]) : 0;

	const getStart = (rect, axisDir) =>
		rect ? (isVertical(axisDir) ? rect[1] : rect[0]) : null;

	const getEnd = (rect, axisDir) =>
		rect ? (isVertical(axisDir) ? rect[3] : rect[2]) : null;

	const extendBBox = (run, rect) => {
		if (!rect) return;
		run.minX = Math.min(run.minX ?? rect[0], rect[0]);
		run.minY = Math.min(run.minY ?? rect[1], rect[1]);
		run.maxX = Math.max(run.maxX ?? rect[2], rect[2]);
		run.maxY = Math.max(run.maxY ?? rect[3], rect[3]);
	};

	const createRun = (ch, rect) => ({
		axisDir: ch.axisDir,
		rtl: !!ch.rtl,
		lineRect: rect,
		minX: rect?.[0] ?? null,
		minY: rect?.[1] ?? null,
		maxX: rect?.[2] ?? null,
		maxY: rect?.[3] ?? null,
		lastEnd: getEnd(rect, ch.axisDir),
		pendingSpace: 0,
		glyphs: [],
		hasTrailingSoftHyphen: false,
	});

	const addGlyph = (run, rect, charLen, hasSpace, extent) => {
		const vertical = isVertical(run.axisDir);

		// Calculate delta: pending space + gap from previous glyph
		let delta = run.pendingSpace;
		if (run.glyphs.length > 0 && rect) {
			// Only compute gap for subsequent glyphs
			delta += getStart(rect, run.axisDir) - run.lastEnd;
		}

		// Split extent between char and space (2:1 ratio)
		let charWidth = extent;
		let spaceWidth = 0;
		if (hasSpace && extent > 0) {
			charWidth = extent * 2 / 3;
			spaceWidth = extent - charWidth;
		}

		run.glyphs.push({
			width: charWidth,
			delta: delta !== 0 ? delta : null,
			clusterLen: charLen,
		});

		run.lastEnd = getEnd(rect, run.axisDir);
		run.pendingSpace = spaceWidth;
	};

	for (let i = 0; i < chars.length; i++) {
		const ch = chars[i];
		const isLast = i === chars.length - 1;
		const rect = ch.rect;

		// Style change: flush and start new node
		if (!node || !sameStyle(node._style, ch)) {
			flushNode();
			node = {
				textParts: [],
				style: styleFromChar(ch),
				_style: ch,
				runs: [],
				currentRun: null,
			};
		}

		// Trailing soft hyphen (layout-only, not in text)
		if ((ch.ignorable || ch.softHyphen) && ch.lineBreakAfter && !isLast) {
			const ext = getExtent(rect, ch.axisDir);

			if (!node.currentRun) {
				node.currentRun = createRun(ch, rect);
			} else {
				extendBBox(node.currentRun, rect);
			}

			addGlyph(node.currentRun, rect, 1, false, ext);
			node.currentRun.hasTrailingSoftHyphen = true;
			continue;
		}

		// Normal character
		const hasSpace = !!ch.spaceAfter;
		const addBreakSpace = ch.lineBreakAfter && !isLast;
		const charLen = ch.c.length; // UTF-16 length for cluster support

		// Add to text (includes spaces)
		node.textParts.push(ch.c);
		if (hasSpace) node.textParts.push(' ');
		if (addBreakSpace) node.textParts.push(' ');

		const ext = getExtent(rect, ch.axisDir);
		const run = node.currentRun;

		// Start new run or continue existing
		if (!run) {
			node.currentRun = createRun(ch, rect);
			addGlyph(node.currentRun, rect, charLen, hasSpace, ext);
			node.currentRun.hasTrailingSoftHyphen = false;
		} else if (
			run.axisDir === ch.axisDir &&
			run.rtl === !!ch.rtl &&
			sameLineRect(run.lineRect, rect, run.axisDir)
		) {
			// Continue run
			extendBBox(run, rect);
			addGlyph(run, rect, charLen, hasSpace, ext);
			run.hasTrailingSoftHyphen = false;
		} else {
			// New run (different line/direction)
			flushRun();
			node.currentRun = createRun(ch, rect);
			addGlyph(node.currentRun, rect, charLen, hasSpace, ext);
			node.currentRun.hasTrailingSoftHyphen = false;
		}
	}

	flushNode();
	return nodes;
}
const WORD_BREAK_GAP_RATIO = 3.5;
const DIRECTION_RATIO = 1.5;
const MIN_ROTATED_ATOMS = 16;
const MIN_VERTICAL_WEIGHT = 24;
const MIN_VERTICAL_RATIO = 0.7;
const MIN_DIRECTION_RATIO = 0.6;

function unionRects(rects) {
	if (!rects.length) return null;
	return [
		Math.min(...rects.map(rect => rect[0])),
		Math.min(...rects.map(rect => rect[1])),
		Math.max(...rects.map(rect => rect[2])),
		Math.max(...rects.map(rect => rect[3])),
	];
}

function rectCenter(rect) {
	return [0.5 * (rect[0] + rect[2]), 0.5 * (rect[1] + rect[3])];
}

function rectSize(rect) {
	return Math.max(1e-6, rect[2] - rect[0], rect[3] - rect[1]);
}

function median(values, fallback = 1) {
	if (!values.length) return fallback;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid] : 0.5 * (sorted[mid - 1] + sorted[mid]);
}

function shouldBreakAtom(current, rect) {
	if (!current?.rects?.length || !rect) return false;
	const previous = current.rects[current.rects.length - 1];
	const [px, py] = rectCenter(previous);
	const [x, y] = rectCenter(rect);
	const distance = Math.hypot(x - px, y - py);
	const scale = median([...current.rects.map(rectSize), rectSize(rect)], 1);
	return distance > Math.max(1, scale * WORD_BREAK_GAP_RATIO);
}

function writingInfoFromRects(rects) {
	if (rects.length < 2) return { writingMode: null, direction: undefined };
	let dx = 0;
	let dy = 0;
	let signedDx = 0;
	let signedDy = 0;
	for (let index = 1; index < rects.length; index++) {
		const [prevX, prevY] = rectCenter(rects[index - 1]);
		const [x, y] = rectCenter(rects[index]);
		dx += Math.abs(x - prevX);
		dy += Math.abs(y - prevY);
		signedDx += x - prevX;
		signedDy += y - prevY;
	}
	if (dy > dx * DIRECTION_RATIO) {
		return { writingMode: 'vertical', direction: signedDy >= 0 ? 'ttb' : 'btt' };
	}
	if (dx > dy * DIRECTION_RATIO) {
		return { writingMode: 'horizontal', direction: signedDx >= 0 ? 'ltr' : 'rtl' };
	}
	return { writingMode: null, direction: undefined };
}

function atomWeight(atom) {
	return Math.max(1, atom.charIndexes?.length || Array.from(String(atom.text ?? '')).length);
}

function bboxWidth(box) {
	return Math.max(1e-6, box[2] - box[0]);
}

function bboxHeight(box) {
	return Math.max(1e-6, box[3] - box[1]);
}

function bboxCorners(box) {
	return [
		[box[0], box[1]],
		[box[2], box[1]],
		[box[2], box[3]],
		[box[0], box[3]],
	];
}

function transformBbox(box, tableBox, direction) {
	const tableWidth = bboxWidth(tableBox);
	const tableHeight = bboxHeight(tableBox);
	const transformed = bboxCorners(box).map(([x, y]) => {
		const localX = x - tableBox[0];
		const localY = y - tableBox[1];
		if (direction === 'btt') return [localY, tableWidth - localX];
		return [tableHeight - localY, localX];
	});
	return [
		Math.min(...transformed.map(point => point[0])),
		Math.min(...transformed.map(point => point[1])),
		Math.max(...transformed.map(point => point[0])),
		Math.max(...transformed.map(point => point[1])),
	];
}

function tableOrientationForAtoms(atoms) {
	if (atoms.length < MIN_ROTATED_ATOMS) {
		return { rotated: false };
	}
	let totalWeight = 0;
	let verticalWeight = 0;
	let ttbWeight = 0;
	let bttWeight = 0;
	for (const atom of atoms) {
		const weight = atomWeight(atom);
		totalWeight += weight;
		if (atom.writing_mode === 'vertical') {
			verticalWeight += weight;
			if (atom.direction === 'btt') bttWeight += weight;
			else ttbWeight += weight;
		}
	}
	const verticalRatio = verticalWeight / Math.max(totalWeight, 1e-6);
	if (verticalWeight < MIN_VERTICAL_WEIGHT || verticalRatio < MIN_VERTICAL_RATIO) {
		return { rotated: false };
	}
	const direction = bttWeight > ttbWeight ? 'btt' : 'ttb';
	const directionRatio = Math.max(ttbWeight, bttWeight) / Math.max(verticalWeight, 1e-6);
	if (directionRatio < MIN_DIRECTION_RATIO) {
		return { rotated: false };
	}
	return { rotated: true, direction };
}

export function charsToTableAtoms(chars, viewBox) {
	const pageH = Math.max(1, viewBox[3] - viewBox[1]);
	const atoms = [];
	let current = null;

	const flush = () => {
		if (!current) return;
		const raw = unionRects(current.rects);
		if (raw) {
			const { writingMode, direction } = writingInfoFromRects(current.rects);
			const rawWidth = Math.max(1, raw[2] - raw[0]);
			const rawHeight = Math.max(1, raw[3] - raw[1]);
			atoms.push({
				id: `w${atoms.length}`,
				text: current.text,
				bbox: [raw[0], pageH - raw[3], raw[2], pageH - raw[1]],
				font_size: writingMode === 'vertical' ? rawWidth : rawHeight,
				draw_order: atoms.length,
				charIndexes: current.charIndexes,
				...(writingMode ? { writing_mode: writingMode } : {}),
				...(direction ? { direction } : {}),
			});
		}
		current = null;
	};

	for (let index = 0; index < chars.length; index++) {
		const ch = chars[index];
		const text = ch.c;
		const rect = ch.rect;
		if (!text || /\s/.test(text) || !rect) {
			flush();
			continue;
		}
		if (current && shouldBreakAtom(current, rect)) flush();
		if (!current) current = { text: '', rects: [], charIndexes: [] };
		current.text += text;
		current.rects.push(rect);
		current.charIndexes.push(index);
		if (ch.spaceAfter || ch.lineBreakAfter) flush();
	}
	flush();
	return atoms;
}

export function normalizeAtomsForTableInference(atoms, viewBox) {
	const pageSize = {
		width: Math.max(1, viewBox[2] - viewBox[0]),
		height: Math.max(1, viewBox[3] - viewBox[1]),
	};
	const orientation = tableOrientationForAtoms(atoms);
	if (!orientation.rotated) {
		return { atoms, width: pageSize.width, height: pageSize.height };
	}

	const tableBox = unionRects(atoms.map(atom => atom.bbox).filter(Boolean));
	if (!tableBox) {
		return { atoms, width: pageSize.width, height: pageSize.height };
	}

	const width = bboxHeight(tableBox);
	const height = bboxWidth(tableBox);
	const normalizedAtoms = atoms.map(atom => {
		const bbox = transformBbox(atom.bbox, tableBox, orientation.direction);
		return {
			...atom,
			bbox,
			font_size: Math.max(1, bboxHeight(bbox)),
			writing_mode: 'horizontal',
			direction: 'ltr',
		};
	});

	return { atoms: normalizedAtoms, width, height };
}

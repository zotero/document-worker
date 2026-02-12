import { HEADER_AXIS_DIR_SHIFT, isVertical } from './constants.js';

/**
 * Parse textMap JSON string into array of runs.
 */
export function parseTextMap(textMap) {
	if (typeof textMap !== 'string') {
		return [];
	}
	try {
		const parsed = JSON.parse(textMap);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

/**
 * Reconstructs character positions from a run array.
 * Single-char runs have no widths; position is bbox.
 */
export function reconstructCharPositions(run) {
	if (!run || run.length < 6) return [];

	const [header, pageIndex, minX, minY, maxX, maxY, ...widths] = run;
	const axisDir = (header >> HEADER_AXIS_DIR_SHIFT) & 0b11;
	const vertical = isVertical(axisDir);
	const start = vertical ? minY : minX;
	const end = vertical ? maxY : maxX;

	// Single char: no widths, use full bbox
	if (widths.length === 0) {
		return [{ x1: start, x2: end }];
	}

	const positions = [];
	let pos = start;

	for (const w of widths) {
		if (Array.isArray(w)) {
			const [delta, width] = w;
			pos += delta;
			positions.push({ x1: pos, x2: pos + width });
			pos += width;
		} else {
			positions.push({ x1: pos, x2: pos + w });
			pos += w;
		}
	}

	return positions;
}

/**
 * Build run data with rects and page indexes from parsed runs.
 */
export function buildRunData(runs) {
	const data = [];
	for (const run of runs) {
		if (!Array.isArray(run) || run.length < 6) {
			continue;
		}
		const [header, pageIndex, minX, minY, maxX, maxY] = run;
		const axisDir = (header >> HEADER_AXIS_DIR_SHIFT) & 0b11;
		const vertical = isVertical(axisDir);
		const positions = reconstructCharPositions(run);

		// Remove soft hyphen position if present
		if (header & (1 << 0)) { // HEADER_LAST_IS_SOFT_HYPHEN
			positions.pop();
		}

		for (const pos of positions) {
			if (!pos || !Number.isFinite(pos.x1) || !Number.isFinite(pos.x2)) {
				continue;
			}
			const rect = vertical
				? [minX, pos.x1, maxX, pos.x2]
				: [pos.x1, minY, pos.x2, maxY];
			data.push({ rect, pageIndex, vertical });
		}
	}
	return data;
}
export function createCell(row, col, overrides = {}) {
	return {
		row,
		col,
		text: '',
		indices: [],
		bbox: null,
		...overrides,
	};
}

function cellText(cell) {
	return String(cell?.text ?? '').trim();
}

export function cellHasText(cell) {
	return cellText(cell).length > 0;
}

function cloneCell(cell, row = cell?.row ?? 0, col = cell?.col ?? 0) {
	return createCell(row, col, {
		text: String(cell?.text ?? ''),
		indices: [...(cell?.indices || [])],
		bbox: cell?.bbox ? [...cell.bbox] : null,
	});
}

function unionBbox(left, right) {
	if (!left) return right ? [...right] : null;
	if (!right) return [...left];
	return [
		Math.min(left[0], right[0]),
		Math.min(left[1], right[1]),
		Math.max(left[2], right[2]),
		Math.max(left[3], right[3]),
	];
}

function joinCellText(left, right) {
	const a = String(left || '').trim();
	const b = String(right || '').trim();
	if (!a) return b;
	if (!b) return a;
	if (/[-\u2010-\u2015]$/.test(a)) return `${a}${b}`;
	if (/^[,.;:!?)]/.test(b)) return `${a}${b}`;
	return `${a} ${b}`;
}

export function mergeCells(
	left,
	right,
	row = left?.row ?? right?.row ?? 0,
	col = left?.col ?? right?.col ?? 0,
) {
	if (!cellHasText(left) && !(left?.indices || []).length)
		return cloneCell(right, row, col);
	if (!cellHasText(right) && !(right?.indices || []).length)
		return cloneCell(left, row, col);
	return createCell(row, col, {
		text: joinCellText(left?.text, right?.text),
		indices: [
			...new Set([...(left?.indices || []), ...(right?.indices || [])]),
		],
		bbox: unionBbox(left?.bbox, right?.bbox),
	});
}

export function reindexGrid(grid) {
	for (let row = 0; row < (grid?.matrix?.length || 0); row += 1) {
		for (let col = 0; col < (grid.matrix[row]?.length || 0); col += 1) {
			grid.matrix[row][col].row = row;
			grid.matrix[row][col].col = col;
		}
	}
	return grid;
}

export function removeColumn(grid, col) {
	for (const row of grid.matrix) row.splice(col, 1);
	return reindexGrid(grid);
}

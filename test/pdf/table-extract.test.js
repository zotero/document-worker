import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
	TABLE_GRID_LIMITS,
	isUsableTableGrid,
	shouldInferStructuredTableGrid,
} from '../../src/pdf/structure/table/extract.js';

function atoms(count) {
	return Array.from({ length: count }, () => ({}));
}

function grid(rows, cols, filledCells) {
	let remaining = filledCells;
	let atomIndex = 0;
	return {
		matrix: Array.from({ length: rows }, (_rowValue, row) => (
			Array.from({ length: cols }, (_colValue, col) => {
				const fill = remaining > 0;
				if (fill) {
					remaining--;
				}
				return {
					row,
					col,
					indices: fill ? [atomIndex++] : [],
				};
			})
		)),
	};
}

describe('table grid extraction gates', () => {
	it('only runs structured extraction for bounded table atom counts', () => {
		assert.equal(shouldInferStructuredTableGrid(atoms(TABLE_GRID_LIMITS.minAtoms - 1)), false);
		assert.equal(shouldInferStructuredTableGrid(atoms(TABLE_GRID_LIMITS.minAtoms)), true);
		assert.equal(shouldInferStructuredTableGrid(atoms(TABLE_GRID_LIMITS.maxAtoms)), true);
		assert.equal(shouldInferStructuredTableGrid(atoms(TABLE_GRID_LIMITS.maxAtoms + 1)), false);
	});

	it('accepts compact grids with good atom coverage and filled-cell density', () => {
		const candidate = grid(3, 3, 9);

		assert.equal(isUsableTableGrid(candidate, atoms(9)), true);
	});

	it('rejects one-dimensional or oversized grids', () => {
		assert.equal(isUsableTableGrid(grid(5, 1, 5), atoms(5)), false);
		assert.equal(isUsableTableGrid(grid(71, 20, 323), atoms(330)), false);
	});

	it('rejects grids that lose too much text or are mostly empty', () => {
		assert.equal(isUsableTableGrid(grid(2, 2, 2), atoms(4)), false);
		assert.equal(isUsableTableGrid(grid(10, 10, 4), atoms(4)), false);
	});

	it('rejects sparse grids even when every atom is placed', () => {
		assert.equal(isUsableTableGrid(grid(5, 6, 13), atoms(13)), false);
		assert.equal(isUsableTableGrid(grid(5, 6, 15), atoms(15)), true);
	});

	it('rejects wide grids unless the filled-cell density is strong', () => {
		assert.equal(isUsableTableGrid(grid(5, 14, 40), atoms(40)), false);
		assert.equal(isUsableTableGrid(grid(5, 14, 46), atoms(46)), true);
	});
});

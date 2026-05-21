import { bbox as atomBbox, tableRowAxis } from './decoder.js';
import {
	cellHasText,
	createCell,
	mergeCells,
	reindexGrid,
	removeColumn,
} from './grid.js';

const CONFIG = {
	geometryRowsCollapsedRawRows: 2,
	geometryRowsMaxExtraRows: 1,
	geometryRowsMaxExpansion: 1.1,
	geometryRowsCollisionGapRatio: 0.8,
	geometryRowsMinCollisionCols: 8,
	maxMergedBands: 4,
	splitRowLineTolerance: 0.65,
	cellJoinGapRatio: 0.8,
	bandCost: 1,
	mergeStepCost: 0.45,
	conflictCost: 2.5,
	closeConflictCost: 0.05,
	closeConflictGapRatio: 0.8,
	strongMergeCost: 0.85,
	gapCost: 0.3,
	freeGapRatio: 0.75,
	weakFillRate: 0.3,
	strongFillRate: 0.45,
	weakMergeCredit: 0.2,
	fringeMinNeighborOverlap: 0.6,
	fringeMinUnsharedCells: 1,
	fringeMaxSpanCoverage: 0.55,
	fringeMaxTrimmedCols: 2,
};

function axisRange(box, axis) {
	return axis === 'row' ? [box[1], box[3]] : [box[0], box[2]];
}

function median(values, fallback = 1) {
	if (!values.length) return fallback;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2
		? sorted[mid]
		: 0.5 * (sorted[mid - 1] + sorted[mid]);
}

function unionBbox(boxes) {
	const real = boxes.filter(Boolean);
	if (!real.length) return null;
	return [
		Math.min(...real.map((box) => box[0])),
		Math.min(...real.map((box) => box[1])),
		Math.max(...real.map((box) => box[2])),
		Math.max(...real.map((box) => box[3])),
	];
}

function groupBbox(groups, index, atoms) {
	const explicit = groups[index]?.bbox;
	if (explicit) return [...explicit];
	const boxes = (groups[index]?.indices || [])
		.map((atomIndex) => atoms[atomIndex])
		.filter(Boolean)
		.map(atomBbox);
	return unionBbox(boxes);
}

function resultGroups(result, key) {
	return Array.isArray(result?.[key]) ? result[key] : [];
}

function sourceCellsFromResult(result) {
	const rows = resultGroups(result, 'rows');
	const cols = resultGroups(result, 'cols');
	const rowByLabel = new Map(
		rows.map((row, index) => [String(row.label), index]),
	);
	const colByLabel = new Map(
		cols.map((col, index) => [String(col.label), index]),
	);
	const atoms = result?.atoms || [];

	return (result?.cells || [])
		.map((cell, order) => {
			const row = rowByLabel.get(String(cell.rowLabel));
			const col = colByLabel.get(String(cell.colLabel));
			if (row == null || col == null) return null;
			const indices = [...(cell.indices || [])];
			const boxes = indices
				.map((index) => atoms[index])
				.filter(Boolean)
				.map(atomBbox);
			const bbox = cell.bbox ? [...cell.bbox] : unionBbox(boxes);
			const drawOrder = Math.min(
				...indices
					.map((index) => Number(atoms[index]?.draw_order ?? index))
					.filter(Number.isFinite),
				order,
			);
			return {
				row,
				col,
				text: String(cell.text ?? ''),
				indices,
				bbox,
				drawOrder,
				rowLabel: cell.rowLabel,
				colLabel: cell.colLabel,
			};
		})
		.filter(Boolean);
}

function sourceAtomsFromResult(
	result,
	sourceCells = sourceCellsFromResult(result),
) {
	const atoms = result?.atoms || [];
	const rows = resultGroups(result, 'rows');
	const cols = resultGroups(result, 'cols');
	const rowByLabel = new Map(
		rows.map((row, index) => [String(row.label), index]),
	);
	const colByLabel = new Map(
		cols.map((col, index) => [String(col.label), index]),
	);
	const byIndex = new Map();

	if (Array.isArray(result?.rowLabels) && Array.isArray(result?.colLabels)) {
		for (let index = 0; index < atoms.length; index += 1) {
			const row = rowByLabel.get(String(result.rowLabels[index]));
			const col = colByLabel.get(String(result.colLabels[index]));
			if (row != null && col != null) byIndex.set(index, { row, col });
		}
	}

	for (const cell of sourceCells) {
		for (const index of cell.indices || []) {
			if (!byIndex.has(index))
				byIndex.set(index, { row: cell.row, col: cell.col });
		}
	}

	return atoms
		.map((atom, index) => {
			const labels = byIndex.get(index);
			if (!labels) return null;
			const box = atomBbox(atom);
			return {
				atom,
				index,
				row: labels.row,
				col: labels.col,
				text: String(atom?.text ?? ''),
				bbox: box,
				drawOrder: Number(atom?.draw_order ?? index),
			};
		})
		.filter(Boolean);
}

function filterOrientationOutliers(result, sourceAtoms) {
	const axis = tableRowAxis(result?.atoms || []);
	return sourceAtoms.filter((item) => {
		const writingMode = String(item.atom?.writing_mode ?? '').toLowerCase();
		const direction = String(item.atom?.direction ?? '').toLowerCase();
		const vertical =
			writingMode === 'vertical' ||
			direction === 'ttb' ||
			direction === 'btt' ||
			direction === 'vertical';
		const horizontal =
			writingMode === 'horizontal' ||
			direction === 'ltr' ||
			direction === 'rtl' ||
			direction === 'horizontal';
		if (!vertical && !horizontal) return true;
		return axis === 'y' ? !vertical : !horizontal;
	});
}

function bandStats(count, cells, axis, orthCount) {
	const axisKey = axis === 'row' ? 'row' : 'col';
	return Array.from({ length: count }, (_value, index) => {
		const own = cells.filter((cell) => cell[axisKey] === index);
		const orthSlots = new Set(
			own.map((cell) => (axis === 'row' ? cell.col : cell.row)),
		);
		return {
			index,
			cells: own.length,
			orthSlots,
			fillRate: orthCount ? orthSlots.size / orthCount : 0,
		};
	});
}

function boundaryGap(groups, left, right, axis, atoms, base) {
	const leftBox = groupBbox(groups, left, atoms);
	const rightBox = groupBbox(groups, right, atoms);
	if (!leftBox || !rightBox) return 0;
	const [, leftHi] = axisRange(leftBox, axis);
	const [rightLo] = axisRange(rightBox, axis);
	return Math.max(0, rightLo - leftHi) / Math.max(1e-6, base);
}

function axisBase(groups, atoms, axis) {
	const boxes = atoms.map(atomBbox);
	const atomSizes = boxes.map((box) => {
		const [lo, hi] = axisRange(box, axis);
		return Math.max(1e-6, hi - lo);
	});
	const groupSizes = groups
		.map((group, index) => group.bbox || groupBbox(groups, index, atoms))
		.filter(Boolean)
		.map((box) => {
			const [lo, hi] = axisRange(box, axis);
			return Math.max(1e-6, hi - lo);
		});
	return median(atomSizes, median(groupSizes, 1));
}

function segmentCells(cells, axis, start, end) {
	const axisKey = axis === 'row' ? 'row' : 'col';
	return cells.filter((cell) => cell[axisKey] >= start && cell[axisKey] <= end);
}

function cellAxisStart(cell, axis) {
	if (!cell?.bbox) return 0;
	return axis === 'row' ? cell.bbox[1] : cell.bbox[0];
}

function cellAxisEnd(cell, axis) {
	if (!cell?.bbox) return 0;
	return axis === 'row' ? cell.bbox[3] : cell.bbox[2];
}

function segmentConflictPenalty(cells, axis, base, config) {
	const orthKey = axis === 'row' ? 'col' : 'row';
	const buckets = new Map();
	for (const cell of cells) {
		const key = cell[orthKey];
		if (!buckets.has(key)) buckets.set(key, []);
		buckets.get(key).push(cell);
	}
	let penalty = 0;
	for (const bucket of buckets.values()) {
		if (bucket.length > 1) {
			const ordered = [...bucket].sort(
				(left, right) => cellAxisStart(left, axis) - cellAxisStart(right, axis),
			);
			for (let index = 1; index < ordered.length; index += 1) {
				const gap = Math.max(
					0,
					cellAxisStart(ordered[index], axis) -
						cellAxisEnd(ordered[index - 1], axis),
				);
				const gapRatio = gap / Math.max(1e-6, base);
				penalty +=
					gapRatio <= config.closeConflictGapRatio
						? config.closeConflictCost
						: config.conflictCost *
							Math.min(
								2,
								gapRatio / Math.max(1e-6, config.closeConflictGapRatio),
							);
			}
		}
	}
	return penalty;
}

function boundaryMergeCost(leftStats, rightStats, gapRatio, config) {
	const overlap = [...leftStats.orthSlots].filter((slot) =>
		rightStats.orthSlots.has(slot),
	).length;
	const bothStrong =
		leftStats.fillRate >= config.strongFillRate &&
		rightStats.fillRate >= config.strongFillRate;
	const eitherWeak =
		leftStats.fillRate <= config.weakFillRate ||
		rightStats.fillRate <= config.weakFillRate;
	const gapPenalty =
		Math.max(0, gapRatio - config.freeGapRatio) * config.gapCost;
	const supportPenalty = bothStrong ? config.strongMergeCost : 0;
	const weakCredit = eitherWeak ? config.weakMergeCredit : 0;
	return (
		config.mergeStepCost +
		gapPenalty +
		supportPenalty +
		overlap * config.conflictCost -
		weakCredit
	);
}

function segmentCost(
	cells,
	groups,
	stats,
	axis,
	start,
	end,
	atoms,
	base,
	config,
) {
	const width = end - start + 1;
	if (width <= 1) return config.bandCost;

	let mergePenalty = 0;
	for (let index = start; index < end; index += 1) {
		mergePenalty += boundaryMergeCost(
			stats[index],
			stats[index + 1],
			boundaryGap(groups, index, index + 1, axis, atoms, base),
			config,
		);
	}

	return (
		config.bandCost +
		mergePenalty +
		segmentConflictPenalty(
			segmentCells(cells, axis, start, end),
			axis,
			base,
			config,
		)
	);
}

function fitAxis({ count, groups, cells, axis, orthCount, atoms, config }) {
	if (count <= 0) {
		return {
			partitions: [],
			map: [],
		};
	}

	const stats = bandStats(count, cells, axis, orthCount);
	const base = axisBase(groups, atoms, axis);
	const costs = new Array(count + 1).fill(Infinity);
	const back = new Array(count + 1).fill(null);
	costs[0] = 0;

	for (let end = 1; end <= count; end += 1) {
		const startMin = Math.max(0, end - config.maxMergedBands);
		for (let start = end - 1; start >= startMin; start -= 1) {
			const candidate = segmentCost(
				cells,
				groups,
				stats,
				axis,
				start,
				end - 1,
				atoms,
				base,
				config,
			);
			const cost = costs[start] + candidate;
			if (cost < costs[end]) {
				costs[end] = cost;
				back[end] = { start, end: end - 1 };
			}
		}
	}

	const partitions = [];
	for (let cursor = count; cursor > 0; ) {
		const item = back[cursor];
		if (!item) break;
		partitions.push({
			start: item.start,
			end: item.end,
		});
		cursor = item.start;
	}
	partitions.reverse();

	const map = new Array(count).fill(null);
	partitions.forEach((partition, index) => {
		for (let raw = partition.start; raw <= partition.end; raw += 1)
			map[raw] = index;
	});

	return {
		partitions,
		map,
	};
}

function identityAxis(count) {
	const partitions = Array.from({ length: count }, (_value, index) => ({
		start: index,
		end: index,
	}));
	return {
		partitions,
		map: partitions.map((_partition, index) => index),
	};
}

function clusterLineAtoms(items, config) {
	if (!items.length) return [];
	const heights = items.map((item) =>
		Math.max(1e-6, item.bbox[3] - item.bbox[1]),
	);
	const tolerance = median(heights, 1) * config.splitRowLineTolerance;
	const clusters = [];
	for (const item of [...items].sort(
		(left, right) =>
			0.5 * (left.bbox[1] + left.bbox[3]) -
			0.5 * (right.bbox[1] + right.bbox[3]),
	)) {
		const center = 0.5 * (item.bbox[1] + item.bbox[3]);
		const last = clusters[clusters.length - 1];
		if (last && Math.abs(center - last.center) <= tolerance) {
			last.items.push(item);
			last.center =
				last.items.reduce(
					(sum, value) => sum + 0.5 * (value.bbox[1] + value.bbox[3]),
					0,
				) / last.items.length;
		} else {
			clusters.push({ center, items: [item] });
		}
	}
	return clusters;
}

function buildRowLineFit(result, rowFit, sourceAtoms) {
	const rows = resultGroups(result, 'rows');
	const outputRows = [];
	const atomRowMap = new Map();

	rowFit.partitions.forEach((partition) => {
		const rowAtoms = sourceAtoms.filter(
			(item) => item.row >= partition.start && item.row <= partition.end,
		);
		const indices = rowAtoms.map((item) => item.index);
		const labels = [];
		for (let row = partition.start; row <= partition.end; row += 1)
			labels.push(rows[row]?.label);
		outputRows.push({
			label: labels.join('+'),
			sourceLabels: labels,
			indices,
			bbox: unionBbox(rowAtoms.map((item) => item.bbox)),
			text: rowAtoms
				.sort((left, right) => left.drawOrder - right.drawOrder)
				.map((item) => item.text)
				.filter(Boolean)
				.join(' '),
			axis: 'row',
		});
		for (const item of rowAtoms)
			atomRowMap.set(item.index, outputRows.length - 1);
	});

	return { rows: outputRows, atomRowMap };
}

function buildGeometryRowFit(sourceAtoms, config) {
	const clusters = clusterLineAtoms(sourceAtoms, config);
	const rows = [];
	const atomRowMap = new Map();

	clusters.forEach((cluster, row) => {
		const ordered = [...cluster.items].sort(
			(left, right) => left.drawOrder - right.drawOrder,
		);
		rows.push({
			label: `geo:${row}`,
			sourceLabels: [],
			indices: ordered.map((item) => item.index),
			bbox: unionBbox(ordered.map((item) => item.bbox)),
			text: ordered
				.map((item) => item.text)
				.filter(Boolean)
				.join(' '),
			axis: 'row',
		});
		for (const item of ordered) atomRowMap.set(item.index, row);
	});

	return {
		rows,
		atomRowMap,
	};
}

function rowCollisionStats(rowLineFit, sourceAtoms, config) {
	const heights = sourceAtoms.map((item) =>
		Math.max(1e-6, item.bbox[3] - item.bbox[1]),
	);
	const tolerance = median(heights, 1) * config.geometryRowsCollisionGapRatio;
	const buckets = new Map();
	for (const item of sourceAtoms) {
		const row = rowLineFit.atomRowMap.get(item.index);
		if (row == null || item.col == null) continue;
		const key = `${row}:${item.col}`;
		if (!buckets.has(key)) buckets.set(key, { row, col: item.col, items: [] });
		buckets.get(key).items.push(item);
	}

	const rowCounts = new Map();
	let collisionCells = 0;
	for (const bucket of buckets.values()) {
		if (bucket.items.length <= 1) continue;
		const centers = bucket.items.map(
			(item) => 0.5 * (item.bbox[1] + item.bbox[3]),
		);
		const spread = Math.max(...centers) - Math.min(...centers);
		if (spread <= tolerance) continue;
		collisionCells += 1;
		rowCounts.set(bucket.row, (rowCounts.get(bucket.row) || 0) + 1);
	}

	return {
		collisionCells,
		maxCollisionCols: Math.max(0, ...rowCounts.values()),
	};
}

function chooseRowLineFit(result, rowFit, sourceAtoms, rawRows, config) {
	const modelFit = buildRowLineFit(result, rowFit, sourceAtoms);

	const geometryFit = buildGeometryRowFit(sourceAtoms, config);
	const modelRows = modelFit.rows.length;
	const geometryRows = geometryFit.rows.length;
	const modelCollisions = rowCollisionStats(modelFit, sourceAtoms, config);
	const collapsedModel =
		rawRows <= config.geometryRowsCollapsedRawRows ||
		modelRows <= config.geometryRowsCollapsedRawRows;
	const noExpansion = geometryRows <= modelRows;
	const withinExtra =
		geometryRows <= modelRows + config.geometryRowsMaxExtraRows;
	const withinExpansion =
		geometryRows <= Math.ceil(modelRows * config.geometryRowsMaxExpansion);
	const collisionSupported =
		modelCollisions.maxCollisionCols >= config.geometryRowsMinCollisionCols;

	return collapsedModel ||
		noExpansion ||
		(collisionSupported && (withinExtra || withinExpansion))
		? geometryFit
		: modelFit;
}

function groupBaselineUnits(sourceAtoms, rowLineFit, config) {
	const byRow = new Map();
	for (const item of sourceAtoms) {
		const row = rowLineFit.atomRowMap.get(item.index);
		if (row == null) continue;
		if (!byRow.has(row)) byRow.set(row, []);
		byRow.get(row).push(item);
	}

	const units = [];
	for (const [row, rowAtoms] of byRow.entries()) {
		const ordered = [...rowAtoms].sort(
			(left, right) =>
				left.bbox[0] - right.bbox[0] || left.drawOrder - right.drawOrder,
		);
		const heights = ordered.map((item) =>
			Math.max(1e-6, item.bbox[3] - item.bbox[1]),
		);
		const joinGap = median(heights, 1) * config.cellJoinGapRatio;
		let current = [];

		const flush = () => {
			if (!current.length) return;
			const widest = current.reduce((best, item) => {
				const width = Math.max(0, item.bbox[2] - item.bbox[0]);
				const bestWidth = best ? Math.max(0, best.bbox[2] - best.bbox[0]) : -1;
				return width > bestWidth ? item : best;
			}, null);
			units.push({
				row,
				col: widest?.col ?? current[current.length - 1].col,
				text: current
					.sort((left, right) => left.drawOrder - right.drawOrder)
					.map((item) => item.text)
					.filter(Boolean)
					.join(' '),
				indices: current.map((item) => item.index),
				bbox: unionBbox(current.map((item) => item.bbox)),
				drawOrder: Math.min(...current.map((item) => item.drawOrder)),
				rowLabel: rowLineFit.rows[row]?.label,
				colLabel: widest?.col,
			});
			current = [];
		};

		for (const atom of ordered) {
			const previous = current[current.length - 1];
			const gap = previous ? atom.bbox[0] - previous.bbox[2] : Infinity;
			if (previous && gap > joinGap) flush();
			current.push(atom);
		}
		flush();
	}

	return units.sort((left, right) => left.drawOrder - right.drawOrder);
}

function partitionGroup(groups, partition, atoms, axis) {
	const boxes = [];
	const labels = [];
	const indices = [];
	for (let index = partition.start; index <= partition.end; index += 1) {
		const group = groups[index] || {};
		labels.push(group.label);
		indices.push(...(group.indices || []));
		const box = group.bbox || groupBbox(groups, index, atoms);
		if (box) boxes.push(box);
	}
	return {
		label: labels.join('+'),
		sourceLabels: labels,
		indices,
		bbox: unionBbox(boxes),
		text: indices
			.map((atomIndex) => atoms[atomIndex]?.text)
			.filter(Boolean)
			.join(' '),
		axis,
	};
}

function mergeSourceCellIntoGrid(grid, source, row, col) {
	const cell = createCell(row, col, {
		text: source.text,
		indices: [...source.indices],
		bbox: source.bbox ? [...source.bbox] : null,
	});
	grid.matrix[row][col] = mergeCells(grid.matrix[row][col], cell, row, col);
}

function filledRowsForColumn(grid, col) {
	const rows = new Set();
	for (let row = 0; row < grid.matrix.length; row += 1) {
		if (cellHasText(grid.matrix[row]?.[col])) rows.add(row);
	}
	return rows;
}

function filledBboxesForColumn(grid, col) {
	const boxes = [];
	for (let row = 0; row < grid.matrix.length; row += 1) {
		const cell = grid.matrix[row]?.[col];
		if (cellHasText(cell) && cell.bbox) boxes.push(cell.bbox);
	}
	return boxes;
}

function gridFilledBbox(grid) {
	const boxes = [];
	for (let row = 0; row < grid.matrix.length; row += 1) {
		for (let col = 0; col < (grid.matrix[row]?.length || 0); col += 1) {
			const cell = grid.matrix[row][col];
			if (cellHasText(cell) && cell.bbox) boxes.push(cell.bbox);
		}
	}
	return unionBbox(boxes);
}

function columnNeighborOverlap(grid, col, neighborCol) {
	const ownRows = filledRowsForColumn(grid, col);
	const neighborRows = filledRowsForColumn(grid, neighborCol);
	let sharedRows = 0;
	for (const row of ownRows) {
		if (neighborRows.has(row)) sharedRows += 1;
	}
	const ownBbox = unionBbox(filledBboxesForColumn(grid, col));
	const tableBbox = gridFilledBbox(grid);
	const ownSpan = ownBbox ? Math.max(0, ownBbox[3] - ownBbox[1]) : 0;
	const tableSpan = tableBbox ? Math.max(1e-6, tableBbox[3] - tableBbox[1]) : 1;
	return {
		ownRows: ownRows.size,
		neighborRows: neighborRows.size,
		sharedRows,
		overlap: ownRows.size ? sharedRows / ownRows.size : 0,
		spanCoverage: ownSpan / tableSpan,
	};
}

function shouldTrimFringeColumn(overlap, config) {
	if (!overlap.ownRows) return true;
	const unsharedRows = overlap.ownRows - overlap.sharedRows;
	return (
		overlap.overlap < config.fringeMinNeighborOverlap &&
		unsharedRows >= config.fringeMinUnsharedCells &&
		overlap.spanCoverage <= config.fringeMaxSpanCoverage
	);
}

function trimFringeColumns(grid, config) {
	for (let trimmed = 0; trimmed < config.fringeMaxTrimmedCols; trimmed += 1) {
		const cols = grid.matrix[0]?.length || 0;
		if (cols <= 2) break;

		const left = columnNeighborOverlap(grid, 0, 1);
		const right = columnNeighborOverlap(grid, cols - 1, cols - 2);
		const candidates = [
			{ col: 0, edge: 'left', ...left },
			{ col: cols - 1, edge: 'right', ...right },
		].filter((candidate) => shouldTrimFringeColumn(candidate, config));

		if (!candidates.length) break;
		candidates.sort((a, b) => a.overlap - b.overlap || b.ownRows - a.ownRows);
		removeColumn(grid, candidates[0].col);
	}
}

export function fitGrid(result) {
	const config = CONFIG;
	const atoms = result?.atoms || [];
	const rowGroups = resultGroups(result, 'rows');
	const colGroups = resultGroups(result, 'cols');
	const sourceAtoms = filterOrientationOutliers(
		result,
		sourceAtomsFromResult(result),
	);
	const rawRows = rowGroups.length;
	const rawCols = colGroups.length;

	const rowFit = identityAxis(rawRows);
	const rowLineFit = chooseRowLineFit(
		result,
		rowFit,
		sourceAtoms,
		rawRows,
		config,
	);
	const rows = rowLineFit.rows.length
		? rowLineFit.rows
		: rowFit.partitions.map((partition) =>
				partitionGroup(rowGroups, partition, atoms, 'row'),
			);
	const baselineUnits = groupBaselineUnits(sourceAtoms, rowLineFit, config);
	const colFit = fitAxis({
		count: rawCols,
		groups: colGroups,
		cells: baselineUnits,
		axis: 'col',
		orthCount: rows.length,
		atoms,
		config,
	});
	const cols = colFit.partitions.map((partition) =>
		partitionGroup(colGroups, partition, atoms, 'col'),
	);
	const matrix = rows.map((_row, row) =>
		cols.map((_col, col) => createCell(row, col)),
	);
	const grid = { atoms, matrix };

	const fittedCells = baselineUnits
		.map((cell) => ({
			...cell,
			fittedRow: cell.row,
			fittedCol: colFit.map[cell.col],
		}))
		.filter((cell) => cell.fittedRow != null && cell.fittedCol != null)
		.sort((left, right) => left.drawOrder - right.drawOrder);

	for (const cell of fittedCells)
		mergeSourceCellIntoGrid(grid, cell, cell.fittedRow, cell.fittedCol);
	reindexGrid(grid);
	trimFringeColumns(grid, config);

	return {
		grid,
	};
}

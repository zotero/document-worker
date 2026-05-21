import { inferTableGrids } from '../model/table-grid/inference.js';
import { fitGrid } from '../model/table-grid/fit-grid.js';
import { charsToTableAtoms, normalizeAtomsForTableInference } from './input.js';
import { createFallbackTableNode, extractionToTableNode } from './output.js';

const LIMITS = {
	minRows: 2,
	minCols: 2,
	maxRows: 80,
	maxCols: 24,
	maxCells: 1000,
};

function validGrid(grid) {
	const rows = grid?.matrix?.length || 0;
	const cols = grid?.matrix?.[0]?.length || 0;
	return (
		rows >= LIMITS.minRows &&
		cols >= LIMITS.minCols &&
		rows <= LIMITS.maxRows &&
		cols <= LIMITS.maxCols &&
		rows * cols <= LIMITS.maxCells
	);
}

function tableGridCacheKey(normalized) {
	return JSON.stringify([
		normalized.width,
		normalized.height,
		normalized.atoms.map(atom => [
			atom.text,
			atom.bbox,
			atom.baseline,
			atom.font_size,
			atom.rotation,
			atom.bold,
			atom.italic,
			atom.font_id,
			atom.color,
			atom.draw_order,
			atom.writing_mode,
			atom.direction,
		]),
	]);
}

export async function extractStructuredTable({
	pageIndex,
	viewBox,
	block,
	chars,
	onnxRuntimeProvider,
	modelProvider,
	tableGridCache,
}) {
	return (await extractStructuredTables([{
		pageIndex,
		viewBox,
		block,
		chars,
		onnxRuntimeProvider,
		modelProvider,
		tableGridCache,
	}]))[0];
}

export async function extractStructuredTables(requests) {
	const nodes = new Array(requests.length);
	const pending = [];
	const pendingByCacheKey = new Map();

	for (let index = 0; index < requests.length; index++) {
		const request = requests[index];
		const {
			pageIndex,
			viewBox,
			block,
			chars,
			tableGridCache,
		} = request;

		const fallback = () => createFallbackTableNode({ pageIndex, block, chars });
		const atoms = charsToTableAtoms(chars, viewBox);
		if (atoms.length < 2) {
			nodes[index] = fallback();
			continue;
		}

		try {
			const normalized = normalizeAtomsForTableInference(atoms, viewBox);
			let cacheKey = null;
			let cached = null;
			if (tableGridCache) {
				cacheKey = tableGridCacheKey(normalized);
				cached = tableGridCache.get(cacheKey);
			}
			if (cached) {
				nodes[index] = cached.valid
					? extractionToTableNode({
						pageIndex,
						block,
						chars,
						atoms: normalized.atoms,
						grid: cached.grid,
					})
					: fallback();
				continue;
			}

			const target = {
				index,
				request,
				normalized,
				fallback,
			};
			let pendingItem = cacheKey ? pendingByCacheKey.get(cacheKey) : null;
			if (pendingItem) {
				pendingItem.targets.push(target);
			}
			else {
				pendingItem = {
					request,
					normalized,
					cacheKey,
					targets: [target],
				};
				pending.push(pendingItem);
				if (cacheKey) {
					pendingByCacheKey.set(cacheKey, pendingItem);
				}
			}
		}
		catch {
			nodes[index] = fallback();
		}
	}

	if (pending.length) {
		const { onnxRuntimeProvider, modelProvider } = pending[0].request;
		let rawResults = null;
		try {
			rawResults = await inferTableGrids(
				pending.map(item => ({
					width: item.normalized.width,
					height: item.normalized.height,
					atoms: item.normalized.atoms,
				})),
				onnxRuntimeProvider,
				modelProvider,
			);
		}
		catch {
			rawResults = await Promise.all(pending.map(async item => {
				try {
					return (await inferTableGrids([{
						width: item.normalized.width,
						height: item.normalized.height,
						atoms: item.normalized.atoms,
					}], onnxRuntimeProvider, modelProvider))[0];
				}
				catch {
					return null;
				}
			}));
		}

		for (let pendingIndex = 0; pendingIndex < pending.length; pendingIndex++) {
			const item = pending[pendingIndex];

			try {
				if (!rawResults?.[pendingIndex]) {
					for (let target of item.targets) {
						nodes[target.index] = target.fallback();
					}
					continue;
				}
				const { grid } = fitGrid(rawResults[pendingIndex]);
				const cached = {
					grid,
					valid: validGrid(grid),
				};
				if (item.request.tableGridCache) {
					item.request.tableGridCache.set(item.cacheKey, cached);
				}
				for (let target of item.targets) {
					const { pageIndex, block, chars } = target.request;
					nodes[target.index] = cached.valid
						? extractionToTableNode({
							pageIndex,
							block,
							chars,
							atoms: target.normalized.atoms,
							grid,
						})
						: target.fallback();
				}
			}
			catch {
				for (let target of item.targets) {
					nodes[target.index] = target.fallback();
				}
			}
		}
	}

	return nodes;
}

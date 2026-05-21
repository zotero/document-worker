import { getRuntime } from '../onnx/runtime.js';
import { createCompactTableRuntime } from './runtime.js';

let runtimePromise = null;

async function createRuntime(onnxRuntimeProvider, modelProvider) {
	const ort = await getRuntime(onnxRuntimeProvider);
	const [singleScorer, rowMerge, colMerge] = await Promise.all([
		modelProvider('table-grid/samecell_aux_dynamic.compact.int8.onnx'),
		modelProvider('table-grid/axis_row_merger_mlp.compact.int8.onnx'),
		modelProvider('table-grid/axis_col_merger_mlp.compact.int8.onnx'),
	]);
	return createCompactTableRuntime({
		ort,
		models: {
			singleScorer,
			rowMerge,
			colMerge,
		},
	});
}

async function getTableGridRuntime(onnxRuntimeProvider, modelProvider) {
	if (!runtimePromise) {
		runtimePromise = createRuntime(onnxRuntimeProvider, modelProvider);
	}
	return runtimePromise;
}

export async function inferTableGrid(page, onnxRuntimeProvider, modelProvider) {
	const runtime = await getTableGridRuntime(onnxRuntimeProvider, modelProvider);
	return runtime.infer(page);
}

export async function inferTableGrids(
	pages,
	onnxRuntimeProvider,
	modelProvider,
) {
	const runtime = await getTableGridRuntime(onnxRuntimeProvider, modelProvider);
	const results = new Array(pages.length);
	for (let index = 0; index < pages.length; index++) {
		results[index] = await runtime.infer(pages[index]);
	}
	return results;
}

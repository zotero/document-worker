import * as ort from './ort.wasm.min.js';
import { Mutex } from '../../../mutex.js';

export let onnxMutex = new Mutex()

export async function getRuntime(onnxRuntimeProvider) {
	return await onnxMutex.runExclusive(async () => {
		ort.env.wasm.simd = true;
		ort.env.wasm.numThreads = 1;
		ort.env.wasm.proxy = false;
		ort.env.allowLocalModels = false;
		ort.env.wasm.wasmBinary = await onnxRuntimeProvider();
		ort.env.wasm.wasmPaths = null;
		return ort;
	});
}

// import * as ort from 'onnxruntime-node';
// import { Mutex } from '../../../mutex.js';
//
// export let onnxMutex = new Mutex();
//
// export async function getRuntime() {
// 	return onnxMutex.runExclusive(async () => {
// 		// No WASM env tweaks in Node – just return the module.
// 		return ort;
// 	});
// }

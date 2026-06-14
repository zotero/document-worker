class NativeTensor {
	constructor(type, data, dims) {
		this.type = type;
		this.data = data;
		this.dims = dims;
	}
}

class NativeInferenceSession {
	constructor(model, nativeONNXRun) {
		this.model = model;
		this.nativeONNXRun = nativeONNXRun;
	}

	static async create(model, _options) {
		const modelName = model?.nativeONNXModel;
		const nativeONNXRun = model?.nativeONNXRun;
		if (!modelName || typeof nativeONNXRun !== 'function') {
			throw new Error('Native ONNX sessions require a native model provider');
		}
		return new NativeInferenceSession(modelName, nativeONNXRun);
	}

	async run(feeds, outputNames) {
		const inputs = Object.entries(feeds).map(([name, tensor]) => ({
			name,
			type: tensor.type,
			dims: Array.from(tensor.dims),
			values: serializeTensorValues(tensor),
		}));
		const result = await this.nativeONNXRun({
			model: this.model,
			inputs,
			outputNames: outputNames ?? null,
		});
		return deserializeOutputs(result?.outputs);
	}

	async release() {
		// Native sessions are cached and owned by the host runtime.
	}
}

export function createNativeRuntime(nativeONNXRun) {
	return {
		Tensor: NativeTensor,
		InferenceSession: {
			create: (model, options) => NativeInferenceSession.create({
				...model,
				nativeONNXRun,
			}, options),
		},
	};
}

function serializeTensorValues(tensor) {
	if (tensor.type === 'int64' && typeof BigInt64Array !== 'undefined' && tensor.data instanceof BigInt64Array) {
		return Array.from(tensor.data, Number);
	}
	return Array.from(tensor.data);
}

function deserializeOutputs(outputs) {
	if (!outputs || typeof outputs !== 'object') {
		throw new Error('Native ONNX did not return outputs');
	}
	const result = {};
	for (const [name, output] of Object.entries(outputs)) {
		result[name] = new NativeTensor(output.type, typedArray(output.type, output.values), output.dims);
	}
	return result;
}

function typedArray(type, values) {
	switch (type) {
		case 'float32':
			return Float32Array.from(values);

		case 'int64':
			if (typeof BigInt64Array === 'undefined') {
				throw new Error('BigInt64Array is not available');
			}
			return BigInt64Array.from(values.map(BigInt));

		case 'bool':
			return Uint8Array.from(values);

		default:
			throw new Error(`Unsupported native ONNX output type: ${type}`);
	}
}

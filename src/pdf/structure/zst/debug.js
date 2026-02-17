/**
 * Debug utilities for comparing run optimization errors.
 */

import { reconstructCharPositions } from './decode.js';

/**
 * Compares reconstruction errors between original and optimized runs.
 */
export function compareRunErrors(originalRun, optimizedRun) {
	const origPos = reconstructCharPositions(originalRun);
	const optPos = reconstructCharPositions(optimizedRun);

	if (origPos.length !== optPos.length) {
		throw new Error('Run length mismatch after optimization');
	}

	let maxX1Err = 0, maxX2Err = 0, sumX1Err = 0, sumX2Err = 0;
	const charErrors = origPos.map((orig, i) => {
		const opt = optPos[i];
		const x1Err = Math.abs(opt.x1 - orig.x1);
		const x2Err = Math.abs(opt.x2 - orig.x2);

		maxX1Err = Math.max(maxX1Err, x1Err);
		maxX2Err = Math.max(maxX2Err, x2Err);
		sumX1Err += x1Err;
		sumX2Err += x2Err;

		return { index: i, original: orig, optimized: opt, x1Error: x1Err, x2Error: x2Err };
	});

	const n = origPos.length;
	return {
		charCount: n,
		maxX1Error: maxX1Err,
		maxX2Error: maxX2Err,
		maxError: Math.max(maxX1Err, maxX2Err),
		avgX1Error: n > 0 ? sumX1Err / n : 0,
		avgX2Error: n > 0 ? sumX2Err / n : 0,
		charErrors,
	};
}

/**
 * Prints optimization error report.
 */
export function printOptimizationReport(originalRun, optimizedRun, maxError = null) {
	const cmp = compareRunErrors(originalRun, optimizedRun);
	const valid = maxError !== null ? cmp.maxError <= maxError + 1e-9 : null;

	console.log('═══════════════════════════════════════════════════');
	console.log('         RUN OPTIMIZATION ERROR REPORT             ');
	console.log('═══════════════════════════════════════════════════');

	if (maxError !== null) {
		console.log(`Max allowed error: ${maxError}`);
		console.log(`Validation: ${valid ? '✓ PASSED' : '✗ FAILED'}`);
	}

	console.log('───────────────────────────────────────────────────');
	console.log(`Characters: ${cmp.charCount}`);
	console.log(`Max X1 error: ${cmp.maxX1Error.toFixed(6)}`);
	console.log(`Max X2 error: ${cmp.maxX2Error.toFixed(6)}`);
	console.log(`Max overall: ${cmp.maxError.toFixed(6)}`);
	console.log(`Avg X1 error: ${cmp.avgX1Error.toFixed(6)}`);
	console.log(`Avg X2 error: ${cmp.avgX2Error.toFixed(6)}`);
	console.log('───────────────────────────────────────────────────');
	console.log('Original:', JSON.stringify(originalRun));
	console.log('Optimized:', JSON.stringify(optimizedRun));
	console.log('───────────────────────────────────────────────────');

	for (const e of cmp.charErrors) {
		const s1 = maxError !== null ? (e.x1Error <= maxError ? '✓' : '✗') : '';
		const s2 = maxError !== null ? (e.x2Error <= maxError ? '✓' : '✗') : '';
		console.log(
			`  [${e.index}] x1: ${e.original.x1.toFixed(3)} → ${e.optimized.x1.toFixed(3)} ` +
			`(${e.x1Error.toFixed(4)}) ${s1} | ` +
			`x2: ${e.original.x2.toFixed(3)} → ${e.optimized.x2.toFixed(3)} ` +
			`(${e.x2Error.toFixed(4)}) ${s2}`
		);
	}
	console.log('═══════════════════════════════════════════════════');

	return { isValid: valid, comparison: cmp };
}
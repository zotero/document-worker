// Node.js ESM resolve hook for pdf.js bare module specifiers.
// These are normally resolved by pdf.js's gulp build, but when importing
// from source directly, Node.js needs help resolving them.
// Registered by pdfjs-setup.js via node:module register().

import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pdfjsDisplay = path.resolve(__dirname, '../pdf.js/src/display');
const pdfjsSrc = path.resolve(__dirname, '../pdf.js/src');

const aliases = {
	'display-node_utils': path.join(pdfjsDisplay, 'node_utils.js'),
	'display-binary_data_factory': path.join(pdfjsDisplay, 'binary_data_factory.js'),
	'display-network_stream': path.join(pdfjsDisplay, 'network_stream.js'),
	'display-cmap_reader_factory': path.join(pdfjsDisplay, 'cmap_reader_factory.js'),
	'display-standard_fontdata_factory': path.join(pdfjsDisplay, 'standard_fontdata_factory.js'),
	'display-wasm_factory': path.join(pdfjsDisplay, 'wasm_factory.js'),
	'display-fetch_stream': path.join(pdfjsDisplay, 'fetch_stream.js'),
	'display-network': path.join(pdfjsDisplay, 'network.js'),
	'display-node_stream': path.join(pdfjsDisplay, 'node_stream.js'),
	'pdfjs/pdf.worker.js': path.join(pdfjsSrc, 'pdf.worker.js'),
};

export async function resolve(specifier, context, nextResolve) {
	if (specifier in aliases) {
		return {
			shortCircuit: true,
			url: pathToFileURL(aliases[specifier]).href,
		};
	}
	try {
		return await nextResolve(specifier, context);
	}
	catch (err) {
		if (isRelativeExtensionlessSpecifier(specifier)) {
			for (let candidate of getExtensionCandidates(specifier)) {
				try {
					return await nextResolve(candidate, context);
				}
				catch {
					// Try the next extension candidate before surfacing the original error.
				}
			}
		}
		throw err;
	}
}

function isRelativeExtensionlessSpecifier(specifier) {
	return (specifier.startsWith('./') || specifier.startsWith('../'))
		&& path.extname(specifier) === '';
}

function getExtensionCandidates(specifier) {
	return [
		`${specifier}.js`,
		`${specifier}.ts`,
		`${specifier}/index.js`,
		`${specifier}/index.ts`,
	];
}

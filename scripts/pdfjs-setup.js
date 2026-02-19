// Setup script for running pdf.js source directly in Node.js.
// Use with: node --import ./scripts/pdfjs-setup.js

import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

// Define PDFJSDev globally so pdf.js source code behaves like the lib-legacy
// build (GENERIC: true, LIB: true, SKIP_BABEL: false, TESTING: false).
const FLAGS = {
	GENERIC: true,
	LIB: true,
	SKIP_BABEL: false,
	TESTING: false,
	MOZCENTRAL: false,
	CHROME: false,
	IMAGE_DECODERS: false,
};

const EVALS = {
	BUNDLE_VERSION: null,
	BUNDLE_BUILD: null,
};

globalThis.PDFJSDev = {
	test(expr) {
		return expr.split('||').some(part => {
			part = part.trim();
			const negated = part.startsWith('!');
			if (negated) part = part.slice(1).trim();
			const val = FLAGS[part] ?? false;
			return negated ? !val : val;
		});
	},
	eval(expr) {
		return EVALS[expr] ?? null;
	},
};

// Polyfill `self` for Node.js (used by renderer.js for web worker compat)
if (typeof globalThis.self === 'undefined') {
	globalThis.self = globalThis;
}

// Register the ESM resolve hook for bare module specifiers
register('./pdfjs-resolve.js', import.meta.url);

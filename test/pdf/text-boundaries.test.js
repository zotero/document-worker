import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getStructuredChars } from '../../pdf.js/src/core/module/structure.js';
import { charsToTextNodes } from '../../structured-document-text/src/pdf/encode.js';

function makeWrappedChars(separator) {
	const common = {
		rotation: 0,
		fontSize: 10,
		fontName: 'Test',
	};
	return [
		{ ...common, c: 'a', rect: [0, 10, 5, 20], baseline: 10 },
		{ ...common, c: separator, rect: [5, 10, 10, 20], baseline: 10 },
		{ ...common, c: 'b', rect: [0, 0, 5, 10], baseline: 0 },
	];
}

function makeSpacedWrappedChars(separator) {
	const chars = makeWrappedChars(separator);
	chars[0].spaceAfter = true;
	return chars;
}

describe('PDF text boundaries', () => {
	it('keeps semantic dash punctuation at line endings', () => {
		for (const separator of ['\u2012', '\u2013', '\u2014']) {
			const chars = getStructuredChars(makeWrappedChars(separator));

			assert.equal(chars[1].lineBreakAfter, true);
			assert.notEqual(chars[1].ignorable, true);
			assert.equal(
				charsToTextNodes(0, chars).map(node => node.text).join(''),
				`a${separator}b`,
			);
		}
	});

	it('preserves symmetric spacing around a line-ending dash', () => {
		const chars = getStructuredChars(makeSpacedWrappedChars('\u2014'));

		assert.equal(
			charsToTextNodes(0, chars).map(node => node.text).join(''),
			'a — b',
		);
	});

	it('continues treating a line-ending hyphen as discretionary', () => {
		const chars = getStructuredChars(makeWrappedChars('-'));

		assert.equal(chars[1].ignorable, true);
		assert.equal(
			charsToTextNodes(0, chars).map(node => node.text).join(''),
			'ab',
		);
	});

});

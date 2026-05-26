import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mergeParagraphs } from '../../src/pdf/structure/block-cleanup.js';
import { mergeBlocks } from '../../structured-document-text/src/pdf/block-transform.js';

function paragraph(pageIndex, text, overrides = {}) {
	return {
		type: 'paragraph',
		content: [{ text }],
		_metrics: {
			pageIndex,
			rect: [0, 0, 100, 10],
			firstLineIndent: 0,
			firstChar: text[0],
			lastLineRag: 0,
			lastChar: text.at(-1),
			...overrides,
		},
	};
}

function getMergeGroups(structure) {
	let mergeGroups = [];
	mergeParagraphs(structure, (_structure, groups) => {
		mergeGroups = groups;
		return _structure;
	});
	return mergeGroups;
}

function blockText(block) {
	return block.content
		.filter(node => node && typeof node.text === 'string')
		.map(node => node.text)
		.join('');
}

describe('mergeParagraphs', () => {
	it('keeps normal cross-page paragraph continuations', () => {
		let structure = {
			catalog: { pages: [{}, {}] },
			content: [
				paragraph(0, 'alpha'),
				paragraph(1, 'beta'),
			],
		};

		assert.deepEqual(getMergeGroups(structure), [[0, 1]]);
	});

	it('does not merge paragraphs across a degraded extraction page boundary', () => {
		let structure = {
			catalog: { pages: [{ extractionDegraded: true }, {}] },
			content: [
				paragraph(0, 'alpha'),
				paragraph(1, 'beta'),
			],
		};

		assert.deepEqual(getMergeGroups(structure), []);
	});

	it('still allows same-page paragraph cleanup on degraded extraction pages', () => {
		let structure = {
			catalog: { pages: [{ extractionDegraded: true }] },
			content: [
				paragraph(0, 'alpha'),
				paragraph(0, 'beta'),
			],
		};

		assert.deepEqual(getMergeGroups(structure), [[0, 1]]);
	});

	it('inserts a word boundary when non-hyphenated paragraph continuations merge', () => {
		let structure = {
			catalog: { pages: [{ contentRanges: [[[0, 0], [1, 0]]] }] },
			content: [
				paragraph(0, 'programming'),
				paragraph(0, 'and is used'),
			],
		};

		mergeParagraphs(structure, mergeBlocks);

		assert.equal(structure.content[0].content[0].text, 'programming and is used');
	});

	it('does not insert a word boundary when the previous textMap ends with a soft hyphen', () => {
		let structure = {
			catalog: { pages: [{ contentRanges: [[[0, 0], [1, 0]]] }] },
			content: [
				paragraph(0, 'hyphen', {
					lastChar: 'n',
				}),
				paragraph(0, 'ated'),
			],
		};
		structure.content[0].content[0].anchor = {
			textMap: JSON.stringify([[1, 0, 0, 0, 10, 10, 10]]),
		};

		mergeParagraphs(structure, mergeBlocks);

		assert.equal(blockText(structure.content[0]), 'hyphenated');
	});
});

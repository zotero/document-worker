import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mergeParagraphs } from '../../src/pdf/structure/block-cleanup.js';

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
});

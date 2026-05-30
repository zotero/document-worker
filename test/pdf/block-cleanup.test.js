import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { markListItemParts, markParagraphParts } from '../../src/pdf/structure/block-cleanup.js';
import { normalizePdfRawBlockFlow, normalizeTopLevelFlowClasses } from '../../src/pdf/structure/flow-policy.js';
import { wrapListItems } from '../../src/pdf/structure/list-utils.js';
import { postProcessStructure } from '../../src/pdf/structure/post-process.js';
import { getFulltextFromStructuredText } from '../../structured-document-text/src/fulltext.js';
import { getPageBlockSpan } from '../../structured-document-text/src/pages.js';
import { getLogicalBlockText } from '../../structured-document-text/src/parts.js';

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

function listItem(pageIndex, text, overrides = {}) {
	return {
		type: 'listitem',
		content: [{ text }],
		_metrics: {
			pageIndex,
			firstChar: text[0],
			lastChar: text.at(-1),
			...overrides,
		},
	};
}

describe('PDF flow policy', () => {
	it('normalizes excluded raw blocks to body blocks for paragraph output', () => {
		for (const type of ['caption', 'image', 'table', 'list_item', 'equation', 'preformatted']) {
			const block = { type, flowClass: 'excluded' };

			normalizePdfRawBlockFlow(block);

			assert.equal(block.type, 'body');
			assert.equal(block.flowClass, 'excluded');
		}
	});

	it('omits raw body flow without changing structural type', () => {
		const block = { type: 'table', flowClass: 'body' };

		normalizePdfRawBlockFlow(block);

		assert.equal(block.type, 'table');
		assert.equal(block.flowClass, undefined);
	});
});

describe('markParagraphParts', () => {
	it('keeps normal cross-page paragraph continuations', () => {
		let structure = {
			catalog: { pages: [{}, {}] },
			content: [
				paragraph(0, 'alpha'),
				paragraph(1, 'beta'),
			],
		};

		markParagraphParts(structure);

		assert.deepEqual(structure.content[0].nextPart, [1]);
		assert.deepEqual(structure.content[1].previousPart, [0]);
	});

	it('does not merge paragraphs across a degraded extraction page boundary', () => {
		let structure = {
			catalog: { pages: [{ extractionDegraded: true }, {}] },
			content: [
				paragraph(0, 'alpha'),
				paragraph(1, 'beta'),
			],
		};

		markParagraphParts(structure);

		assert.equal(structure.content[0].nextPart, undefined);
		assert.equal(structure.content[1].previousPart, undefined);
	});

	it('still allows same-page paragraph cleanup on degraded extraction pages', () => {
		let structure = {
			catalog: { pages: [{ extractionDegraded: true }] },
			content: [
				paragraph(0, 'alpha'),
				paragraph(0, 'beta'),
			],
		};

		markParagraphParts(structure);

		assert.deepEqual(structure.content[0].nextPart, [1]);
		assert.deepEqual(structure.content[1].previousPart, [0]);
	});

	it('uses a word boundary for non-hyphenated logical paragraph continuations', () => {
		let structure = {
			catalog: { pages: [{ contentRange: [[0], [2]] }] },
			content: [
				paragraph(0, 'programming'),
				paragraph(0, 'and is used'),
			],
		};

		markParagraphParts(structure);

		assert.equal(getLogicalBlockText(structure, [0]), 'programming and is used');
		assert.equal(structure.content.length, 2);
	});

	it('links hyphenated paragraph parts across a clean page boundary', () => {
		let structure = {
			catalog: { pages: [{}, {}] },
			content: [
				paragraph(0, 'hyphen-', { lastChar: '-' }),
				paragraph(1, 'ated'),
			],
		};

		markParagraphParts(structure);

		assert.deepEqual(structure.content[0].nextPart, [1]);
		assert.deepEqual(structure.content[1].previousPart, [0]);
		assert.equal(getLogicalBlockText(structure, [0]), 'hyphenated');
	});

	it('links one-line cross-page continuation even when its text bbox is short', () => {
		let structure = {
			catalog: { pages: [{}, {}] },
			content: [
				paragraph(0, 'values were', {
					rect: [0, 0, 466, 100],
					lineCount: 10,
					lastLineRag: 0.04,
					lastChar: 'e',
				}),
				paragraph(1, 'observed to be 3.32.', {
					rect: [0, 0, 252, 10],
					lineCount: 1,
					firstLineIndent: 0,
					firstChar: 'o',
				}),
			],
		};

		markParagraphParts(structure);

		assert.deepEqual(structure.content[0].nextPart, [1]);
		assert.deepEqual(structure.content[1].previousPart, [0]);
		assert.equal(getLogicalBlockText(structure, [0]), 'values were observed to be 3.32.');
	});

	it('does not link same-page paragraphs with mismatched widths', () => {
		let structure = {
			catalog: { pages: [{}] },
			content: [
				paragraph(0, 'values were', {
					rect: [0, 0, 466, 100],
					lineCount: 10,
				}),
				paragraph(0, 'observed to be 3.32.', {
					rect: [0, 0, 252, 10],
					lineCount: 1,
				}),
			],
		};

		markParagraphParts(structure);

		assert.equal(structure.content[0].nextPart, undefined);
		assert.equal(structure.content[1].previousPart, undefined);
	});

	it('links body paragraph parts across non-body interstitial blocks', () => {
		let structure = {
			catalog: { pages: [{ contentRange: [[0], [5]] }] },
			content: [
					{ ...paragraph(0, 'programming'), flowClass: 'body' },
					{ ...paragraph(0, 'Permission text.'), flowClass: 'auxiliary' },
					{ ...paragraph(0, 'Footer text.'), flowClass: 'excluded' },
					{ ...paragraph(0, 'Excluded text.'), flowClass: 'excluded' },
					{ ...paragraph(0, 'and is used'), flowClass: 'body' },
			],
		};

		markParagraphParts(structure);

		assert.deepEqual(structure.content[0].nextPart, [4]);
		assert.deepEqual(structure.content[4].previousPart, [0]);
		assert.equal(getLogicalBlockText(structure, [0]), 'programming and is used');
	});

	it('does not link through another body flow block', () => {
		let structure = {
			catalog: { pages: [{ contentRange: [[0], [3]] }] },
			content: [
				{ ...paragraph(0, 'programming'), flowClass: 'body' },
				{ ...paragraph(0, 'Body barrier.'), flowClass: 'body' },
				{ ...paragraph(0, 'and is used'), flowClass: 'body' },
			],
		};

		markParagraphParts(structure);

		assert.equal(structure.content[0].nextPart, undefined);
		assert.equal(structure.content[2].previousPart, undefined);
	});

	it('uses textMap soft-hyphen state when reading logical paragraph continuations', () => {
		let structure = {
			catalog: { pages: [{ contentRange: [[0], [2]] }] },
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

		markParagraphParts(structure);

		assert.equal(getLogicalBlockText(structure, [0]), 'hyphenated');
		assert.equal(structure.content.length, 2);
	});
});

describe('wrapListItems page ranges', () => {
	it('does not leak the first wrapped list item into the previous page', () => {
		let structure = {
			catalog: {
				pages: [
					{ contentRange: [[0], [1]] },
					{ contentRange: [[1], [3]] },
				],
			},
			content: [
				paragraph(0, 'Before list'),
				{
					type: 'listitem',
					_metrics: { pageIndex: 1 },
					content: [{ text: 'First item' }],
				},
				{
					type: 'listitem',
					_metrics: { pageIndex: 1 },
					content: [{ text: 'Second item' }],
				},
			],
		};

		wrapListItems(structure);

		assert.deepEqual(structure.catalog.pages[0].contentRange, [[0], [1]]);
		assert.deepEqual(getPageBlockSpan(structure, 0), { startIndex: 0, endIndexExclusive: 1 });
		assert.equal(getFulltextFromStructuredText(structure, [0]), 'Before list');
		assert.equal(getFulltextFromStructuredText(structure, [1]), 'First item\nSecond item');
	});

	it('preserves nested boundaries when a page splits inside a wrapped list', () => {
		let structure = {
			catalog: {
				pages: [
					{ contentRange: [[0], [2]] },
					{ contentRange: [[2], [3]] },
				],
			},
			content: [
				{
					type: 'listitem',
					_metrics: { pageIndex: 0 },
					content: [{ text: 'First item' }],
				},
				{
					type: 'listitem',
					_metrics: { pageIndex: 0 },
					content: [{ text: 'Second item' }],
				},
				{
					type: 'listitem',
					_metrics: { pageIndex: 1 },
					content: [{ text: 'Third item' }],
				},
			],
		};

		wrapListItems(structure);

		assert.deepEqual(structure.catalog.pages[0].contentRange, [[0], [1]]);
		assert.deepEqual(structure.catalog.pages[1].contentRange, [[1], [2]]);
		assert.equal(getFulltextFromStructuredText(structure, [0]), 'First item\nSecond item');
		assert.equal(getFulltextFromStructuredText(structure, [1]), 'Third item');
	});

	it('sets wrapped list flow class from the item majority', () => {
		let structure = {
			catalog: { pages: [{ contentRange: [[0], [3]] }] },
			content: [
				{
					type: 'listitem',
					flowClass: 'body',
					_metrics: { pageIndex: 0 },
					content: [{ text: 'First item' }],
				},
				{
					type: 'listitem',
					flowClass: 'auxiliary',
					_metrics: { pageIndex: 0 },
					content: [{ text: 'Second item' }],
				},
				{
					type: 'listitem',
					flowClass: 'auxiliary',
					_metrics: { pageIndex: 0 },
					content: [{ text: 'Third item' }],
				},
			],
		};

		wrapListItems(structure);

		assert.equal(structure.content[0].type, 'list');
		assert.equal(structure.content[0].flowClass, 'auxiliary');
	});
});

describe('normalizeTopLevelFlowClasses', () => {
	it('omits body flow and removes flow class from nested blocks', () => {
		const structure = {
			content: [
				{
					type: 'paragraph',
					flowClass: 'body',
					content: [{ text: 'Body' }],
				},
				{
					type: 'list',
					flowClass: 'auxiliary',
					content: [
						{
							type: 'listitem',
							flowClass: 'auxiliary',
							content: [{ text: 'Item' }],
						},
					],
				},
			],
		};

		normalizeTopLevelFlowClasses(structure);

		assert.equal(structure.content[0].flowClass, undefined);
		assert.equal(structure.content[1].flowClass, 'auxiliary');
		assert.equal(structure.content[1].content[0].flowClass, undefined);
	});
});

describe('postProcessStructure', () => {
	it('degrades a single-item list into a paragraph', () => {
		const structure = {
			content: [
				{
					type: 'list',
					anchor: { pageRects: [[0, 10, 10, 20, 20]] },
					content: [
						{
							type: 'listitem',
							anchor: { pageRects: [[0, 11, 11, 19, 19]] },
							content: [{ text: 'Not really a list' }],
							flowClass: 'body',
							_metrics: { pageIndex: 0 },
						},
					],
				},
			],
		};

		postProcessStructure(structure);

		assert.deepEqual(structure.content, [
			{
				type: 'paragraph',
				anchor: { pageRects: [[0, 11, 11, 19, 19]] },
				content: [{ text: 'Not really a list' }],
				flowClass: 'body',
				_metrics: { pageIndex: 0 },
			},
		]);
	});

	it('keeps multi-item lists intact', () => {
		const structure = {
			content: [
				{
					type: 'list',
					content: [
						{ type: 'listitem', content: [{ text: 'First' }] },
						{ type: 'listitem', content: [{ text: 'Second' }] },
					],
				},
			],
		};

		postProcessStructure(structure);

		assert.equal(structure.content[0].type, 'list');
		assert.equal(structure.content[0].content.length, 2);
	});
});

describe('markListItemParts', () => {
	it('links split list items across a clean page boundary', () => {
		let structure = {
			catalog: {
				pages: [
					{ contentRange: [[0], [1]] },
					{ contentRange: [[1], [2]] },
				],
			},
			content: [
				listItem(0, 'hyphen-'),
				listItem(1, 'ated'),
			],
		};

		wrapListItems(structure);
		markListItemParts(structure);

		assert.deepEqual(structure.content[0].content[0].nextPart, [1, 0]);
		assert.deepEqual(structure.content[1].content[0].previousPart, [0, 0]);
	});

	it('does not link split list items across a degraded extraction page boundary', () => {
		let structure = {
			catalog: {
				pages: [
					{ contentRange: [[0], [1]], extractionDegraded: true },
					{ contentRange: [[1], [2]] },
				],
			},
			content: [
				listItem(0, 'hyphen-'),
				listItem(1, 'ated'),
			],
		};

		wrapListItems(structure);
		markListItemParts(structure);

		assert.equal(structure.content[0].content[0].nextPart, undefined);
		assert.equal(structure.content[1].content[0].previousPart, undefined);
	});

	it('does not link list items through real intervening content', () => {
		let structure = {
			catalog: {
				pages: [
					{ contentRange: [[0], [2]] },
					{ contentRange: [[2], [3]] },
				],
			},
			content: [
				{
					type: 'listitem',
					_metrics: {
						pageIndex: 0,
						firstChar: 'h',
						lastChar: '-',
					},
					content: [{ text: 'hyphen-' }],
				},
				paragraph(0, 'Intervening paragraph.'),
				{
					type: 'listitem',
					_metrics: {
						pageIndex: 1,
						firstChar: 'a',
						lastChar: 'd',
					},
					content: [{ text: 'ated' }],
				},
			],
		};

		wrapListItems(structure);
		markListItemParts(structure);

		assert.equal(structure.content[0].content[0].nextPart, undefined);
		assert.equal(structure.content[2].content[0].previousPart, undefined);
		assert.equal(getFulltextFromStructuredText(structure, [0, 1]), 'hyphen-\n\nIntervening paragraph.\n\nated');
	});
});

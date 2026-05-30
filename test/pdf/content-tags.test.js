import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getContent, getRefRangesFromPageRects } from '../../structured-document-text/src/pdf/content.js';

describe('getContent JSON format', () => {
	it('returns block JSON with refs and sentence entries', () => {
		const structure = {
			content: [
				{
					type: 'paragraph',
					content: [{ text: 'Hello world. Second sentence.' }],
				},
				{
					type: 'list',
					content: [
						{ type: 'listitem', content: [{ text: 'First item' }] },
					],
				},
			],
		};

		const actual = getContent(structure, [
			[[0], [2]],
		]);

		assert.deepEqual(actual,[
			{
				type: 'paragraph',
				ref: '0',
				content: [
					{ sid: 0, text: 'Hello world.' },
					{ sid: 1, text: 'Second sentence.' },
				],
			},
			{
				type: 'list',
				ref: '1',
				content: [
					{
						type: 'listitem',
						ref: '1.0',
						content: [{ sid: 0, text: 'First item' }],
					},
				],
			},
		]);
	});

	it('does not emit inline style metadata in content payload', () => {
		const structure = {
			content: [
				{
					type: 'paragraph',
					content: [
						{ text: 'Bold', style: { bold: true } },
						{ text: ' Italic', style: { italic: true } },
						{ text: ' Code', style: { code: true } },
						{ text: ' Sup', style: { sup: true } },
						{ text: ' Sub', style: { sub: true } },
					],
				},
			],
		};

		const actual = getContent(structure, [
			[[0], [1]],
		]);

		assert.deepEqual(actual,[
			{
				type: 'paragraph',
				ref: '0',
				content: [{ sid: 0, text: 'Bold Italic Code Sup Sub' }],
			},
		]);
	});

	it('returns empty array for empty structure', () => {
		assert.deepEqual(getContent(null, []), []);
		assert.deepEqual(getContent({ content: [] }, []), []);
	});

	it('trims leading and trailing whitespace in block and sentence text', () => {
		const structure = {
			content: [
				{
					type: 'title',
					content: [{ text: '   A Title   ' }],
				},
				{
					type: 'paragraph',
					content: [{ text: '  First sentence.  Second sentence.  ' }],
				},
			],
		};

		const actual = getContent(structure, [
			[[0], [2]],
		]);

		assert.deepEqual(actual,[
			{
				type: 'title',
				ref: '0',
				content: [{ sid: 0, text: 'A Title' }],
			},
			{
				type: 'paragraph',
				ref: '1',
				content: [
					{ sid: 0, text: 'First sentence.' },
					{ sid: 1, text: 'Second sentence.' },
				],
			},
		]);
	});

	it('skips excluded flow nodes in sequence', () => {
		const structure = {
			content: [
				{ type: 'paragraph', content: [{ text: 'First.' }] },
				{ type: 'paragraph', other: true, content: [{ text: 'Other node.' }] },
				{ type: 'paragraph', flowClass: 'excluded', content: [{ text: 'Excluded.' }] },
				{ type: 'paragraph', content: [{ text: 'After excluded.' }] },
			],
		};

		const actual = getContent(structure, []);

		assert.deepEqual(actual,[
			{ type: 'paragraph', ref: '0', content: [{ sid: 0, text: 'First.' }] },
			{ type: 'paragraph', ref: '1', content: [{ sid: 0, text: 'Other node.' }] },
			{ type: 'paragraph', ref: '3', content: [{ sid: 0, text: 'After excluded.' }] },
		]);
	});

	it('treats identical start and end refs as an empty half-open range', () => {
		const structure = {
			content: [
				{ type: 'paragraph', content: [{ text: 'First.' }] },
			],
		};

		assert.deepEqual(getContent(structure, [
			[[0], [0]],
		]), []);
	});

	it('coalesces overlapping text selections before emitting content', () => {
		const structure = {
			content: [
				{ type: 'paragraph', content: [{ text: 'abcdef' }] },
			],
		};

		assert.deepEqual(getContent(structure, [
			[[0, 0, 1], [0, 0, 4]],
			[[0, 0, 2], [0, 0, 5]],
		]), [{
			type: 'paragraph',
			ref: '0',
			content: [{ sid: 0, text: 'bcde' }],
		}]);
	});

	it('returns half-open ranges from page rect hits', () => {
		const structure = {
			catalog: {
				pages: [
					{ contentRange: [[0], [2]] },
				],
			},
			content: [
				{
					type: 'paragraph',
					anchor: { pageRects: [[0, 0, 0, 10, 10]] },
					content: [{ text: 'A.' }],
				},
				{
					type: 'list',
					anchor: { pageRects: [[0, 20, 0, 40, 10]] },
					content: [
						{
							type: 'listitem',
							anchor: { pageRects: [[0, 20, 0, 40, 10]] },
							content: [{ text: 'B.' }],
						},
						{
							type: 'listitem',
							anchor: { pageRects: [[0, 20, 20, 40, 30]] },
							content: [{ text: 'C.' }],
						},
					],
				},
			],
		};

		assert.deepEqual(
			getRefRangesFromPageRects(structure, [[0, 1, 1, 9, 9]]),
			[[[0], [1]]]
		);
		assert.deepEqual(
			getRefRangesFromPageRects(structure, [[0, 21, 1, 39, 9]]),
			[[[1, 0], [1, 1]]]
		);
		assert.deepEqual(
			getContent(structure, [[[1, 1], [1, 2]]]),
			[{
				type: 'list',
				ref: '1',
				content: [{
					type: 'listitem',
					ref: '1.1',
					content: [{ sid: 0, text: 'C.' }],
				}],
			}]
		);
	});
});

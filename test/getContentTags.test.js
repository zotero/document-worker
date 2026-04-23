import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getContent } from '../structured-document-text/src/pdf/content.js';

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
			{ start: { ref: [0] }, end: { ref: [1] } },
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
			{ start: { ref: [0] }, end: { ref: [0] } },
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
			{ start: { ref: [0] }, end: { ref: [1] } },
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

	it('keeps other nodes but cuts off output at first artifact node', () => {
		const structure = {
			content: [
				{ type: 'paragraph', content: [{ text: 'First.' }] },
				{ type: 'paragraph', other: true, content: [{ text: 'Other node.' }] },
				{ type: 'paragraph', artifact: true, content: [{ text: 'Artifact.' }] },
				{ type: 'paragraph', content: [{ text: 'After artifact.' }] },
			],
		};

		const actual = getContent(structure, []);

		assert.deepEqual(actual,[
			{ type: 'paragraph', ref: '0', content: [{ sid: 0, text: 'First.' }] },
			{ type: 'paragraph', ref: '1', content: [{ sid: 0, text: 'Other node.' }] },
		]);
	});
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getReferenceLists } from '../../src/pdf/structure/reference/reference.js';

describe('getReferenceLists', () => {
	it('emits a continued list item only once', () => {
		const structure = {
			content: [
				{
					type: 'list',
					content: [
						{
							type: 'listitem',
							nextPart: [0, 1],
							content: [{ text: 'Smith 2020 Alpha-' }],
						},
						{
							type: 'listitem',
							previousPart: [0, 0],
							content: [{ text: 'Beta' }],
						},
					],
				},
			],
		};

		const lists = getReferenceLists(structure, new Set());

		assert.equal(lists.length, 1);
		assert.equal(lists[0].references.length, 1);
		assert.equal(lists[0].references[0].text, 'Smith 2020 Alpha-Beta');
		assert.deepEqual(lists[0].references[0].src.blockRef, [0, 0]);
	});

	it('keeps the correct title ref when excluded blocks sit before the reference list', () => {
		const structure = {
			content: [
				{
					type: 'heading',
					content: [{ text: 'References' }],
				},
				{
					type: 'paragraph',
					flowClass: 'excluded',
					content: [{ text: '12' }],
				},
				{
					type: 'list',
					content: [{
						type: 'listitem',
						content: [{ text: 'Smith 2020. Example title.' }],
					}],
				},
			],
		};

		const lists = getReferenceLists(structure, new Set());

		assert.equal(lists.length, 1);
		assert.deepEqual(lists[0].titleRef, [0]);
		assert.deepEqual(lists[0].ref, [2]);
	});
});

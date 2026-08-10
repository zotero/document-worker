import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getReferenceLists } from '../../src/pdf/structure/reference/reference.js';

describe('getReferenceLists', () => {
	function numberedReferenceList(pageIndex, numbers, marker = number => `[${number}]`) {
		return {
			type: 'list',
			content: numbers.map(number => ({
				type: 'listitem',
				_metrics: {
					pageIndex,
					rect: [50, 100, 500, 120],
					firstChar: marker(number)[0],
					firstCharFontSize: 10,
				},
				content: [{ text: `${marker(number)} Smith, J. Example source ${2020 + number}.` }],
			})),
		};
	}

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

	it('does not join cross-page lists when conservative continuation evidence fails', () => {
		const cases = [
			{
				name: 'skipped number',
				second: numberedReferenceList(1, [4, 5]),
				between: [{ type: 'paragraph', flowClass: 'excluded', content: [{ text: 'Page 1' }] }],
			},
			{
				name: 'different marker',
				second: numberedReferenceList(1, [3, 4], number => `${number}.`),
				between: [{ type: 'paragraph', flowClass: 'excluded', content: [{ text: 'Page 1' }] }],
			},
			{
				name: 'different delimiter',
				first: numberedReferenceList(0, [1, 2], number => `${number}.`),
				second: numberedReferenceList(1, [3, 4], number => `${number})`),
				between: [{ type: 'paragraph', flowClass: 'excluded', content: [{ text: 'Page 1' }] }],
			},
			{
				name: 'body barrier',
				second: numberedReferenceList(1, [3, 4]),
				between: [{ type: 'paragraph', content: [{ text: 'Real body content.' }] }],
			},
			{
				name: 'degraded page',
				second: numberedReferenceList(1, [3, 4]),
				between: [{ type: 'paragraph', flowClass: 'excluded', content: [{ text: 'Page 1' }] }],
				degraded: true,
			},
		];

		for (const testCase of cases) {
			const structure = {
				catalog: { pages: [{ extractionDegraded: testCase.degraded }, {}] },
				content: [
					testCase.first || numberedReferenceList(0, [1, 2]),
					...testCase.between,
					testCase.second,
				],
			};

			assert.equal(
				getReferenceLists(structure, new Set()).length,
				2,
				testCase.name
			);
		}
	});
});

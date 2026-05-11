import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createStructureIndex } from '../../src/pdf/structure/structure-index.js';

function createTestStructure() {
	return {
		catalog: {
			pages: [
				{
					contentRanges: [
						[[0], [1]],
					],
				},
				{
					contentRanges: [
						[[2], [2]],
					],
				},
			],
		},
		content: [
			{
				type: 'paragraph',
				content: [{ text: 'Alpha' }],
			},
			{
				type: 'list',
				content: [
					{
						type: 'listitem',
						content: [{ text: 'Beta' }],
					},
				],
			},
			{
				type: 'paragraph',
				content: [{ text: 'Gamma' }],
			},
		],
	};
}

describe('StructureIndex', () => {
	it('walks blocks in document order', () => {
		let index = createStructureIndex(createTestStructure());
		assert.deepEqual(index.blockEntries().map(entry => entry.key), ['0', '1', '1,0', '2']);
	});

	it('materializes block text only through scoped accessors', () => {
		let index = createStructureIndex(createTestStructure());
		let text = index.withBlockText([1, 0], bt => bt.text);
		assert.equal(text, 'Beta');

		let stats = index.stats();
		assert.equal(stats.blockTextsMaterialized, 1);
		assert.equal(stats.pageTextCachePages, 0);
		assert.equal(stats.pageTextCacheBytes, 0);
	});

	it('does not retain page text entries in default low-memory mode', () => {
		let index = createStructureIndex(createTestStructure());
		let pageTexts = index.withPageEntries(0, entries => entries.map(entry => entry.bt.text));

		assert.deepEqual(pageTexts, ['Alpha', 'Beta', 'Beta']);
		let stats = index.stats();
		assert.equal(stats.pageTextEntriesCreated, 1);
		assert.equal(stats.pageTextCachePages, 0);
		assert.equal(stats.pageTextCacheBytes, 0);
	});

	it('keeps page text caching bounded when explicitly enabled', () => {
		let index = createStructureIndex(createTestStructure(), {
			textCache: 'page-lru',
			pageCacheSize: 1,
			maxCachedTextBytes: 10000,
		});

		index.withPageEntries(0, () => {});
		index.withPageEntries(1, () => {});

		let stats = index.stats();
		assert.equal(stats.pageTextCachePages, 1);
		assert.ok(stats.pageTextCacheBytes > 0);
		assert.equal(stats.pageTextCacheEvictions, 1);
	});
});

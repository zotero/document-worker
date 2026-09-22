import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getReferenceIndex, isReferenceBlock } from '../../src/pdf/structure/reference/index.js';

describe('reference-block membership', () => {
	it('matches run descendants and explicit nested blocks without matching unrelated blocks', () => {
		const index = getReferenceIndex([
			{ ref: [2], blockRefs: [[8, 1]], references: [] },
			{ ref: [5], references: [] },
		]);
		assert.equal(isReferenceBlock(index, [2, 99]), true);
		assert.equal(isReferenceBlock(index, [5, 0]), true);
		assert.equal(isReferenceBlock(index, [8, 1]), true);
		assert.equal(isReferenceBlock(index, [8, 2]), false);
		assert.equal(isReferenceBlock(index, [9]), false);
		assert.equal(isReferenceBlock(index, null), false);
	});

	it('preserves strict root equality and does not scan runs for each query', () => {
		let refReads = 0;
		const runs = Array.from({ length: 100 }, (_, root) => ({
			get ref() {
				refReads++;
				return [root];
			},
			references: [],
		}));
		runs.push({ ref: [NaN], references: [] });
		const index = getReferenceIndex(runs);
		refReads = 0;
		for (let i = 0; i < 1000; i++) {
			assert.equal(isReferenceBlock(index, [99, i]), true);
			assert.equal(isReferenceBlock(index, [101, i]), false);
		}
		assert.equal(refReads, 0);
		assert.equal(isReferenceBlock(index, [NaN, 1]), false);
	});
});

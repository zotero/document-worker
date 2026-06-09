import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getRefsList } from '../../src/pdf/structure/apply-refs.js';

describe('PDF reference application', () => {
	it('does not let citation groups with empty math relations shadow math groups', () => {
		const reference = { src: { blockRef: [10] } };
		const refList = { references: [reference] };
		const citation = {
			numbers: [12],
			pageIndex: 0,
			src: { blockRef: [0] },
			mathRelations: [],
			referenceRelations: new Map([
				['12', new Map([[refList, [[0, reference]]]])],
			]),
		};
		const mathDestination = { src: { blockRef: [4] } };
		const math = {
			pageIndex: 0,
			src: { blockRef: [2] },
			mathRelations: [[mathDestination]],
		};
		const candidateGroups = new Map([
			['citation', [citation]],
			['math', [math]],
		]);

		const refs = getRefsList(candidateGroups);

		assert.equal(candidateGroups.has('citation'), false);
		assert.equal(candidateGroups.has('math'), false);
		assert.deepEqual(refs.get('0'), [
			{ src: citation.src, dest: reference.src, type: 'citation' },
		]);
		assert.deepEqual(refs.get('2'), [
			{ src: math.src, dest: mathDestination.src, type: 'math' },
		]);
	});
});

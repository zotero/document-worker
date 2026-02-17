/* eslint-env mocha, node */

import { expect } from 'chai';
import { buildBlocks } from '../src/pdf/structure/model/line-seg/inference.js';

function makeLine(id) {
	return {
		id,
		rect: [id, id, id + 1, id + 1],
		startOffset: id * 10,
		endOffset: id * 10 + 5,
		text: `line${id}`,
	};
}

describe('buildBlocks', function () {
	it('derives block types from class labels', function () {
		const lines = [makeLine(0), makeLine(1)];
		// Even if "type" is wrong/missing, class encodes START (0) then CONT (10).
		const results = [
			{ type: 999, class: 0, confidence: 0.5 },
			{ type: undefined, class: 10, confidence: 0.5 },
		];

		const blocks = buildBlocks(lines, results);
		expect(blocks).to.have.lengthOf(1);
		expect(blocks[0].type).to.equal('title');
	});

	it('never returns blocks with type undefined for invalid class values', function () {
		const lines = [makeLine(0)];
		const results = [{ type: 0, class: NaN, confidence: 0.5 }];

		const blocks = buildBlocks(lines, results);
		expect(blocks).to.have.lengthOf(1);
		expect(blocks[0].type).to.equal('ignore');
	});
});

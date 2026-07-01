import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTableNode } from '../../src/pdf/structure/table/output.js';

function char(c, rect, extra = {}) {
	return {
		c,
		rect,
		axisDir: 0,
		...extra,
	};
}

describe('PDF table output', () => {
	it('emits PDF table blocks as plain text table nodes', () => {
		const node = createTableNode({
			pageIndex: 0,
			block: {
				bbox: [10, 20, 50, 40],
			},
			chars: [
				char('A', [10, 20, 15, 30], { spaceAfter: true }),
				char('B', [20, 20, 25, 30]),
				char('C', [10, 30, 15, 40], { spaceAfter: true }),
				char('D', [20, 30, 25, 40]),
			],
		});

		assert.equal(node.type, 'table');
		assert.ok(node.content.every(child => typeof child.text === 'string'));
		assert.equal(node.content.some(child => child.type === 'tablerow' || child.type === 'tablecell'), false);
		assert.equal(node.content.map(child => child.text).join(''), 'A BC D');
		assert.ok(node.anchor);
	});
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { addPageLabels } from '../../src/pdf/structure/page-label.js';

describe('addPageLabels', () => {
	it('infers labels from excluded SDT text nodes', () => {
		const structure = {
			catalog: {
				pages: [
					{ contentRange: [[0], [1]] },
					{ contentRange: [[1], [2]] },
					{ contentRange: [[2], [3]] },
				],
			},
			content: [
				{ type: 'paragraph', flowClass: 'excluded', content: [{ text: '1' }] },
				{ type: 'paragraph', flowClass: 'excluded', content: [{ text: '2' }] },
				{ type: 'paragraph', flowClass: 'excluded', content: [{ text: '3' }] },
			],
		};

		addPageLabels(structure, null);

		assert.deepEqual(structure.catalog.pages.map(page => page.label), ['1', '2', '3']);
	});
});

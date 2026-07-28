import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
	filterCharsToPageView,
	getStructuredPageChars,
} from '../../pdf.js/src/core/module/module.js';
import { getLines } from '../../src/pdf/structure/model/block-seg/input.js';

describe('PDF page geometry filtering', () => {
	const viewRect = [0, 0, 100, 200];

	it('removes only characters wholly outside the visible page box', () => {
		const visible = { c: 'a', rect: [10, 20, 20, 30] };
		const clippedAtLeft = { c: 'b', rect: [-5, 20, 5, 30] };
		const clippedAtTop = { c: 'c', rect: [10, 195, 20, 205] };
		const outsideLeft = { c: 'd', rect: [-20, 20, -10, 30] };
		const outsideRight = { c: 'e', rect: [110, 20, 120, 30] };
		const outsideBottom = { c: 'f', rect: [10, -20, 20, -10] };
		const outsideTop = { c: 'g', rect: [10, 210, 20, 220] };

		assert.deepEqual(
			filterCharsToPageView([
				visible,
				clippedAtLeft,
				clippedAtTop,
				outsideLeft,
				outsideRight,
				outsideBottom,
				outsideTop,
			], viewRect),
			[visible, clippedAtLeft, clippedAtTop],
		);
	});

	it('keeps characters when geometry is unavailable or malformed', () => {
		const missingRect = { c: 'a' };
		const malformedRect = { c: 'b', rect: [0, Number.NaN, 1, 2] };
		const chars = [missingRect, malformedRect];

		assert.deepEqual(filterCharsToPageView(chars, viewRect), chars);
	});

	it('supports page boxes with negative origins', () => {
		const visible = { c: 'a', rect: [-90, -40, -80, -30] };
		const partiallyVisible = { c: 'b', rect: [-105, -40, -95, -30] };
		const outside = { c: 'c', rect: [5, -40, 15, -30] };

		assert.deepEqual(
			filterCharsToPageView(
				[visible, partiallyVisible, outside],
				[-100, -50, 0, 50],
			),
			[visible, partiallyVisible],
		);
	});

	it('computes line boundaries after removing cropped characters', () => {
		const common = {
			rotation: 0,
			fontSize: 10,
			fontName: 'Test',
		};
		const chars = [
			{ ...common, c: 'a', rect: [80, 100, 85, 110], baseline: 100 },
			{ ...common, c: 'b', rect: [85, 100, 90, 110], baseline: 100 },
			{ ...common, c: 'X', rect: [105, 100, 110, 110], baseline: 100 },
			{ ...common, c: 'c', rect: [80, 80, 85, 90], baseline: 80 },
			{ ...common, c: 'd', rect: [85, 80, 90, 90], baseline: 80 },
		];

		const structured = getStructuredPageChars(chars, viewRect);

		assert.deepEqual(getLines(structured).map(line => line.text), ['ab', 'cd']);
	});
});

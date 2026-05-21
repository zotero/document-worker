import { charsToTextNodes } from '../../../../structured-document-text/src/pdf/index.js';
import { createBlockAnchor } from '../util.js';

function unionRects(rects) {
	if (!rects.length) return null;
	return [
		Math.min(...rects.map(rect => rect[0])),
		Math.min(...rects.map(rect => rect[1])),
		Math.max(...rects.map(rect => rect[2])),
		Math.max(...rects.map(rect => rect[3])),
	];
}

function charsForCell(cell, atoms, chars) {
	const indexes = new Set();
	for (const atomIndex of cell?.indices || []) {
		const atom = atoms[atomIndex];
		for (const charIndex of atom?.charIndexes || []) {
			indexes.add(charIndex);
		}
	}
	return [...indexes]
		.sort((a, b) => a - b)
		.map(index => chars[index])
		.filter(Boolean);
}

function anchorForChars(pageIndex, chars) {
	const bbox = unionRects(chars.map(ch => ch.rect).filter(Boolean));
	return createBlockAnchor(pageIndex, bbox);
}

function makeParagraph(pageIndex, cellChars) {
	const content = charsToTextNodes(pageIndex, cellChars);
	if (!content.length) return null;
	const anchor = anchorForChars(pageIndex, cellChars);
	return {
		type: 'paragraph',
		...(anchor && { anchor }),
		content,
	};
}

export function createFallbackTableNode({ pageIndex, block, chars }) {
	const anchor = createBlockAnchor(pageIndex, block.bbox);
	return {
		type: 'table',
		...(anchor && { anchor }),
		content: charsToTextNodes(pageIndex, chars),
	};
}

export function extractionToTableNode(extraction) {
	const { pageIndex, block, chars, atoms, grid } = extraction;
	const tableAnchor = createBlockAnchor(pageIndex, block.bbox);
	const matrix = grid?.matrix || [];
	const rows = [];

	for (let rowIndex = 0; rowIndex < matrix.length; rowIndex++) {
		const rowCells = [];
		const rowChars = [];
		for (let colIndex = 0; colIndex < matrix[rowIndex].length; colIndex++) {
			const cell = matrix[rowIndex][colIndex];
			const cellChars = charsForCell(cell, atoms, chars);
			rowChars.push(...cellChars);
			const cellAnchor = anchorForChars(pageIndex, cellChars) || tableAnchor;
			const paragraph = makeParagraph(pageIndex, cellChars);
			rowCells.push({
				type: 'tablecell',
				anchor: cellAnchor,
				content: paragraph ? [paragraph] : [],
			});
		}
		if (!rowCells.length) continue;
		const rowAnchor = anchorForChars(pageIndex, rowChars) || tableAnchor;
		rows.push({
			type: 'tablerow',
			anchor: rowAnchor,
			content: rowCells,
		});
	}

	if (!rows.length) {
		return createFallbackTableNode({ pageIndex, block, chars });
	}

	return {
		type: 'table',
		...(tableAnchor && { anchor: tableAnchor }),
		content: rows,
	};
}

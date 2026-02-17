/**
 * Extract plain text from a block's content, recursing into nested blocks
 * (e.g. lists containing listitems).
 */
function getBlockFulltext(node) {
	if (!node) return '';
	if (typeof node.text === 'string') return node.text;
	if (!Array.isArray(node.content)) return '';

	const hasChildBlock = node.content.some(
		child => child && typeof child.text !== 'string'
	);

	if (!hasChildBlock) {
		// Leaf block: concatenate text nodes
		let result = '';
		for (const child of node.content) {
			if (child && typeof child.text === 'string') {
				result += child.text;
			}
		}
		return result;
	}

	// Container block: recurse with newline between child blocks
	const parts = [];
	for (const child of node.content) {
		if (!child || typeof child.text === 'string') continue;
		const text = getBlockFulltext(child);
		if (text) {
			parts.push(text);
		}
	}
	return parts.join('\n');
}

/**
 * Convert a structure object into a fulltext string for the given page indexes.
 *
 * @param {Object} structure - The structured data from getFullStructure/getStructure
 * @param {number[]} pageIndexes - Array of page indexes to include
 * @returns {string} The fulltext string, NFC normalized
 */
export function getFulltextFromStructuredText(structure, pageIndexes) {
	const emittedBlocks = new Set();
	const pageTexts = [];

	for (const pageIndex of pageIndexes) {
		const page = structure.pages[pageIndex];
		if (!page || !Array.isArray(page.contentRanges)) {
			pageTexts.push('');
			continue;
		}

		const blockTexts = [];

		for (const range of page.contentRanges) {
			if (!range.start?.ref || !range.end?.ref) continue;

			const startIdx = range.start.ref[0];
			const endIdx = range.end.ref[0];

			for (let i = startIdx; i <= endIdx; i++) {
				if (emittedBlocks.has(i)) continue;
				emittedBlocks.add(i);

				const block = structure.content[i];
				if (!block || block.artifact) continue;

				const text = getBlockFulltext(block);
				if (text) {
					blockTexts.push(text);
				}
			}
		}

		pageTexts.push(blockTexts.join('\n'));
	}

	// Join pages with \n\n\f (matching the format from char-based extraction)
	let text = '';
	for (let i = 0; i < pageTexts.length; i++) {
		text += pageTexts[i];
		text += '\n\n';
		if (i !== pageTexts.length - 1) {
			text += '\f';
		}
	}

	return text.trim().normalize('NFC');
}

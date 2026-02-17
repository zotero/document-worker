/**
 * Flatten outline hierarchy into an ordered list of { blockIndex, path }.
 */
function flattenOutline(items, ancestors) {
	const result = [];
	if (!Array.isArray(items)) return result;
	for (const item of items) {
		const blockIndex = Array.isArray(item.ref) && item.ref.length > 0 ? item.ref[0] : null;
		const path = [...ancestors, item.title];
		if (Number.isInteger(blockIndex) && blockIndex >= 0) {
			result.push({ blockIndex, path });
		}
		if (Array.isArray(item.children)) {
			result.push(...flattenOutline(item.children, path));
		}
	}
	return result;
}

/**
 * Recursively extract plain text from a block (handles nested blocks like lists).
 */
function getPlainText(node) {
	if (!node) return '';
	if (typeof node.text === 'string') return node.text;
	if (!Array.isArray(node.content)) return '';
	let result = '';
	for (const child of node.content) {
		result += getPlainText(child);
	}
	return result;
}

/**
 * Collect anchor.pageRects from a block into a map of pageIndex -> rects.
 */
function collectBlockPageRects(block, map) {
	const pageRects = block?.anchor?.pageRects;
	if (!Array.isArray(pageRects)) return;
	for (const pr of pageRects) {
		if (!Array.isArray(pr) || pr.length < 5) continue;
		const pageIndex = pr[0];
		if (!Number.isFinite(pageIndex)) continue;
		const rect = [pr[1], pr[2], pr[3], pr[4]];
		if (!map.has(pageIndex)) {
			map.set(pageIndex, []);
		}
		map.get(pageIndex).push(rect);
	}
}

/**
 * Count the number of leaf blocks inside a block (accounting for nested content like lists).
 */
function countLeafBlocks(block) {
	if (!block) return 0;
	if (!Array.isArray(block.content) || block.content.length === 0) return 1;
	let count = 0;
	for (const child of block.content) {
		count += countLeafBlocks(child);
	}
	return count;
}

const MIN_CHUNK_TEXT_LENGTH = 30;

/**
 * Get the next chunk starting at startBlockIndex.
 * Each chunk corresponds to a section between consecutive outline headings.
 * Returns null when there are no more chunks.
 */
export function getNextChunk(structure, startBlockIndex) {
	const content = structure?.content;
	if (!Array.isArray(content) || startBlockIndex < 0 || startBlockIndex >= content.length) {
		return null;
	}

	// Flatten outline to get heading block indexes and their hierarchy paths
	const headings = flattenOutline(structure.outline, []);
	headings.sort((a, b) => a.blockIndex - b.blockIndex);

	while (startBlockIndex < content.length) {
		// Skip leading artifact blocks
		while (startBlockIndex < content.length && content[startBlockIndex]?.artifact) {
			startBlockIndex++;
		}
		if (startBlockIndex >= content.length) {
			return null;
		}

		// Find section end: the block before the next heading after startBlockIndex
		let endBlockIndex = content.length - 1;
		for (const h of headings) {
			if (h.blockIndex > startBlockIndex) {
				endBlockIndex = h.blockIndex - 1;
				break;
			}
		}

		// Trim trailing artifact/empty blocks from end of chunk
		while (endBlockIndex > startBlockIndex) {
			const block = content[endBlockIndex];
			if (block && !block.artifact && getPlainText(block)) break;
			endBlockIndex--;
		}

		// Determine outline path from the most recent heading at or before startBlockIndex
		let outlinePath = '';
		for (let i = headings.length - 1; i >= 0; i--) {
			if (headings[i].blockIndex <= startBlockIndex) {
				outlinePath = headings[i].path.join(' > ');
				break;
			}
		}

		// Determine if startBlockIndex is a heading block itself
		let contentStartIndex = startBlockIndex;
		for (const h of headings) {
			if (h.blockIndex === startBlockIndex) {
				contentStartIndex = startBlockIndex + 1;
				break;
			}
		}

		// Collect text and page rects from blocks in this section (excluding heading)
		const textParts = [];
		const pageRectsMap = new Map();
		// Include heading block's page rects in the chunk
		if (contentStartIndex !== startBlockIndex) {
			collectBlockPageRects(content[startBlockIndex], pageRectsMap);
		}
		let leafBlockCount = 0;

		for (let i = contentStartIndex; i <= endBlockIndex; i++) {
			const block = content[i];
			if (!block || block.artifact) continue;

			const blockText = getPlainText(block);
			if (blockText) {
				textParts.push(blockText);
			}

			leafBlockCount += countLeafBlocks(block);
			collectBlockPageRects(block, pageRectsMap);
		}

		const text = textParts.join('\n');

		// Skip empty or too-short chunks
		if (!text || text.length < MIN_CHUNK_TEXT_LENGTH) {
			startBlockIndex = endBlockIndex + 1;
			continue;
		}

		const pageRects = [];
		for (const [pageIndex, rects] of pageRectsMap) {
			for (const rect of rects) {
				if (!Array.isArray(rect) || rect.length < 4) continue;
				pageRects.push([pageIndex, rect[0], rect[1], rect[2], rect[3]]);
			}
		}
		pageRects.sort((a, b) => a[0] - b[0]);

		return {
			startBlockIndex,
			endBlockIndex,
			leafBlockCount,
			outlinePath,
			text,
			pageRects
		};
	}
	return null;
}

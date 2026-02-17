
export function cleanupBlockMetrics(structure) {
	if (!structure || !Array.isArray(structure.content)) {
		return;
	}
	for (const block of structure.content) {
		if (block) {
			delete block._metrics;
		}
	}
}

export function getHeadingMetrics(rawBlock, charsRange) {
	if (!charsRange || charsRange.length === 0) {
		return {
			rect: rawBlock.bbox,
			fontName: '',
			fontSize: 0,
		};
	}

	const firstChar = charsRange[0];

	return {
		rect: rawBlock.bbox,
		fontName: firstChar.fontName,
		fontSize: firstChar.fontSize,
	};
}

export function getParagraphMetrics(rawBlock, charsRange) {
	if (!charsRange || charsRange.length === 0) {
		return {
			pageIndex: rawBlock.pageIndex,
			bbox: rawBlock.bbox,
			lineCount: 0,
			firstLineIndent: 0,
			firstChar: '',
			firstCharFontSize: 0,
			firstCharFontName: '',
			lastLineRag: 0,
			lastChar: '',
			lastCharFontSize: 0,
			lastCharFontName: '',
		};
	}

	const firstChar = charsRange[0];
	const lastChar = charsRange[charsRange.length - 1];

	// Count lines by counting lineBreakAfter occurrences
	// Only add 1 for the last line if it doesn't end with lineBreakAfter
	let lineCount = 0;
	for (let char of charsRange) {
		if (char.lineBreakAfter) {
			lineCount++;
		}
	}
	if (!lastChar.lineBreakAfter) {
		lineCount++;
	}

	// First line indent: difference between first char's left edge and block's left edge
	const firstLineIndent = firstChar.rect[0] - rawBlock.bbox[0];

	// Last line rag: difference between block's right edge and last char's right edge
	const lastLineRag = rawBlock.bbox[2] - lastChar.rect[2];

	return {
		pageIndex: rawBlock.pageIndex,
		rect: rawBlock.bbox,
		lineCount,
		firstLineIndent,
		firstChar: firstChar.c,
		firstCharFontSize: firstChar.fontSize,
		firstCharFontName: firstChar.fontName,
		lastLineRag,
		lastChar: lastChar.c,
		lastCharFontSize: lastChar.fontSize,
		lastCharFontName: lastChar.fontName,
	};
}

export function mergeParagraphs(structure, mergeBlocks) {
	// merge subsequent paragraph (even if there are other types of blocks in between) if:
	// first paragraph ends with a lowercase letter or number and doesn't have sentence end mark, and lastLineRag is <=1
	// and second paragraph indent is <=1 and starts with a lowercase letter or number,
	// and both paragraph width is the same
	// and the second one is on the same page or on the next page
	// and after identifying those paragraphs to join, use mergeBlocks

	if (!structure || !Array.isArray(structure.content) || structure.content.length === 0) {
		return structure;
	}

	const SENTENCE_END_MARKS = new Set(['.', '!', '?', '。', '！', '？']);
	const RAG_THRESHOLD = 1;
	const INDENT_THRESHOLD = 1;

	const isLowercaseOrNumber = (char) => {
		if (!char || char.length === 0) {
			return false;
		}
		const c = char.charAt(0);
		return (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9');
	};

	const getBlockWidth = (metrics) => {
		if (!metrics || !Array.isArray(metrics.rect)) {
			return null;
		}
		return metrics.rect[2] - metrics.rect[0];
	};

	const canMergeParagraphs = (first, second) => {
		const m1 = first._metrics;
		const m2 = second._metrics;

		if (!m1 || !m2) {
			return false;
		}

		// Check page proximity (same page or next page)
		if (m2.pageIndex !== m1.pageIndex && m2.pageIndex !== m1.pageIndex + 1) {
			return false;
		}

		// First paragraph must end with lowercase letter or number
		if (!isLowercaseOrNumber(m1.lastChar)) {
			return false;
		}

		// First paragraph must not end with sentence end mark
		if (SENTENCE_END_MARKS.has(m1.lastChar)) {
			return false;
		}

		// First paragraph lastLineRag must be <= threshold
		if (m1.lastLineRag > RAG_THRESHOLD) {
			return false;
		}

		// Second paragraph indent must be <= threshold
		if (m2.firstLineIndent > INDENT_THRESHOLD) {
			return false;
		}

		// Second paragraph must start with lowercase letter or number
		if (!isLowercaseOrNumber(m2.firstChar)) {
			return false;
		}

		// Both paragraphs must have the same width
		const width1 = getBlockWidth(m1);
		const width2 = getBlockWidth(m2);
		return width1 !== null && width2 !== null && Math.abs(width1 - width2) <= 1;
	};

	// Find all paragraphs with their indices
	const paragraphs = [];
	for (let i = 0; i < structure.content.length; i++) {
		const block = structure.content[i];
		if (block && block.type === 'paragraph' && !block.artifact && !block.other && block._metrics) {
			paragraphs.push({ index: i, block });
		}
	}

	if (paragraphs.length < 2) {
		return structure;
	}

	// Find groups of paragraphs to merge
	const mergeGroups = [];
	let currentGroup = null;

	for (let i = 0; i < paragraphs.length - 1; i++) {
		const current = paragraphs[i];
		const next = paragraphs[i + 1];

		if (canMergeParagraphs(current.block, next.block)) {
			if (!currentGroup) {
				currentGroup = [current.index];
			}
			currentGroup.push(next.index);
		} else {
			if (currentGroup) {
				mergeGroups.push(currentGroup);
				currentGroup = null;
			}
		}
	}

	// Don't forget the last group
	if (currentGroup) {
		mergeGroups.push(currentGroup);
	}

	if (mergeGroups.length === 0) {
		return structure;
	}

	return mergeBlocks(structure, mergeGroups);
}

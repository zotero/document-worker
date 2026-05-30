import { canCrossPagePartLink, isBodyFlowBlock, isTransparentBetweenParts } from './flow-policy.js';

function getNodeByRef(structure, ref) {
	let node = { content: structure?.content };
	for (const index of ref || []) {
		if (!Number.isInteger(index) || !Array.isArray(node?.content)) {
			return null;
		}
		node = node.content[index];
		if (!node || typeof node !== 'object') {
			return null;
		}
	}
	return node;
}

function sameRef(a, b) {
	return Array.isArray(a)
		&& Array.isArray(b)
		&& a.length === b.length
		&& a.every((value, index) => value === b[index]);
}

function getParentRef(ref) {
	return Array.isArray(ref) && ref.length > 0 ? ref.slice(0, -1) : null;
}

function getLastRefIndex(ref) {
	return Array.isArray(ref) && ref.length > 0 ? ref[ref.length - 1] : null;
}

function hasOnlySkippableBlocksBetween(structure, firstIndex, secondIndex) {
	for (let i = firstIndex + 1; i < secondIndex; i++) {
		const block = structure.content[i];
		if (!isTransparentBetweenParts(block)) {
			return false;
		}
	}
	return true;
}

function setPartLinks(structure, groups) {
	for (const group of groups) {
		for (let i = 0; i < group.length; i++) {
			const ref = group[i];
			const block = getNodeByRef(structure, ref);
			if (!block) {
				continue;
			}
			if (i > 0) {
				block.previousPart = [...group[i - 1]];
			}
			if (i < group.length - 1) {
				block.nextPart = [...group[i + 1]];
			}
		}
	}
	return structure;
}

export function cleanupBlockMetrics(structure) {
	if (!structure || !Array.isArray(structure.content)) {
		return;
	}
	for (const block of structure.content) {
		if (block) {
			delete block._metrics;
			// Also clean up nested items (e.g., listitems inside list blocks)
			if (Array.isArray(block.content)) {
				for (const child of block.content) {
					if (child) {
						delete child._metrics;
					}
				}
			}
		}
	}
}

export function cleanupTextNodeStyles(structure) {
	if (!structure || !Array.isArray(structure.content)) {
		return;
	}
	for (const block of structure.content) {
		if (!block || !Array.isArray(block.content)) {
			continue;
		}
		if (block.type === 'list') {
			for (const item of block.content) {
				if (item && Array.isArray(item.content)) {
					for (const node of item.content) {
						if (node && node.style) {
							delete node.style._fontSize;
						}
					}
				}
			}
		} else {
			for (const node of block.content) {
				if (node && node.style) {
					delete node.style._fontSize;
				}
			}
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

function collectBlocksByType(structure, type) {
	const entries = [];
	const visit = (content, baseRef) => {
		if (!Array.isArray(content)) {
			return;
		}
		for (let i = 0; i < content.length; i++) {
			const block = content[i];
			if (!block || typeof block.text === 'string') {
				continue;
			}
			const ref = [...baseRef, i];
			if (block.type === type && block._metrics) {
				entries.push({ ref, block });
			}
			visit(block.content, ref);
		}
	};
	visit(structure?.content, []);
	return entries;
}

export function markListItemParts(structure) {
	if (!structure || !Array.isArray(structure.content) || structure.content.length === 0) {
		return structure;
	}

	const canMerge = (first, second) => {
		const m1 = first._metrics;
		const m2 = second._metrics;

		if (!m1 || !m2) {
			return false;
		}

		if (!canCrossPagePartLink(structure, m1, m2)) {
			return false;
		}

		// First list item must end with a hyphen (word break across columns/pages)
		if (m1.lastChar !== '-') {
			return false;
		}

		// Second list item must start with lowercase letter (continuation of hyphenated word)
		const c = m2.firstChar?.charAt(0);
		if (!c || c < 'a' || c > 'z') {
			return false;
		}

		return true;
	};

	const areAdjacentListParts = (first, second) => {
		const firstParent = getParentRef(first.ref);
		const secondParent = getParentRef(second.ref);
		const firstIndex = getLastRefIndex(first.ref);
		const secondIndex = getLastRefIndex(second.ref);
		if (!firstParent || !secondParent || !Number.isInteger(firstIndex) || !Number.isInteger(secondIndex)) {
			return false;
		}

		if (sameRef(firstParent, secondParent)) {
			return secondIndex === firstIndex + 1;
		}

		if (firstParent.length !== 1 || secondParent.length !== 1) {
			return false;
		}

		const firstList = getNodeByRef(structure, firstParent);
		const secondList = getNodeByRef(structure, secondParent);
		return firstList?.type === 'list'
			&& secondList?.type === 'list'
			&& Array.isArray(firstList.content)
			&& firstIndex === firstList.content.length - 1
			&& secondIndex === 0
			&& firstParent[0] < secondParent[0]
			&& hasOnlySkippableBlocksBetween(structure, firstParent[0], secondParent[0]);
	};

	const listItems = collectBlocksByType(structure, 'listitem')
		.filter(({ block }) => isBodyFlowBlock(block));

	if (listItems.length < 2) {
		return structure;
	}

	// Find groups of list items that should be read as one logical item.
	const partGroups = [];
	let currentGroup = null;

	for (let i = 0; i < listItems.length - 1; i++) {
		const current = listItems[i];
		const next = listItems[i + 1];

		if (canMerge(current.block, next.block) && areAdjacentListParts(current, next)) {
			if (!currentGroup) {
				currentGroup = [current.ref];
			}
			currentGroup.push(next.ref);
		} else {
			if (currentGroup) {
				partGroups.push(currentGroup);
				currentGroup = null;
			}
		}
	}

	if (currentGroup) {
		partGroups.push(currentGroup);
	}

	if (partGroups.length === 0) {
		return structure;
	}

	return setPartLinks(structure, partGroups);
}

export function markParagraphParts(structure) {
	// Link subsequent paragraph parts if:
	// first paragraph ends with a lowercase letter or number and doesn't have sentence end mark, and lastLineRag is <=1
	// and second paragraph indent is <=1 and starts with a lowercase letter or number,
	// and both paragraph widths match, unless the second part is a one-line cross-page continuation,
	// and the second one is on the same page or on the next page
	// and only non-body flow blocks appear between them in the top-level sequence.

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

	const isLowercase = (char) => {
		if (!char || char.length === 0) {
			return false;
		}
		const c = char.charAt(0);
		return c >= 'a' && c <= 'z';
	};

	const getBlockWidth = (metrics) => {
		if (!metrics || !Array.isArray(metrics.rect)) {
			return null;
		}
		return metrics.rect[2] - metrics.rect[0];
	};

	const hasCompatibleWidth = (m1, m2) => {
		const width1 = getBlockWidth(m1);
		const width2 = getBlockWidth(m2);
		if (width1 === null || width2 === null) {
			return false;
		}
		if (Math.abs(width1 - width2) <= 1) {
			return true;
		}
		return m2.pageIndex === m1.pageIndex + 1
			&& m2.lineCount === 1
			&& width2 <= width1 + 1;
	};

	const canLinkParagraphs = (first, second) => {
		const m1 = first._metrics;
		const m2 = second._metrics;

		if (!m1 || !m2) {
			return false;
		}

		if (!canCrossPagePartLink(structure, m1, m2)) {
			return false;
		}

		// For same-page blocks, prevent merging when the second block is entirely
		// to the left of the first block. Right-to-left column reading order never
		// occurs in natural left-to-right text flow.
		if (m2.pageIndex === m1.pageIndex && m1.rect && m2.rect && m2.rect[2] <= m1.rect[0]) {
			return false;
		}

		const plainContinuation = isLowercaseOrNumber(m1.lastChar)
			&& !SENTENCE_END_MARKS.has(m1.lastChar);
		const hyphenatedContinuation = m1.lastChar === '-' && isLowercase(m2.firstChar);
		if (!plainContinuation && !hyphenatedContinuation) {
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

		return hasCompatibleWidth(m1, m2);
	};

	// Find all paragraphs with their indices
	const paragraphs = [];
	for (let i = 0; i < structure.content.length; i++) {
		const block = structure.content[i];
		if (block && block.type === 'paragraph' && isBodyFlowBlock(block) && block._metrics) {
			paragraphs.push({ index: i, block });
		}
	}

	if (paragraphs.length < 2) {
		return structure;
	}

	// Find groups of paragraphs that should be read as one logical paragraph.
	const partGroups = [];
	let currentGroup = null;

	for (let i = 0; i < paragraphs.length - 1; i++) {
		const current = paragraphs[i];
		const next = paragraphs[i + 1];

		if (canLinkParagraphs(current.block, next.block)) {
			if (!hasOnlySkippableBlocksBetween(structure, current.index, next.index)) {
				if (currentGroup) {
					partGroups.push(currentGroup);
					currentGroup = null;
				}
				continue;
			}
			if (!currentGroup) {
				currentGroup = [[current.index]];
			}
			currentGroup.push([next.index]);
		} else {
			if (currentGroup) {
				partGroups.push(currentGroup);
				currentGroup = null;
			}
		}
	}

	// Don't forget the last group
	if (currentGroup) {
		partGroups.push(currentGroup);
	}

	if (partGroups.length === 0) {
		return structure;
	}

	return setPartLinks(structure, partGroups);
}

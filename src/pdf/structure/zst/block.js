/**
 * Block operations: navigation, manipulation, ranges, and cursors.
 */

import {
	HEADER_AXIS_DIR_SHIFT,
	HEADER_LAST_IS_SOFT_HYPHEN,
	isVertical,
} from './constants.js';
import { parseTextMap, reconstructCharPositions, buildRunData } from './decode.js';
import { canMergeTextNodes, mergeSequentialTextNodes } from './text-node.js';
import { mergePageRects } from '../util.js';

// ═══════════════════════════════════════════════════════════════════════════
// Block Navigation
// ═══════════════════════════════════════════════════════════════════════════

function isWhitespaceChar(ch) {
	return ch === ' ' || ch === '\n' || ch === '\t';
}

function mapTextToRuns(text, runData) {
	const rects = [];
	const pageIndexes = [];
	let runIndex = 0;

	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (isWhitespaceChar(ch)) {
			rects.push(null);
			pageIndexes.push(null);
			continue;
		}
		const current = runIndex < runData.length ? runData[runIndex++] : null;
		rects.push(current ? current.rect : null);
		pageIndexes.push(current ? current.pageIndex : null);
	}

	return { rects, pageIndexes };
}

function appendText(output, text, property, rects, pageIndexes) {
	if (!text) {
		return;
	}
	output.textParts.push(text);
	for (let i = 0; i < text.length; i++) {
		output.attrs.push(property);
		output.rects.push(rects ? rects[i] : null);
		output.pageIndexes.push(pageIndexes ? pageIndexes[i] : null);
	}
}

function appendTextNodes(output, nodes) {
	if (!Array.isArray(nodes)) {
		return;
	}
	for (const node of nodes) {
		if (!node || typeof node.text !== 'string') {
			continue;
		}
		const text = node.text;
		const property = {
			style: node.style ?? null,
			target: node.target ?? null,
			refs: node.refs ?? null,
		};
		const runs = buildRunData(parseTextMap(node.anchor?.textMap));
		const mapped = runs.length ? mapTextToRuns(text, runs) : null;
		appendText(output, text, property, mapped?.rects ?? null, mapped?.pageIndexes ?? null);
	}
}

function walkTextNodes(node, output) {
	if (!node || typeof node !== 'object') {
		return;
	}
	if (typeof node.text === 'string') {
		appendTextNodes(output, [node]);
		return;
	}
	if (Array.isArray(node.content)) {
		for (const child of node.content) {
			walkTextNodes(child, output);
		}
	}
}

/**
 * Get block by reference path.
 */
export function getBlockByRef(structure, blockRef) {
	if (!structure || !Array.isArray(blockRef)) {
		return null;
	}
	let node = { content: structure.content };
	for (const index of blockRef) {
		if (!node || !Array.isArray(node.content)) {
			return null;
		}
		node = node.content[index];
		if (!node || typeof node !== 'object') {
			return null;
		}
	}
	return node;
}

/**
 * Get text content with attributes and positions from a block.
 */
export function getBlockText(structure, blockRef) {
	const output = {
		textParts: [],
		attrs: [],
		rects: [],
		pageIndexes: [],
	};

	const block = getBlockByRef(structure, blockRef);
	if (block) {
		walkTextNodes(block, output);
	}

	return {
		text: output.textParts.join(''),
		attrs: output.attrs,
		rects: output.rects,
		pageIndexes: output.pageIndexes,
	};
}

/**
 * Get next block reference in document order.
 */
export function getNextBlockRef(structure, currentBlockRef = null) {
	const isTextNode = (node) => !!node.text;
	const isBlockNode = (node) => node && !isTextNode(node);

	const sameRef = (a, b) => {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
			return false;
		}
		for (let i = 0; i < a.length; i++) {
			if (a[i] !== b[i]) {
				return false;
			}
		}
		return true;
	};

	const ref = currentBlockRef;
	const state = { found: ref === null };

	const walk = (content, baseRef) => {
		for (let i = 0; i < content.length; i++) {
			const node = content[i];
			if (!isBlockNode(node)) continue;
			const nodeRef = [...baseRef, i];

			if (state.found) {
				return nodeRef;
			}
			if (ref && sameRef(nodeRef, ref)) {
				state.found = true;
			}

			const childRef = walk(node.content, nodeRef);
			if (childRef) {
				return childRef;
			}
		}
		return null;
	};

	return walk(structure.content, []);
}

// ═══════════════════════════════════════════════════════════════════════════
// Block Manipulation
// ═══════════════════════════════════════════════════════════════════════════

function sliceTextMap(textMap, startOffset, endOffset) {
	const runs = parseTextMap(textMap);
	if (!runs.length) {
		return null;
	}

	const newRuns = [];
	let charIndex = 0;

	for (const run of runs) {
		if (!Array.isArray(run) || run.length < 6) {
			continue;
		}

		const [header, ...rest] = run;
		const positions = reconstructCharPositions(run);
		const hasSoftHyphen = header & HEADER_LAST_IS_SOFT_HYPHEN;

		if (hasSoftHyphen) {
			positions.pop();
		}

		const runStart = charIndex;
		const runEnd = charIndex + positions.length;

		// Skip runs completely outside range
		if (runEnd <= startOffset || runStart >= endOffset) {
			charIndex = runEnd;
			continue;
		}

		// Calculate slice boundaries within this run
		const sliceStart = Math.max(0, startOffset - runStart);
		const sliceEnd = Math.min(positions.length, endOffset - runStart);
		const slicedPositions = positions.slice(sliceStart, sliceEnd);

		if (slicedPositions.length > 0) {
			// Rebuild run with sliced positions
			const newHeader = sliceEnd === positions.length && hasSoftHyphen
				? header
				: header & ~HEADER_LAST_IS_SOFT_HYPHEN;

			const newRun = [newHeader, ...rest.slice(0, 5)];

			// Add sliced position data
			for (const pos of slicedPositions) {
				if (pos && Number.isFinite(pos.x1) && Number.isFinite(pos.x2)) {
					newRun.push(pos.x1, pos.x2);
				}
			}

			newRuns.push(newRun);
		}

		charIndex = runEnd;
	}

	return newRuns.length ? JSON.stringify(newRuns) : null;
}

/**
 * Apply a callback to text nodes within a range, splitting nodes if necessary.
 */
export function applyTextAttributes(structure, blockRef, offsetStart, offsetEnd, callback) {
	const block = getBlockByRef(structure, blockRef);
	if (!block) {
		return null;
	}

	const sameRef = (a, b) => {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
			return false;
		}
		for (let i = 0; i < a.length; i++) {
			if (a[i] !== b[i]) {
				return false;
			}
		}
		return true;
	};

	const startsWithRef = (ref, prefix) => {
		if (!Array.isArray(ref) || !Array.isArray(prefix) || prefix.length > ref.length) {
			return false;
		}
		for (let i = 0; i < prefix.length; i++) {
			if (ref[i] !== prefix[i]) {
				return false;
			}
		}
		return true;
	};

	const walkTextNodesWithRefs = (node, path, visitor) => {
		if (!node || typeof node !== 'object') {
			return true;
		}
		if (typeof node.text === 'string') {
			return visitor(node, path) !== false;
		}
		if (Array.isArray(node.content)) {
			for (let i = 0; i < node.content.length; i++) {
				const child = node.content[i];
				const shouldContinue = walkTextNodesWithRefs(child, [...path, i], visitor);
				if (!shouldContinue) {
					return false;
				}
			}
		}
		return true;
	};

	const getAbsoluteOffsetForRef = (root, rootRef, targetRef, targetOffset, isEnd) => {
		if (!Array.isArray(targetRef) || !startsWithRef(targetRef, rootRef)) {
			return null;
		}
		const localRef = targetRef.slice(rootRef.length);
		let absolute = null;
		let currentOffset = 0;
		let firstMatch = null;
		let lastMatch = null;

		const clampOffset = (offset, length, endBias) => {
			if (!Number.isInteger(offset)) {
				return endBias ? Math.max(0, length - 1) : 0;
			}
			if (length <= 0) {
				return 0;
			}
			return Math.max(0, Math.min(offset, length - 1));
		};

		walkTextNodesWithRefs(root, [], (node, path) => {
			const len = node.text.length;
			const isExact = localRef.length > 0 && sameRef(path, localRef);
			const isMatch = isExact || localRef.length === 0 || startsWithRef(path, localRef);
			if (isMatch) {
				const offset = clampOffset(targetOffset, len, isEnd);
				const abs = currentOffset + offset;
				if (isExact) {
					absolute = abs;
					return false;
				}
				if (firstMatch === null) {
					firstMatch = abs;
				}
				lastMatch = abs;
			}
			currentOffset += len;
			return true;
		});

		if (absolute !== null) {
			return absolute;
		}
		return isEnd ? lastMatch : firstMatch;
	};

	const getRefForAbsoluteOffset = (root, rootRef, absOffset) => {
		if (!Number.isInteger(absOffset)) {
			return null;
		}
		let currentOffset = 0;
		let found = null;
		let lastRef = null;
		let lastLen = 0;

		walkTextNodesWithRefs(root, [], (node, path) => {
			const len = node.text.length;
			lastRef = [...rootRef, ...path];
			lastLen = len;

			if (len > 0) {
				if (absOffset <= currentOffset + len - 1) {
					found = {
						ref: [...rootRef, ...path],
						offset: absOffset - currentOffset
					};
					return false;
				}
				currentOffset += len;
			}
			return true;
		});

		if (found) {
			return found;
		}

		if (!lastRef) {
			return null;
		}

		const clamped = lastLen > 0 ? Math.max(0, Math.min(absOffset - (currentOffset - lastLen), lastLen - 1)) : 0;
		return { ref: lastRef, offset: clamped };
	};

	const rangeUpdates = [];
	if (Array.isArray(structure?.pages)) {
		for (const page of structure.pages) {
			if (!page || !Array.isArray(page.contentRanges)) {
				continue;
			}
			for (const range of page.contentRanges) {
				if (range?.start?.ref && startsWithRef(range.start.ref, blockRef)) {
					const absOffset = getAbsoluteOffsetForRef(block, blockRef, range.start.ref, range.start.offset, false);
					if (absOffset !== null) {
						rangeUpdates.push({
							target: range.start,
							absOffset,
							hasOffset: Number.isInteger(range.start.offset)
						});
					}
				}
				if (range?.end?.ref && startsWithRef(range.end.ref, blockRef)) {
					const absOffset = getAbsoluteOffsetForRef(block, blockRef, range.end.ref, range.end.offset, true);
					if (absOffset !== null) {
						rangeUpdates.push({
							target: range.end,
							absOffset,
							hasOffset: Number.isInteger(range.end.offset)
						});
					}
				}
			}
		}
	}

	// Treat offsetEnd as inclusive; normalize to a sane range.
	if (!Number.isInteger(offsetStart) || !Number.isInteger(offsetEnd)) {
		return null;
	}
	if (offsetEnd < offsetStart) {
		[offsetStart, offsetEnd] = [offsetEnd, offsetStart];
	}

	let currentOffset = 0;
	let targetTextNodeRef = null;
	let didSplit = false;

	const processNode = (node, parentRef) => {
		if (!node || typeof node !== 'object') {
			return node;
		}

		// If it's a text node
		if (typeof node.text === 'string') {
			const text = node.text;
			const nodeStart = currentOffset;
			const nodeEnd = currentOffset + text.length;
			currentOffset = nodeEnd;

			// No overlap (inclusive end)
			if (nodeEnd - 1 < offsetStart || nodeStart > offsetEnd) {
				return node;
			}

			// Complete overlap - apply callback to entire node
			if (nodeStart >= offsetStart && nodeEnd - 1 <= offsetEnd) {
				const result = callback(node);
				if (!targetTextNodeRef) {
					targetTextNodeRef = parentRef;
				}
				return result;
			}

			// Partial overlap - need to split
			const result = [];
			didSplit = true;
			const hasAnchor = node.anchor?.textMap;

			// Before range
			if (nodeStart < offsetStart) {
				const beforeText = text.substring(0, offsetStart - nodeStart);
				const beforeNode = {
					...node,
					text: beforeText,
				};

				if (hasAnchor && node.anchor) {
					const slicedMap = sliceTextMap(node.anchor.textMap, 0, offsetStart - nodeStart);
					if (slicedMap) {
						beforeNode.anchor = { ...node.anchor, textMap: slicedMap };
					} else {
						delete beforeNode.anchor;
					}
				}

				result.push(beforeNode);
			}

			// Inside range - apply callback (offsetEnd inclusive => end is +1)
			const rangeStart = Math.max(0, offsetStart - nodeStart);
			const rangeEnd = Math.min(text.length, offsetEnd - nodeStart + 1);
			const rangeText = text.substring(rangeStart, rangeEnd);
			const rangeNode = {
				...node,
				text: rangeText,
			};

			if (hasAnchor && node.anchor) {
				const slicedMap = sliceTextMap(node.anchor.textMap, rangeStart, rangeEnd);
				if (slicedMap) {
					rangeNode.anchor = { ...node.anchor, textMap: slicedMap };
				} else {
					delete rangeNode.anchor;
				}
			}

			const callbackResult = callback(rangeNode);
			if (!targetTextNodeRef) {
				const indexInResult = nodeStart < offsetStart ? 1 : 0;
				const parentPath = parentRef.slice(0, -1);
				const parentIndex = parentRef[parentRef.length - 1];
				targetTextNodeRef = [...parentPath, parentIndex + indexInResult];
			}
			result.push(callbackResult);

			// After range
			if (nodeEnd - 1 > offsetEnd) {
				const afterText = text.substring(offsetEnd - nodeStart + 1);
				const afterNode = {
					...node,
					text: afterText,
				};

				if (hasAnchor && node.anchor) {
					const slicedMap = sliceTextMap(node.anchor.textMap, offsetEnd - nodeStart + 1, text.length);
					if (slicedMap) {
						afterNode.anchor = { ...node.anchor, textMap: slicedMap };
					} else {
						delete afterNode.anchor;
					}
				}

				result.push(afterNode);
			}

			return result;
		}

		// If it has content array, recurse
		if (Array.isArray(node.content)) {
			const newContent = [];
			for (let i = 0; i < node.content.length; i++) {
				const child = node.content[i];
				const childRef = [...parentRef, newContent.length];
				const processed = processNode(child, childRef);
				if (Array.isArray(processed)) {
					newContent.push(...processed);
				} else if (processed) {
					newContent.push(processed);
				}
			}
			return {
				...node,
				content: newContent,
			};
		}

		return node;
	};

	// Persist processed changes back into the referenced block
	const updatedBlock = processNode(block, blockRef);

	if (Array.isArray(updatedBlock)) {
		// Unexpected, but handle defensively by replacing block content
		block.content = updatedBlock;
		return targetTextNodeRef;
	}

	if (updatedBlock && updatedBlock !== block) {
		Object.assign(block, updatedBlock);
	}

	if (didSplit && rangeUpdates.length > 0) {
		for (const update of rangeUpdates) {
			const mapped = getRefForAbsoluteOffset(block, blockRef, update.absOffset);
			if (!mapped) {
				continue;
			}
			update.target.ref = mapped.ref;
			if (update.hasOffset) {
				update.target.offset = mapped.offset;
			}
		}
	}

	return targetTextNodeRef;
}

/**
 * Get text nodes that overlap with a range.
 */
export function getTextNodesAtRange(structure, blockRef, offsetStart, offsetEnd) {
	const block = getBlockByRef(structure, blockRef);
	if (!block) {
		return null;
	}

	if (!Number.isInteger(offsetStart) || !Number.isInteger(offsetEnd)) {
		return null;
	}

	if (offsetEnd < offsetStart) {
		[offsetStart, offsetEnd] = [offsetEnd, offsetStart];
	}

	let currentOffset = 0;
	const results = [];

	const walkTextNodesWithRefs = (node, path) => {
		if (!node || typeof node !== 'object') {
			return true;
		}
		if (typeof node.text === 'string') {
			const len = node.text.length;
			const nodeStart = currentOffset;
			const nodeEnd = currentOffset + len;
			currentOffset = nodeEnd;

			// Check if this node overlaps with the range (inclusive)
			if (nodeEnd - 1 >= offsetStart && nodeStart <= offsetEnd) {
				results.push({
					ref: [...blockRef, ...path],
					offset: Math.max(0, offsetStart - nodeStart),
					endOffset: Math.min(len - 1, offsetEnd - nodeStart)
				});
			}

			// Stop if we've passed the range
			if (nodeStart > offsetEnd) {
				return false;
			}

			return true;
		}
		if (Array.isArray(node.content)) {
			for (let i = 0; i < node.content.length; i++) {
				const child = node.content[i];
				const shouldContinue = walkTextNodesWithRefs(child, [...path, i]);
				if (!shouldContinue) {
					return false;
				}
			}
		}
		return true;
	};

	walkTextNodesWithRefs(block, []);

	return results;
}

// ═══════════════════════════════════════════════════════════════════════════
// Content Ranges
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get content range refs from block indexes.
 */
export function getContentRangeFromBlocks(content, startOffset, endOffset) {
	if (!Array.isArray(content) || content.length === 0) {
		return { start: { ref: null }, end: { ref: null } };
	}

	const isLeaf = (node) => !node || !node.content || node.content.length === 0;

	const firstLeafPath = (node, path) => {
		let current = node;
		let currentPath = [...path];
		while (current && !isLeaf(current)) {
			current = current.content[0];
			currentPath.push(0);
		}
		return current ? currentPath : null;
	};

	const lastLeafPath = (node, path) => {
		let current = node;
		let currentPath = [...path];
		while (current && !isLeaf(current)) {
			const children = current.content;
			const lastIndex = children.length - 1;
			current = children[lastIndex];
			currentPath.push(lastIndex);
		}
		return current ? currentPath : null;
	};

	const maxIndex = content.length - 1;
	const safeStart = Number.isInteger(startOffset) ? Math.max(0, Math.min(startOffset, maxIndex)) : 0;
	const safeEnd = Number.isInteger(endOffset) ? Math.max(0, Math.min(endOffset, maxIndex)) : maxIndex;

	if (safeStart > safeEnd) {
		return { start: { ref: null }, end: { ref: null } };
	}

	const startRef = firstLeafPath(content[safeStart], [safeStart]);
	const endRef = lastLeafPath(content[safeEnd], [safeEnd]);

	return { start: { ref: startRef }, end: { ref: endRef } };
}

/**
 * Move artifact blocks to end of content, updating refs.
 */
export function pushArtifactsToTheEnd(structure) {
	if (!structure) {
		return structure;
	}

	const blocks = structure.content;

	if (!Array.isArray(blocks) || blocks.length === 0) {
		return structure;
	}

	const nonArtifacts = [];
	const artifacts = [];

	for (let i = 0; i < blocks.length; i++) {
		const block = blocks[i];
		if (block && block.artifact) {
			artifacts.push({ block, index: i });
		} else {
			nonArtifacts.push({ block, index: i });
		}
	}

	if (artifacts.length === 0) {
		return structure;
	}

	const indexMap = new Map();
	let nextIndex = 0;
	const reordered = [];

	for (const item of nonArtifacts) {
		indexMap.set(item.index, nextIndex++);
		reordered.push(item.block);
	}

	for (const item of artifacts) {
		indexMap.set(item.index, nextIndex++);
		reordered.push(item.block);
	}

	blocks.length = 0;
	blocks.push(...reordered);

	const updateRefPath = (ref) => {
		if (!Array.isArray(ref) || ref.length === 0) {
			return;
		}
		const mapped = indexMap.get(ref[0]);
		if (typeof mapped === 'number') {
			ref[0] = mapped;
		}
	};

	const updateRefsArray = (refs) => {
		if (!Array.isArray(refs)) {
			return;
		}
		for (const ref of refs) {
			updateRefPath(ref);
		}
	};

	const updateNodeRefs = (node) => {
		if (!node || typeof node !== 'object') {
			return;
		}

		if (Array.isArray(node.ref)) {
			updateRefPath(node.ref);
		}

		updateRefsArray(node.refs);

		if (Array.isArray(node.content)) {
			for (const child of node.content) {
				updateNodeRefs(child);
			}
		}

		if (Array.isArray(node.children)) {
			for (const child of node.children) {
				updateNodeRefs(child);
			}
		}
	};

	for (const block of blocks) {
		updateNodeRefs(block);
	}

	const copyRef = (ref) => (Array.isArray(ref) ? [...ref] : null);

	if (structure && Array.isArray(structure.pages)) {
		for (const page of structure.pages) {
			if (!page || !Array.isArray(page.contentRanges)) {
				continue;
			}

			const updatedRanges = [];

			for (const range of page.contentRanges) {
				const startRef = range && range.start ? range.start.ref : null;
				const endRef = range && range.end ? range.end.ref : null;
				const startIndex = Array.isArray(startRef) ? startRef[0] : null;
				const endIndex = Array.isArray(endRef) ? endRef[0] : null;

				if (!Number.isInteger(startIndex) || !Number.isInteger(endIndex) || startIndex > endIndex) {
					if (range && range.start) {
						updateRefPath(range.start.ref);
					}
					if (range && range.end) {
						updateRefPath(range.end.ref);
					}
					updatedRanges.push(range);
					continue;
				}

				const expanded = [];
				for (let i = startIndex; i <= endIndex; i++) {
					expanded.push({
						oldIndex: i,
						startRef: i === startIndex ? startRef : null,
						endRef: i === endIndex ? endRef : null
					});
				}

				let runStart = 0;
				for (let i = 1; i <= expanded.length; i++) {
					const prev = expanded[i - 1];
					const prevNewIndex = indexMap.get(prev.oldIndex);
					const curr = expanded[i];
					const currNewIndex = curr ? indexMap.get(curr.oldIndex) : null;
					const isConsecutive = curr && prevNewIndex + 1 === currNewIndex;

					if (!curr || !isConsecutive) {
						const first = expanded[runStart];
						const last = expanded[i - 1];
						const startNewIndex = indexMap.get(first.oldIndex);
						const endNewIndex = indexMap.get(last.oldIndex);
						const autoRange = getContentRangeFromBlocks(blocks, startNewIndex, endNewIndex);

						let rangeStartRef = first.startRef ? copyRef(first.startRef) : autoRange.start.ref;
						let rangeEndRef = last.endRef ? copyRef(last.endRef) : autoRange.end.ref;

						if (Array.isArray(rangeStartRef) && Number.isInteger(startNewIndex)) {
							rangeStartRef[0] = startNewIndex;
						}
						if (Array.isArray(rangeEndRef) && Number.isInteger(endNewIndex)) {
							rangeEndRef[0] = endNewIndex;
						}

						updatedRanges.push({
							start: {
								ref: rangeStartRef
							},
							end: {
								ref: rangeEndRef
							}
						});

						runStart = i;
					}
				}
			}

			page.contentRanges = updatedRanges;
		}
	}

	return structure;
}

/**
 * Merge multiple blocks into one, updating refs.
 */
export function mergeBlocks(structure, blockIndexes) {
	if (!structure || !Array.isArray(structure.content) || structure.content.length === 0) {
		return structure;
	}

	if (!Array.isArray(blockIndexes) || blockIndexes.length === 0) {
		return structure;
	}

	const originalContent = structure.content;
	const maxIndex = originalContent.length - 1;

	const groups = [];
	const used = new Set();

	for (const group of blockIndexes) {
		if (!Array.isArray(group)) {
			continue;
		}

		const unique = [];
		const seen = new Set();
		for (const index of group) {
			if (!Number.isInteger(index) || index < 0 || index > maxIndex || seen.has(index)) {
				continue;
			}
			seen.add(index);
			unique.push(index);
		}

		unique.sort((a, b) => a - b);

		const cleaned = [];
		for (const index of unique) {
			if (used.has(index)) {
				continue;
			}
			cleaned.push(index);
		}

		if (cleaned.length < 2) {
			continue;
		}

		for (const index of cleaned) {
			used.add(index);
		}

		groups.push({ indexes: cleaned, start: cleaned[0] });
	}

	if (groups.length === 0) {
		return structure;
	}

	groups.sort((a, b) => b.start - a.start);

	const indexToGroup = new Map();
	for (const group of groups) {
		for (const index of group.indexes) {
			indexToGroup.set(index, group);
		}
	}

	const newContent = [];
	const indexMap = new Map();
	const childIndexMaps = new Map();
	const childTextOffsetMaps = new Map();
	const mergedTextNodeCounts = new Map();

	const ensureChildMap = (blockIndex) => {
		let map = childIndexMaps.get(blockIndex);
		if (!map) {
			map = [];
			childIndexMaps.set(blockIndex, map);
		}
		return map;
	};

	const ensureChildOffsetMap = (blockIndex) => {
		let map = childTextOffsetMaps.get(blockIndex);
		if (!map) {
			map = [];
			childTextOffsetMaps.set(blockIndex, map);
		}
		return map;
	};

	const getTextMapLength = (node) => {
		if (!node || typeof node.text !== 'string') {
			return null;
		}
		const textMap = node.anchor?.textMap;
		if (typeof textMap !== 'string') {
			return null;
		}
		try {
			const runs = JSON.parse(textMap);
			if (!Array.isArray(runs)) {
				return null;
			}
			let total = 0;
			for (const run of runs) {
				if (!Array.isArray(run) || run.length < 6) {
					continue;
				}
				const widthCount = run.length - 6;
				total += Math.max(1, widthCount);
			}
			return Number.isFinite(total) ? total : null;
		} catch {
			return null;
		}
	};

	const mergeGroup = (group) => {
		const mergedIndex = newContent.length;
		const baseBlock = originalContent[group.start];
		const mergedContent = [];
		const contentMeta = [];

		for (const blockIndex of group.indexes) {
			const block = originalContent[blockIndex];
			const blockContent = Array.isArray(block?.content) ? block.content : [];

			for (let i = 0; i < blockContent.length; i++) {
				mergedContent.push(blockContent[i]);
				contentMeta.push({ blockIndex, childIndex: i });
			}
		}

		let currentTextNode = null;
		let currentMergedIndex = -1;
		let nextMergedIndex = 0;
		let currentTextOffset = 0;

		for (let i = 0; i < mergedContent.length; i++) {
			const node = mergedContent[i];
			const meta = contentMeta[i];
			const isTextNode = node && typeof node.text === 'string';

			if (!isTextNode) {
				currentTextNode = null;
				currentMergedIndex = nextMergedIndex++;
				currentTextOffset = 0;
			} else if (!currentTextNode || !canMergeTextNodes(currentTextNode, node)) {
				currentTextNode = node;
				currentMergedIndex = nextMergedIndex++;
				currentTextOffset = 0;
			}

			const map = ensureChildMap(meta.blockIndex);
			map[meta.childIndex] = currentMergedIndex;

			if (isTextNode) {
				const length = getTextMapLength(node);
				const offsetMap = ensureChildOffsetMap(meta.blockIndex);
				if (length != null) {
					offsetMap[meta.childIndex] = { offsetStart: currentTextOffset, length };
					currentTextOffset += length;
				}

				const mergedCount = mergedTextNodeCounts.get(currentMergedIndex) ?? 0;
				mergedTextNodeCounts.set(currentMergedIndex, mergedCount + 1);
			}
		}

		mergeSequentialTextNodes(mergedContent);

		const mergedBlock = baseBlock
			? { ...baseBlock, content: mergedContent }
			: { content: mergedContent };

		const blocksInGroup = group.indexes.map(idx => originalContent[idx]);
		const combinedRects = mergePageRects(blocksInGroup);
		if (combinedRects) {
			mergedBlock.anchor = { ...mergedBlock.anchor, pageRects: combinedRects };
		}

		for (const blockIndex of group.indexes) {
			indexMap.set(blockIndex, mergedIndex);
		}

		newContent.push(mergedBlock);
	};

	for (let i = 0; i < originalContent.length; i++) {
		const group = indexToGroup.get(i);

		if (group) {
			if (group.start !== i) {
				continue;
			}
			mergeGroup(group);
			continue;
		}

		const newIndex = newContent.length;
		newContent.push(originalContent[i]);
		indexMap.set(i, newIndex);
	}

	const isLeaf = (node) => !node || !node.content || node.content.length === 0;

	const firstLeafPath = (node, path) => {
		let current = node;
		let currentPath = [...path];
		while (current && !isLeaf(current)) {
			current = current.content[0];
			currentPath.push(0);
		}
		return current ? currentPath : null;
	};

	const lastLeafPath = (node, path) => {
		let current = node;
		let currentPath = [...path];
		while (current && !isLeaf(current)) {
			const children = current.content;
			const lastIndex = children.length - 1;
			current = children[lastIndex];
			currentPath.push(lastIndex);
		}
		return current ? currentPath : null;
	};

	const getBlockLeafPath = (block, useFirst) => {
		const content = block && Array.isArray(block.content) ? block.content : null;
		if (!content || content.length === 0) {
			return null;
		}

		const startIndex = useFirst ? 0 : content.length - 1;
		return useFirst
			? firstLeafPath(content[startIndex], [startIndex])
			: lastLeafPath(content[startIndex], [startIndex]);
	};

	const mapChildPath = (blockIndex, childPath) => {
		if (!Array.isArray(childPath) || childPath.length === 0) {
			return null;
		}
		const childMap = childIndexMaps.get(blockIndex);
		const mappedFirst = childMap ? childMap[childPath[0]] : childPath[0];
		if (!Number.isInteger(mappedFirst)) {
			return null;
		}
		return [mappedFirst, ...childPath.slice(1)];
	};

	const blockRangeMap = new Map();

	for (let i = 0; i < originalContent.length; i++) {
		const newIndex = indexMap.get(i);
		if (!Number.isInteger(newIndex)) {
			continue;
		}
		const block = originalContent[i];
		const startChild = getBlockLeafPath(block, true);
		const endChild = getBlockLeafPath(block, false);
		const mappedStartChild = mapChildPath(i, startChild);
		const mappedEndChild = mapChildPath(i, endChild);
		const startRef = mappedStartChild ? [newIndex, ...mappedStartChild] : null;
		const endRef = mappedEndChild ? [newIndex, ...mappedEndChild] : null;
		const oldStartRef = startChild ? [i, ...startChild] : null;
		const oldEndRef = endChild ? [i, ...endChild] : null;
		blockRangeMap.set(i, { startRef, endRef, oldStartRef, oldEndRef });
	}

	const mapRefPath = (ref) => {
		if (!Array.isArray(ref) || ref.length === 0) {
			return ref;
		}

		const oldIndex = ref[0];
		const newIndex = indexMap.get(oldIndex);
		if (!Number.isInteger(newIndex)) {
			return ref;
		}

		const mapped = [newIndex];
		if (ref.length > 1) {
			const childMap = childIndexMaps.get(oldIndex);
			const mappedChild = childMap ? childMap[ref[1]] : ref[1];
			if (Number.isInteger(mappedChild)) {
				mapped.push(mappedChild, ...ref.slice(2));
			} else {
				mapped.push(...ref.slice(1));
			}
		}
		return mapped;
	};

	const updateRefPath = (ref) => {
		const mapped = mapRefPath(ref);
		if (!Array.isArray(ref) || !Array.isArray(mapped)) {
			return;
		}
		ref.length = 0;
		ref.push(...mapped);
	};

	const updateRefsArray = (refs) => {
		if (!Array.isArray(refs)) {
			return;
		}
		for (const ref of refs) {
			updateRefPath(ref);
		}
	};

	const updateNodeRefs = (node) => {
		if (!node || typeof node !== 'object') {
			return;
		}

		if (Array.isArray(node.ref)) {
			updateRefPath(node.ref);
		}

		updateRefsArray(node.refs);

		if (Array.isArray(node.content)) {
			for (const child of node.content) {
				updateNodeRefs(child);
			}
		}

		if (Array.isArray(node.children)) {
			for (const child of node.children) {
				updateNodeRefs(child);
			}
		}
	};

	const getMergedTextNodeCount = (ref) => {
		if (!Array.isArray(ref) || ref.length < 2) {
			return 0;
		}
		const oldIndex = ref[0];
		const childIndex = ref[1];
		const childMap = childIndexMaps.get(oldIndex);
		const mergedIndex = childMap ? childMap[childIndex] : null;
		if (!Number.isInteger(mergedIndex)) {
			return 0;
		}
		return mergedTextNodeCounts.get(mergedIndex) ?? 0;
	};

	const getOffsetInfo = (ref) => {
		if (!Array.isArray(ref) || ref.length < 2) {
			return null;
		}
		const oldIndex = ref[0];
		const childIndex = ref[1];
		const offsetMap = childTextOffsetMaps.get(oldIndex);
		const entry = offsetMap ? offsetMap[childIndex] : null;
		if (!entry || !Number.isInteger(entry.offsetStart) || !Number.isInteger(entry.length)) {
			return null;
		}
		return entry;
	};

	const mapOffset = (ref, offset, isEnd) => {
		const hasOffset = Number.isInteger(offset);
		const needsOffset = hasOffset || getMergedTextNodeCount(ref) > 1;
		if (!needsOffset) {
			return null;
		}

		const info = getOffsetInfo(ref);
		if (info) {
			if (hasOffset) {
				return info.offsetStart + offset;
			}
			return info.offsetStart + (isEnd ? Math.max(0, info.length - 1) : 0);
		}

		return hasOffset ? offset : null;
	};

	structure.content = newContent;

	for (const block of structure.content) {
		updateNodeRefs(block);
	}

	if (Array.isArray(structure.pages)) {
		for (const page of structure.pages) {
			if (!page || !Array.isArray(page.contentRanges)) {
				continue;
			}

			const updatedRanges = [];

			for (const range of page.contentRanges) {
				const startRef = range && range.start ? range.start.ref : null;
				const endRef = range && range.end ? range.end.ref : null;
				const startIndex = Array.isArray(startRef) ? startRef[0] : null;
				const endIndex = Array.isArray(endRef) ? endRef[0] : null;

				if (!Number.isInteger(startIndex) || !Number.isInteger(endIndex) || startIndex > endIndex) {
					if (range && range.start) {
						const mappedOffset = mapOffset(range.start.ref, range.start.offset, false);
						updateRefPath(range.start.ref);
						if (Number.isInteger(mappedOffset)) {
							range.start.offset = mappedOffset;
						}
					}
					if (range && range.end) {
						const mappedOffset = mapOffset(range.end.ref, range.end.offset, true);
						updateRefPath(range.end.ref);
						if (Number.isInteger(mappedOffset)) {
							range.end.offset = mappedOffset;
						}
					}
					updatedRanges.push(range);
					continue;
				}

				const expanded = [];
				for (let i = startIndex; i <= endIndex; i++) {
					const segment = blockRangeMap.get(i);
					const mappedStart = i === startIndex ? mapRefPath(startRef) : segment?.startRef;
					const mappedEnd = i === endIndex ? mapRefPath(endRef) : segment?.endRef;
					const oldStartRef = i === startIndex ? startRef : segment?.oldStartRef;
					const oldEndRef = i === endIndex ? endRef : segment?.oldEndRef;

					expanded.push({
						oldIndex: i,
						startRef: mappedStart ?? segment?.startRef ?? null,
						endRef: mappedEnd ?? segment?.endRef ?? null,
						oldStartRef,
						oldEndRef
					});
				}

				let runStart = 0;
				for (let i = 1; i <= expanded.length; i++) {
					const prev = expanded[i - 1];
					const prevNewIndex = indexMap.get(prev.oldIndex);
					const curr = expanded[i];
					const currNewIndex = curr ? indexMap.get(curr.oldIndex) : null;
					const isConsecutive = curr && Number.isInteger(prevNewIndex) && Number.isInteger(currNewIndex)
						&& prevNewIndex + 1 === currNewIndex;

					if (!curr || !isConsecutive) {
						const first = expanded[runStart];
						const last = expanded[i - 1];
						const startNewIndex = indexMap.get(first.oldIndex);
						const endNewIndex = indexMap.get(last.oldIndex);

						const autoRange = (Number.isInteger(startNewIndex) && Number.isInteger(endNewIndex))
							? getContentRangeFromBlocks(structure.content, startNewIndex, endNewIndex)
							: { start: { ref: null }, end: { ref: null } };

						let rangeStartRef = first.startRef ? [...first.startRef] : autoRange.start.ref;
						let rangeEndRef = last.endRef ? [...last.endRef] : autoRange.end.ref;

						if (Array.isArray(rangeStartRef) && Number.isInteger(startNewIndex)) {
							rangeStartRef[0] = startNewIndex;
						}
						if (Array.isArray(rangeEndRef) && Number.isInteger(endNewIndex)) {
							rangeEndRef[0] = endNewIndex;
						}

						const startOffset = mapOffset(
							first.oldStartRef,
							first.oldIndex === startIndex ? range?.start?.offset : null,
							false
						);
						const endOffset = mapOffset(
							last.oldEndRef,
							last.oldIndex === endIndex ? range?.end?.offset : null,
							true
						);

						updatedRanges.push({
							start: {
								ref: rangeStartRef,
								...(Number.isInteger(startOffset) ? { offset: startOffset } : {})
							},
							end: {
								ref: rangeEndRef,
								...(Number.isInteger(endOffset) ? { offset: endOffset } : {})
							}
						});

						runStart = i;
					}
				}
			}

			page.contentRanges = updatedRanges;
		}
	}

	return structure;
}

// ═══════════════════════════════════════════════════════════════════════════
// Cursor Navigation
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get next character in document order, advancing cursor.
 */
export function nextChar(structure, cursor) {
	if (!structure || !Array.isArray(structure.content) || !cursor || typeof cursor !== 'object') {
		return null;
	}

	const isTextNode = (node) => node && typeof node.text === 'string';

	const getNodeByRef = (content, ref) => {
		if (!Array.isArray(ref) || ref.length === 0) {
			return null;
		}
		let current = { content };
		for (const index of ref) {
			if (!current || !Array.isArray(current.content)) {
				return null;
			}
			if (!Number.isInteger(index) || index < 0 || index >= current.content.length) {
				return null;
			}
			current = current.content[index];
		}
		return current;
	};

	const findFirstTextRefInNode = (node, baseRef) => {
		if (!node) {
			return null;
		}
		if (isTextNode(node)) {
			return baseRef;
		}
		if (!Array.isArray(node.content)) {
			return null;
		}
		for (let i = 0; i < node.content.length; i++) {
			const childRef = findFirstTextRefInNode(node.content[i], [...baseRef, i]);
			if (childRef) {
				return childRef;
			}
		}
		return null;
	};

	const getPathInfo = (content, ref) => {
		if (!Array.isArray(ref) || ref.length === 0) {
			return null;
		}
		const pathInfo = [];
		let currentContent = content;
		for (const index of ref) {
			if (!Array.isArray(currentContent)) {
				return null;
			}
			if (!Number.isInteger(index) || index < 0 || index >= currentContent.length) {
				return null;
			}
			pathInfo.push({ parentContent: currentContent, index });
			const node = currentContent[index];
			currentContent = Array.isArray(node?.content) ? node.content : null;
		}
		return pathInfo;
	};

	const findNextTextRef = (content, ref) => {
		const pathInfo = getPathInfo(content, ref);
		if (!pathInfo) {
			return null;
		}
		for (let depth = pathInfo.length - 1; depth >= 0; depth--) {
			const { parentContent, index } = pathInfo[depth];
			for (let nextIndex = index + 1; nextIndex < parentContent.length; nextIndex++) {
				const baseRef = [...ref.slice(0, depth), nextIndex];
				const found = findFirstTextRefInNode(parentContent[nextIndex], baseRef);
				if (found) {
					return found;
				}
			}
		}
		return null;
	};

	let currentRef = Array.isArray(cursor.ref) ? cursor.ref : null;
	let currentOffset = Number.isInteger(cursor.offset) ? cursor.offset : 0;

	while (true) {
		if (!currentRef) {
			cursor.ref = null;
			cursor.offset = 0;
			return null;
		}

		const node = getNodeByRef(structure.content, currentRef);
		if (!node) {
			currentRef = findNextTextRef(structure.content, currentRef);
			currentOffset = 0;
			if (!currentRef) {
				cursor.ref = null;
				cursor.offset = 0;
				return null;
			}
			continue;
		}

		if (!isTextNode(node)) {
			const nestedRef = findFirstTextRefInNode(node, currentRef);
			if (nestedRef) {
				currentRef = nestedRef;
				currentOffset = 0;
			} else {
				currentRef = findNextTextRef(structure.content, currentRef);
				currentOffset = 0;
			}
			if (!currentRef) {
				cursor.ref = null;
				cursor.offset = 0;
				return null;
			}
			continue;
		}

		if (!Number.isInteger(currentOffset) || currentOffset < 0) {
			currentOffset = 0;
		}

		if (currentOffset < node.text.length) {
			const ch = node.text.charAt(currentOffset);
			cursor.ref = currentRef;
			cursor.offset = currentOffset + 1;
			return ch;
		}

		currentRef = findNextTextRef(structure.content, currentRef);
		currentOffset = 0;
		if (!currentRef) {
			cursor.ref = null;
			cursor.offset = 0;
			return null;
		}
	}
}

/**
 * Get next character within a single top-level block.
 */
export function nextBlockChar(structure, cursor) {
	if (!structure || !Array.isArray(structure.content) || !cursor || typeof cursor !== 'object') {
		return null;
	}

	const blockIndex = Array.isArray(cursor.ref) ? cursor.ref[0] : null;
	if (!Number.isInteger(blockIndex) || blockIndex < 0 || blockIndex >= structure.content.length) {
		cursor.ref = null;
		cursor.offset = 0;
		return null;
	}

	const block = structure.content[blockIndex];
	const localCursor = {
		ref: Array.isArray(cursor.ref) ? [0, ...cursor.ref.slice(1)] : [0],
		offset: Number.isInteger(cursor.offset) ? cursor.offset : 0
	};

	const ch = nextChar({ content: [block] }, localCursor);
	if (ch === null) {
		cursor.ref = null;
		cursor.offset = 0;
		return null;
	}

	cursor.ref = [blockIndex, ...localCursor.ref.slice(1)];
	cursor.offset = localCursor.offset;
	return ch;
}
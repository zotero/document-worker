import { intersectRects } from '../util.js';
import { parseTextMap, buildRunData } from '../zst/decode.js';

function walkLeafBlocks(node, ref, callback) {
	if (!node || typeof node.text === 'string') return;
	const content = node.content;
	if (!Array.isArray(content) || content.length === 0) {
		callback(node, ref);
		return;
	}
	const hasChildBlock = content.some(child => child && typeof child.text !== 'string');
	if (!hasChildBlock) {
		callback(node, ref);
		return;
	}
	for (let i = 0; i < content.length; i++) {
		walkLeafBlocks(content[i], [...ref, i], callback);
	}
}

export function getRefRangesFromPageRects(structure, pageRects) {
	if (!pageRects || pageRects.length === 0) return [];

	// Group chunk page rects by pageIndex
	const pageRectsMap = new Map();
	for (const pr of pageRects) {
		if (!Array.isArray(pr) || pr.length < 5) continue;
		const pageIndex = pr[0];
		const rect = [pr[1], pr[2], pr[3], pr[4]];
		if (!Number.isFinite(pageIndex)) continue;
		if (!pageRectsMap.has(pageIndex)) {
			pageRectsMap.set(pageIndex, []);
		}
		pageRectsMap.get(pageIndex).push(rect);
	}

	const refSet = new Set();
	const refRanges = [];

	for (const [pageIndex, chunkRects] of pageRectsMap) {
		const page = structure.pages?.[pageIndex];
		if (!page || !Array.isArray(page.contentRanges)) continue;

		for (const range of page.contentRanges) {
			if (!range.start?.ref || !range.end?.ref) continue;

			const startTopLevel = range.start.ref[0];
			const endTopLevel = range.end.ref[0];

			for (let i = startTopLevel; i <= endTopLevel; i++) {
				const block = structure.content[i];
				if (!block) continue;

				walkLeafBlocks(block, [i], (leafNode, leafRef) => {
					const pageRects = leafNode.anchor?.pageRects;
					if (!Array.isArray(pageRects)) return;

					for (const pr of pageRects) {
						if (!Array.isArray(pr) || pr.length < 5) continue;
						if (pr[0] !== pageIndex) continue;
						const blockRect = [pr[1], pr[2], pr[3], pr[4]];

						for (const chunkRect of chunkRects) {
							if (intersectRects(blockRect, chunkRect)) {
								const refKey = leafRef.join(',');
								if (!refSet.has(refKey)) {
									refSet.add(refKey);
									refRanges.push({
										start: { ref: leafRef },
										end: { ref: leafRef }
									});
								}
								return;
							}
						}
					}
				});
			}
		}
	}

	return refRanges;
}

export function getContent(structure, refRanges) {
	if (!structure || !Array.isArray(structure.content) || structure.content.length === 0) {
		return [];
	}

	// Determine which top-level block indices are included
	const includedIndices = new Set();
	if (Array.isArray(refRanges) && refRanges.length > 0) {
		for (const range of refRanges) {
			const startIdx = range?.start?.ref?.[0];
			const endIdx = range?.end?.ref?.[0];
			if (!Number.isInteger(startIdx) || !Number.isInteger(endIdx)) continue;
			for (let i = startIdx; i <= endIdx; i++) {
				includedIndices.add(i);
			}
		}
	} else {
		for (let i = 0; i < structure.content.length; i++) {
			includedIndices.add(i);
		}
	}

	const segmenter = new Intl.Segmenter(undefined, { granularity: 'sentence' });

	// Extract text segments from a leaf block's text nodes
	function extractTextSegments(block) {
		const segments = [];
		const content = Array.isArray(block.content) ? block.content : [];
		for (const node of content) {
			if (!node || typeof node.text !== 'string') continue;
			segments.push({ text: node.text });
		}
		return segments;
	}

	// Convert text segments to a plain string
	function textSegmentsToString(segments) {
		let result = '';
		for (const seg of segments) {
			result += seg.text;
		}
		return result;
	}

	// Slice text segments by character offset range [start, end)
	function sliceSegments(segments, start, end) {
		const result = [];
		let offset = 0;
		for (const seg of segments) {
			const segStart = offset;
			const segEnd = offset + seg.text.length;
			offset = segEnd;
			if (segEnd <= start || segStart >= end) continue;
			const sliceStart = Math.max(0, start - segStart);
			const sliceEnd = Math.min(seg.text.length, end - segStart);
			result.push({ text: seg.text.substring(sliceStart, sliceEnd) });
		}
		return result;
	}

	// Process a leaf block: extract text, segment sentences, generate JSON output
	function processLeafBlock(block, ref) {
		const type = block.type || 'block';
		const refPath = ref.join('.');
		const segments = extractTextSegments(block);
		const plainText = segments.map(s => s.text).join('');
		const trimmedPlainText = plainText.trim();

		if (!trimmedPlainText) {
			return {
				type,
				ref: refPath,
				content: []
			};
		}

		const sentences = [...segmenter.segment(plainText)];
		const content = [];
		for (let si = 0; si < sentences.length; si++) {
			const sent = sentences[si];
			const sentSegments = sliceSegments(segments, sent.index, sent.index + sent.segment.length);
			content.push({ sid: si, text: textSegmentsToString(sentSegments).trim() });
		}

		return {
			type,
			ref: refPath,
			content
		};
	}

	// Process a block recursively
	function processBlock(block, ref) {
		if (!block) return '';

		const content = Array.isArray(block.content) ? block.content : [];
		const hasChildBlock = content.some(child => child && typeof child.text !== 'string');

		if (!hasChildBlock) {
			// Leaf block
			return processLeafBlock(block, ref);
		}

		// Container block (e.g. list containing listitems)
		const result = {
			type: block.type || 'block',
			ref: ref.join('.'),
			content: []
		};
		for (let i = 0; i < content.length; i++) {
			const child = content[i];
			if (!child || typeof child.text === 'string') continue;
			result.content.push(processBlock(child, [...ref, i]));
		}
		return result;
	}

	const parts = [];
	const sortedIndices = [...includedIndices].sort((a, b) => a - b);

	for (const i of sortedIndices) {
		const block = structure.content[i];
		if (!block) continue;
		if (block.artifact) break;
		parts.push(processBlock(block, [i]));
	}

	return parts;
}

export function getSentencePageRects(structure, ref, sentenceIndex) {
	function isWhitespaceChar(ch) {
		return ch === ' ' || ch === '\n' || ch === '\t';
	}

	function isValidRect(rect) {
		return Array.isArray(rect)
			&& rect.length >= 4
			&& Number.isFinite(rect[0])
			&& Number.isFinite(rect[1])
			&& Number.isFinite(rect[2])
			&& Number.isFinite(rect[3]);
	}

	function dedupePageRects(pageRects) {
		const seen = new Set();
		const out = [];
		for (const pr of pageRects) {
			if (!Array.isArray(pr) || pr.length < 5) continue;
			if (!Number.isFinite(pr[0]) || !isValidRect([pr[1], pr[2], pr[3], pr[4]])) continue;
			const key = `${pr[0]}|${pr[1]}|${pr[2]}|${pr[3]}|${pr[4]}`;
			if (seen.has(key)) continue;
			seen.add(key);
			out.push(pr);
		}
		return out;
	}

	function parseSentenceIndex(value) {
		if (Number.isInteger(value) && value >= 0) return value;
		if (typeof value !== 'string') return null;
		const m = value.match(/s(\d+)$/i) || value.match(/^(\d+)$/);
		if (!m) return null;
		return parseInt(m[1], 10);
	}

	function parseRefPath(value) {
		if (!Array.isArray(value)) return null;
		if (!value.every(v => Number.isInteger(v) && v >= 0)) return null;
		return value;
	}

	function resolveBlockByRef(root, refPath) {
		let node = { content: root?.content };
		for (const idx of refPath) {
			if (!Array.isArray(node?.content) || idx < 0 || idx >= node.content.length) {
				return null;
			}
			node = node.content[idx];
			if (!node || typeof node !== 'object') {
				return null;
			}
		}
		return node;
	}

	function extractTextNodes(block) {
		const nodes = Array.isArray(block?.content) ? block.content : [];
		return nodes.filter(node => node && typeof node.text === 'string');
	}

	function getPlainTextFromNodes(nodes) {
		let text = '';
		for (const node of nodes) {
			text += node.text;
		}
		return text;
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

	function getCharMappingFromNodes(nodes) {
		const rects = [];
		const pageIndexes = [];
		for (const node of nodes) {
			const text = node.text;
			const runs = buildRunData(parseTextMap(node.anchor?.textMap));
			if (!runs.length) {
				for (let i = 0; i < text.length; i++) {
					rects.push(null);
					pageIndexes.push(null);
				}
				continue;
			}
			const mapped = mapTextToRuns(text, runs);
			rects.push(...mapped.rects);
			pageIndexes.push(...mapped.pageIndexes);
		}
		return { rects, pageIndexes };
	}

	function sameLine(rectA, rectB) {
		const overlap = Math.min(rectA[3], rectB[3]) - Math.max(rectA[1], rectB[1]);
		const hA = rectA[3] - rectA[1];
		const hB = rectB[3] - rectB[1];
		const minH = Math.max(0.001, Math.min(hA, hB));
		return overlap / minH >= 0.6;
	}

	function collectSentenceRects(charRects, pageIndexes, start, end) {
		const result = [];
		let current = null;
		const flush = () => {
			if (!current) return;
			result.push(current);
			current = null;
		};

		for (let i = start; i < end; i++) {
			const rect = charRects[i];
			const pageIndex = pageIndexes[i];
			if (!isValidRect(rect) || !Number.isFinite(pageIndex)) {
				flush();
				continue;
			}
			if (!current) {
				current = [pageIndex, rect[0], rect[1], rect[2], rect[3]];
				continue;
			}
			const curRect = [current[1], current[2], current[3], current[4]];
			const gap = rect[0] - curRect[2];
			const height = Math.max(curRect[3] - curRect[1], rect[3] - rect[1]);
			const canMerge = pageIndex === current[0] && sameLine(curRect, rect) && gap <= Math.max(5, height * 2);

			if (canMerge) {
				current[1] = Math.min(current[1], rect[0]);
				current[2] = Math.min(current[2], rect[1]);
				current[3] = Math.max(current[3], rect[2]);
				current[4] = Math.max(current[4], rect[3]);
			}
			else {
				flush();
				current = [pageIndex, rect[0], rect[1], rect[2], rect[3]];
			}
		}

		flush();
		return dedupePageRects(result);
	}

	function getBlockPageRects(block) {
		const pageRects = Array.isArray(block?.anchor?.pageRects) ? block.anchor.pageRects : [];
		return dedupePageRects(pageRects.filter(pr =>
			Array.isArray(pr)
			&& pr.length >= 5
			&& Number.isFinite(pr[0])
			&& isValidRect([pr[1], pr[2], pr[3], pr[4]])
		));
	}

	function proportionalSlice(pageRects, start, end, totalLength) {
		if (!pageRects.length) return [];
		if (!Number.isFinite(totalLength) || totalLength <= 0) return pageRects;
		const fromRatio = Math.max(0, Math.min(1, start / totalLength));
		const toRatio = Math.max(fromRatio, Math.min(1, end / totalLength));

		const fromIdx = Math.min(pageRects.length - 1, Math.floor(fromRatio * pageRects.length));
		const rawTo = Math.ceil(toRatio * pageRects.length);
		const toIdx = Math.max(fromIdx + 1, Math.min(pageRects.length, rawTo));
		return pageRects.slice(fromIdx, toIdx);
	}

	function sliceBySentenceIndex(pageRects, sentenceIdx, sentenceCount) {
		if (!pageRects.length) return [];
		if (!Number.isInteger(sentenceIdx) || sentenceIdx < 0) return [];
		if (!Number.isInteger(sentenceCount) || sentenceCount <= 0) return pageRects;
		const fromIdx = Math.min(
			pageRects.length - 1,
			Math.floor(sentenceIdx * pageRects.length / sentenceCount)
		);
		const toIdx = Math.max(
			fromIdx + 1,
			Math.min(pageRects.length, Math.floor((sentenceIdx + 1) * pageRects.length / sentenceCount))
		);
		return pageRects.slice(fromIdx, toIdx);
	}

	const refPath = parseRefPath(ref);
	const normalizedSentenceIndex = parseSentenceIndex(sentenceIndex);
	if (!refPath || normalizedSentenceIndex === null) {
		return [];
	}

	const block = resolveBlockByRef(structure, refPath);
	if (!block) {
		return [];
	}

	const textNodes = extractTextNodes(block);
	if (!textNodes.length) {
		return getBlockPageRects(block);
	}

	const plainText = getPlainTextFromNodes(textNodes);
	if (!plainText) {
		return getBlockPageRects(block);
	}

	const segmenter = new Intl.Segmenter(undefined, { granularity: 'sentence' });
	const sentences = [...segmenter.segment(plainText)];

	if (!sentences.length) {
		return getBlockPageRects(block);
	}
	if (normalizedSentenceIndex < 0 || normalizedSentenceIndex >= sentences.length) {
		return [];
	}

	const sentence = sentences[normalizedSentenceIndex];
	const sentStart = sentence.index;
	const sentEnd = sentence.index + sentence.segment.length;
	const mapped = getCharMappingFromNodes(textNodes);
	const hasAnyCharRects = mapped.rects.some(isValidRect);

	if (hasAnyCharRects) {
		return collectSentenceRects(mapped.rects, mapped.pageIndexes, sentStart, sentEnd);
	}

	const blockRects = getBlockPageRects(block);
	if (!blockRects.length) return [];
	if (sentences.length === 1) return blockRects;
	const slicedBySentence = sliceBySentenceIndex(blockRects, normalizedSentenceIndex, sentences.length);
	if (slicedBySentence.length) {
		return slicedBySentence;
	}
	return proportionalSlice(blockRects, sentStart, sentEnd, plainText.length);
}

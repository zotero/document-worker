const MIN_MATCHED_HEADINGS = 4;
const MIN_MATCH_DENSITY = 0.5;
const MIN_ORDERED_FRACTION = 0.75;
const MIN_TITLE_LENGTH = 5;
const MAX_WRAPPED_ENTRY_LINES = 4;

function isValidRect(rect) {
	return Array.isArray(rect)
		&& rect.length === 4
		&& Number.isFinite(rect[0])
		&& Number.isFinite(rect[1])
		&& Number.isFinite(rect[2])
		&& Number.isFinite(rect[3])
		&& rect[2] >= rect[0]
		&& rect[3] >= rect[1];
}

function compactText(text) {
	const value = String(text || '');
	let ascii = true;
	let compact = '';
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code > 0x7f) {
			ascii = false;
			break;
		}
		if (code >= 48 && code <= 57) compact += value[index];
		else if (code >= 65 && code <= 90) compact += String.fromCharCode(code + 32);
		else if (code >= 97 && code <= 122) compact += value[index];
	}
	if (ascii) return compact;
	return value
		.normalize('NFKC')
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]/gu, '');
}

function getTitleKey(text) {
	if (!/\p{L}/u.test(text || '')) return null;
	const key = compactText(text);
	return key.length >= MIN_TITLE_LENGTH ? key : null;
}

function getLineId(line, fallback) {
	return Number.isInteger(line?.id) ? line.id : fallback;
}

function getLineStartOffset(line, fallback = 0) {
	return Number.isInteger(line?.startOffset) ? line.startOffset : fallback;
}

function getLineEndOffset(line, fallback = 0) {
	return Number.isInteger(line?.endOffset)
		? line.endOffset
		: getLineStartOffset(line, fallback);
}

function getLineCenterY(line) {
	return (line.rect[1] + line.rect[3]) / 2;
}

function getLineHeight(line) {
	return Math.max(0, line.rect[3] - line.rect[1]);
}

function rectsIntersect(a, b) {
	return isValidRect(a) && isValidRect(b)
		&& !(b[0] > a[2] || b[2] < a[0] || b[1] > a[3] || b[3] < a[1]);
}

function unionRects(lines) {
	let bbox = null;
	for (const line of lines) {
		if (!isValidRect(line?.rect)) continue;
		if (!bbox) {
			bbox = line.rect.slice();
			continue;
		}
		bbox[0] = Math.min(bbox[0], line.rect[0]);
		bbox[1] = Math.min(bbox[1], line.rect[1]);
		bbox[2] = Math.max(bbox[2], line.rect[2]);
		bbox[3] = Math.max(bbox[3], line.rect[3]);
	}
	return bbox;
}

function median(values) {
	if (!values.length) return 0;
	const sorted = values.slice().sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2
		? sorted[middle]
		: (sorted[middle - 1] + sorted[middle]) / 2;
}

function orderedFraction(values) {
	if (values.length < 2) return 0;
	let ordered = 0;
	for (let index = 1; index < values.length; index++) {
		if (values[index] >= values[index - 1]) ordered++;
	}
	return ordered / (values.length - 1);
}

export function createContentsHeadingIndex(nodes) {
	const entries = [];
	const entriesByPrefix = new Map();
	for (let index = 0; index < (nodes || []).length; index++) {
		const node = nodes[index];
		if (!Number.isInteger(node?._pageIndex)) continue;
		const key = getTitleKey(node.title);
		if (!key) continue;
		const entry = {
			index,
			key,
			title: node.title,
			targetPage: node._pageIndex,
		};
		entries.push(entry);
		const prefix = key.slice(0, MIN_TITLE_LENGTH);
		const prefixEntries = entriesByPrefix.get(prefix) || [];
		prefixEntries.push(entry);
		entriesByPrefix.set(prefix, prefixEntries);
	}
	return { entries, entriesByPrefix };
}

function getLinkedDestinations(line, links) {
	const destinations = new Map();
	for (const link of links || []) {
		if (!Number.isInteger(link?.dest?.pageIndex)) continue;
		if (!rectsIntersect(line.rect, link?.src?.rect)) continue;
		const destination = {
			pageIndex: link.dest.pageIndex,
			...(isValidRect(link.dest.rect) && { rect: link.dest.rect.slice() }),
		};
		const key = `${destination.pageIndex}|${destination.rect?.join(',') || ''}`;
		destinations.set(key, destination);
	}
	return [...destinations.values()];
}

function getLinesLinkedDestinations(lines, links) {
	const destinations = new Map();
	for (const line of lines) {
		for (const destination of getLinkedDestinations(line, links)) {
			const key = `${destination.pageIndex}|${destination.rect?.join(',') || ''}`;
			destinations.set(key, destination);
		}
	}
	return [...destinations.values()];
}

function getHeadingCandidates(headingIndex, lineKey) {
	if (headingIndex?.entriesByPrefix instanceof Map) {
		return headingIndex.entriesByPrefix.get(
			lineKey.slice(0, MIN_TITLE_LENGTH),
		) || [];
	}
	return headingIndex?.entries || [];
}

function matchHeadingKey(lineKey, headingIndex, pageIndex) {
	if (!lineKey) return null;
	const matches = getHeadingCandidates(headingIndex, lineKey)
		.filter(entry => (
			entry.targetPage > pageIndex
			&& lineKey.startsWith(entry.key)
			&& lineKey.length - entry.key.length <= Math.max(12, Math.floor(entry.key.length * 0.3))
		))
		.sort((a, b) => b.key.length - a.key.length || a.targetPage - b.targetPage);
	if (!matches.length) return null;

	// Ambiguous repeated headings do not provide evidence. Concentration should
	// come from titles that identify one independent location in the body.
	const longest = matches[0].key.length;
	const best = matches.filter(match => match.key.length === longest);
	if (best.length !== 1) return null;
	return best[0];
}

function matchHeading(line, headingIndex, pageIndex) {
	return matchHeadingKey(getTitleKey(line.text), headingIndex, pageIndex);
}

function couldExtendToHeading(text, headingIndex, pageIndex) {
	const lineKey = getTitleKey(text);
	if (!lineKey) return true;
	return getHeadingCandidates(headingIndex, lineKey)
		.some(entry => entry.targetPage > pageIndex && entry.key.startsWith(lineKey));
}

function areWrappedEntryLines(previousLine, nextLine) {
	if (!isValidRect(previousLine?.rect) || !isValidRect(nextLine?.rect)) {
		return false;
	}

	const previousWidth = previousLine.rect[2] - previousLine.rect[0];
	const nextWidth = nextLine.rect[2] - nextLine.rect[0];
	const horizontalOverlap = Math.min(previousLine.rect[2], nextLine.rect[2])
		- Math.max(previousLine.rect[0], nextLine.rect[0]);
	if (horizontalOverlap <= 0 || previousWidth <= 0 || nextWidth <= 0) {
		return false;
	}

	const verticalGap = Math.max(
		0,
		Math.max(previousLine.rect[1], nextLine.rect[1])
			- Math.min(previousLine.rect[3], nextLine.rect[3]),
	);
	const lineHeight = Math.max(
		1,
		getLineHeight(previousLine),
		getLineHeight(nextLine),
	);
	return verticalGap <= lineHeight * 1.5;
}

/**
 * Match physical page lines against headings inferred elsewhere in the PDF.
 * Detection deliberately has no vocabulary, locator, numbering, or link rules.
 */
export function getContentsEvidence(lines, links, headingIndex, pageIndex) {
	const matches = [];
	const usedEntries = new Set();
	const directMatches = (lines || []).map(line => (
		isValidRect(line?.rect) ? matchHeading(line, headingIndex, pageIndex) : null
	));
	for (let index = 0; index < (lines || []).length; index++) {
		const line = lines[index];
		if (!isValidRect(line?.rect)) continue;
		let matchedLines = [line];
		let heading = directMatches[index];
		let combinedText = String(line.text || '');
		if (!heading && couldExtendToHeading(combinedText, headingIndex, pageIndex)) {
			for (
				let nextIndex = index + 1;
				nextIndex < lines.length
					&& nextIndex < index + MAX_WRAPPED_ENTRY_LINES;
				nextIndex++
			) {
				const nextLine = lines[nextIndex];
				if (
					directMatches[nextIndex]
					|| !areWrappedEntryLines(matchedLines.at(-1), nextLine)
				) {
					break;
				}
				matchedLines.push(nextLine);
				combinedText += ` ${nextLine.text || ''}`;
				const combinedKey = getTitleKey(combinedText);
				heading = matchHeadingKey(combinedKey, headingIndex, pageIndex);
				if (heading) {
					break;
				}
				if (!couldExtendToHeading(combinedText, headingIndex, pageIndex)) {
					break;
				}
			}
		}
		if (!heading || usedEntries.has(heading.index)) continue;
		usedEntries.add(heading.index);
		matches.push({
			lineIds: matchedLines.map((matchedLine, matchedIndex) => (
				getLineId(matchedLine, index + matchedIndex)
			)),
			startOffset: getLineStartOffset(line, index),
			endOffset: getLineEndOffset(matchedLines.at(-1), index + matchedLines.length - 1),
			title: heading.title,
			titleKey: heading.key,
			targetPage: heading.targetPage,
			linkDestinations: getLinesLinkedDestinations(matchedLines, links),
		});
		index += matchedLines.length - 1;
	}
	return { pageIndex, matches };
}

function findVisualHeading(rows, lines, pageRect) {
	if (!rows.length || !isValidRect(pageRect)) return null;
	const firstOffset = rows[0].startOffset;
	const rowIds = new Set(rows.flatMap(row => row.lineIds));
	const heading = lines
		.filter((line, index) => (
			!rowIds.has(getLineId(line, index))
			&& getLineEndOffset(line, index) < firstOffset
			&& isValidRect(line?.rect)
			&& getTitleKey(line.text)
		))
		.at(-1);
	if (!heading) return null;

	const pageWidth = pageRect[2] - pageRect[0];
	const rowLines = rows
		.flatMap(row => row.lineIds.map(lineId => lines[lineId]))
		.filter(line => isValidRect(line?.rect));
	const rowHeight = median(rowLines.map(getLineHeight));
	const verticalGap = getLineCenterY(heading)
		- Math.max(...rowLines.map(getLineCenterY));
	if (
		heading.rect[2] - heading.rect[0] <= pageWidth * 0.7
		&& (getLineHeight(heading) >= rowHeight * 1.08 || verticalGap >= rowHeight * 1.8)
	) {
		return heading;
	}
	return null;
}

/** Confirm a navigation span from a dense, ordered repetition of body headings. */
export function detectContentsRegion(lines, pageRect, options = {}) {
	if (!Array.isArray(lines) || !isValidRect(pageRect)) return null;
	const matches = (options.evidence?.matches || [])
		.slice()
		.sort((a, b) => a.startOffset - b.startOffset);
	if (matches.length < MIN_MATCHED_HEADINGS) return null;
	if (orderedFraction(matches.map(match => match.targetPage)) < MIN_ORDERED_FRACTION) return null;

	const firstOffset = matches[0].startOffset;
	const lastOffset = matches.at(-1).endOffset;
	const spanLines = lines.filter((line, index) => (
		isValidRect(line?.rect)
		&& getTitleKey(line.text)
		&& getLineStartOffset(line, index) >= firstOffset
		&& getLineEndOffset(line, index) <= lastOffset
	));
	const matchedLineIds = new Set(matches.flatMap(match => match.lineIds));
	if (matchedLineIds.size / Math.max(1, spanLines.length) < MIN_MATCH_DENSITY) return null;

	const matchesByLine = new Map(matches.map(match => [match.lineIds[0], match]));
	const rows = spanLines.flatMap((line) => {
		const lineId = getLineId(line, lines.indexOf(line));
		if (matchedLineIds.has(lineId) && !matchesByLine.has(lineId)) return [];
		const match = matchesByLine.get(lineId);
		return [{
			lineIds: match?.lineIds || [lineId],
			title: match?.title || String(line.text || '').trim(),
			titleKey: match?.titleKey || getTitleKey(line.text),
			linkDestinations: match?.linkDestinations
				|| getLinkedDestinations(line, options.links),
		}];
	});
	const heading = findVisualHeading(rows.map(row => {
		const firstLine = lines[row.lineIds[0]];
		const lastLine = lines[row.lineIds.at(-1)];
		return {
			...row,
			startOffset: getLineStartOffset(firstLine),
			endOffset: getLineEndOffset(lastLine),
		};
	}), lines, pageRect);
	return {
		headingLineIds: heading ? [getLineId(heading, lines.indexOf(heading))] : [],
		rows,
		source: 'heading-concentration',
	};
}

function createBlockFromLineIds(source, lineIds, lines) {
	const selectedLines = lineIds.map(id => lines[id]).filter(Boolean);
	const startOffset = Math.min(...selectedLines.map((line, index) => (
		getLineStartOffset(line, index)
	)));
	const endOffset = Math.max(...selectedLines.map((line, index) => (
		getLineEndOffset(line, index)
	)));
	return {
		...source,
		lines: lineIds,
		bbox: unionRects(selectedLines) || source.bbox,
		startOffset,
		endOffset,
	};
}

function splitResidualBlock(block, claimedLineIds, lines, claimedOffsets) {
	if (!Array.isArray(block?.lines) || !block.lines.length) return [block];
	const remaining = block.lines
		.filter(lineId => lines[lineId] && !claimedLineIds.has(lineId))
		.sort((a, b) => getLineStartOffset(lines[a], a) - getLineStartOffset(lines[b], b));
	if (!remaining.length) return [];

	const groups = [];
	let group = [];
	let previousEnd = null;
	for (const lineId of remaining) {
		const start = getLineStartOffset(lines[lineId], lineId);
		if (
			group.length
			&& claimedOffsets.some(offset => offset > previousEnd && offset < start)
		) {
			groups.push(group);
			group = [];
		}
		group.push(lineId);
		previousEnd = getLineEndOffset(lines[lineId], lineId);
	}
	groups.push(group);
	return groups.map(lineIds => createBlockFromLineIds(block, lineIds, lines));
}

/** Replace every physical text row in a confirmed navigation span with a list item. */
export function normalizeContentsBlocks(blocks, lines, pageRect, options = {}) {
	const region = options.region || detectContentsRegion(lines, pageRect, options);
	if (!region?.rows?.length) return blocks;

	const entryLineIds = region.rows.flatMap(row => row.lineIds);
	const claimedLineIds = new Set(entryLineIds);
	const claimedOffsets = entryLineIds
		.map(lineId => getLineStartOffset(lines[lineId], lineId))
		.sort((a, b) => a - b);
	const contentsStartOffset = Math.min(...claimedOffsets);
	const contentsEndOffset = Math.max(...entryLineIds.map(lineId => (
		getLineEndOffset(lines[lineId], lineId)
	)));
	const normalized = (blocks || []).flatMap(block => (
		splitResidualBlock(block, claimedLineIds, lines, claimedOffsets)
	));
	for (const block of normalized) {
		if (block.startOffset >= contentsStartOffset && block.endOffset <= contentsEndOffset) {
			block.flowClass = 'auxiliary';
		}
		if (
			block.type === 'title'
			&& block.lines?.some(lineId => region.headingLineIds.includes(lineId))
		) {
			block.flowClass = 'auxiliary';
			block._contentsNavigationHeading = true;
		}
	}

	for (const row of region.rows) {
		normalized.push(createBlockFromLineIds({
			type: 'list_item',
			flowClass: 'auxiliary',
			_contentsList: true,
		}, row.lineIds, lines));
	}

	return normalized.sort((a, b) => (
		(a.startOffset ?? 0) - (b.startOffset ?? 0)
		|| (a.endOffset ?? 0) - (b.endOffset ?? 0)
	));
}

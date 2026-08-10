import {
  resolveDestination, getRectCenter, getRangeRects, getClosestDistance
} from './util.js';
import { quadPointsToRects } from '../utils.js';
import { getBlockText, getTextNodesAtRange } from '../../../structured-document-text/src/pdf/index.js';
import { createStructureIndex, rectsIntersect } from './structure-index.js';

const MIN_GLYPH_OVERLAP_RATIO = 0.15;

function getAnnotationSourceRects(rect, quadPoints) {
	if (quadPoints?.length && quadPoints.length % 8 === 0) {
		let rects = quadPointsToRects(quadPoints)
			.filter(rect => (
				rect.length === 4
				&& rect.every(Number.isFinite)
				&& rect[2] > rect[0]
				&& rect[3] > rect[1]
			));
		if (rects.length) {
			return rects;
		}
	}
	return [rect];
}

export async function getLinksFromAnnotations(pdfDocument, page) {
	let links = [];
	let annotations = await page._parsedAnnotations;
	for (let annotation of annotations) {
		annotation = annotation.data;
		let { url, dest, rect, quadPoints } = annotation;
		if ((!url && !dest) || !rect) {
			continue;
		}
		let rects = getAnnotationSourceRects(rect, quadPoints);
		let link = { src: { pageIndex: page.pageIndex, rect, rects } };
		if (annotation.url) {
			link.url = url;
		} else if (annotation.dest) {
			let resolvedDest = await resolveDestination(pdfDocument, annotation.dest);
			if (resolvedDest) {
				link.dest = resolvedDest;
			}
		}
		links.push(link);
	}
	return links;
}

function rectContainsCenter(rect, charRect) {
	let [x, y] = getRectCenter(charRect);
	return rect[0] <= x && x <= rect[2] && rect[1] <= y && y <= rect[3];
}

function rectOverlapsGlyph(rect, charRect) {
	let width = charRect[2] - charRect[0];
	let height = charRect[3] - charRect[1];
	let glyphArea = width * height;
	if (glyphArea <= 0) {
		return false;
	}
	let intersectionWidth = Math.max(0, Math.min(rect[2], charRect[2]) - Math.max(rect[0], charRect[0]));
	let intersectionHeight = Math.max(0, Math.min(rect[3], charRect[3]) - Math.max(rect[1], charRect[1]));
	return intersectionWidth * intersectionHeight / glyphArea >= MIN_GLYPH_OVERLAP_RATIO;
}

function hasTextContent(text) {
	return /[\p{L}\p{N}]/u.test(text);
}

function hasSymbolicLinkContent(text) {
	return /[\p{S}*†‡§¶]/u.test(text);
}

function canBridgeMatchingOffsets(bt, first, second) {
	for (let offset = first + 1; offset < second; offset++) {
		if (bt.rects[offset] || !/\s/u.test(bt.text[offset])) {
			return false;
		}
	}
	return true;
}

function getMatchingOffsetRuns(bt, offsets) {
	let runs = [];
	for (let offset of offsets) {
		let run = runs.at(-1);
		if (!run || !canBridgeMatchingOffsets(bt, run.offsetEnd, offset)) {
			runs.push({ offsetStart: offset, offsetEnd: offset });
		}
		else {
			run.offsetEnd = offset;
		}
	}
	return runs;
}

function getMatchingOffsets(bt, pageIndex, rects, intersects) {
	let offsets = [];
	for (let i = 0; i < bt.text.length; i++) {
		let charRect = bt.rects[i];
		if (!charRect || bt.pageIndexes[i] !== pageIndex) {
			continue;
		}
		if (rects.some(rect => intersects(rect, charRect))) {
			offsets.push(i);
		}
	}
	return offsets;
}

export function getUnderlyingTextRanges(bt, { pageIndex, rect, rects }) {
	let sourceRects = rects?.length ? rects : [rect];
	let offsets = getMatchingOffsets(bt, pageIndex, sourceRects, rectContainsCenter);
	let matchedText = offsets.map(offset => bt.text[offset]).join('');
	let allowSymbolicContent = true;

	// Very small annotations can intersect a glyph without containing its center.
	// Prefer the more permissive overlap rule only when it finds real text.
	if (!hasTextContent(matchedText) && !hasSymbolicLinkContent(matchedText)) {
		let overlapOffsets = getMatchingOffsets(bt, pageIndex, sourceRects, rectOverlapsGlyph);
		let overlapText = overlapOffsets.map(offset => bt.text[offset]).join('');
		if (hasTextContent(overlapText)) {
			offsets = overlapOffsets;
			allowSymbolicContent = false;
		}
	}

	return getMatchingOffsetRuns(bt, offsets)
		.map(({ offsetStart, offsetEnd }) => {
			while (offsetStart <= offsetEnd && /\s/u.test(bt.text[offsetStart])) {
				offsetStart++;
			}
			while (offsetEnd >= offsetStart && /\s/u.test(bt.text[offsetEnd])) {
				offsetEnd--;
			}

			let text = bt.text.substring(offsetStart, offsetEnd + 1);
			if (
				!hasTextContent(text)
				&& !(allowSymbolicContent && hasSymbolicLinkContent(text))
			) {
				return null;
			}
			return { offsetStart, offsetEnd, text };
		})
		.filter(Boolean);
}

export function getUnderlyingTextRange(bt, source) {
	let ranges = getUnderlyingTextRanges(bt, source);
	return ranges.length === 1
		? ranges[0]
		: { offsetStart: null, offsetEnd: null, text: '' };
}

function getDestinationRange(sourceText, dest, pageEntries, destinationRangeCache) {
	if (!sourceText || dest?.pageIndex === undefined) {
		return null;
	}

	let cacheKey;
	if (destinationRangeCache) {
		cacheKey = `${dest.pageIndex}:${dest.rect?.join(',') || ''}:${sourceText}`;
		if (destinationRangeCache.has(cacheKey)) {
			return destinationRangeCache.get(cacheKey);
		}
	}

	let bestMatch = null;
	let bestDistance = Infinity;
	let bestIsHeading = false;

	for (let entry of pageEntries) {
		let { blockRef, block, bt } = entry;

		// Search for sourceText in the block text
		let index = bt.text.indexOf(sourceText);
		if (index === -1) {
			continue;
		}

		// Found a match - calculate distance from dest.rect to the matching text
		let offsetStart = index;
		let offsetEnd = index + sourceText.length - 1;

		let isHeading = block?.type === 'heading';

		// Calculate distance - use the rects of the matched text
		let minDistance = Infinity;
		for (let i = offsetStart; i <= offsetEnd && i < bt.rects.length; i++) {
			let charRect = bt.rects[i];
			let charPageIndex = bt.pageIndexes[i];

			if (charRect && charPageIndex === dest.pageIndex) {
				let distance = getClosestDistance(dest.rect, charRect);
				if (distance < minDistance) {
					minDistance = distance;
				}
			}
		}

		// Update best match - prefer headings, then closer matches
		if (isHeading && !bestIsHeading) {
			// Always prefer heading over non-heading
			bestMatch = { blockRef: [...blockRef], offsetStart, offsetEnd };
			bestDistance = minDistance;
			bestIsHeading = true;
		} else if (isHeading === bestIsHeading && minDistance < bestDistance) {
			// Same heading status, prefer closer matches
			bestMatch = { blockRef: [...blockRef], offsetStart, offsetEnd };
			bestDistance = minDistance;
		}
	}

	if (destinationRangeCache) {
		destinationRangeCache.set(cacheKey, bestMatch);
	}

	return bestMatch;
}

function resolveDestinationLinks(items, pageIndex, pageEntries, structureIndex, destinationRangeCache) {
	let itemsByDestPage = new Map();
	for (let item of items) {
		let destPageIndex = item.processedLink.dest?.pageIndex;
		if (destPageIndex === undefined) {
			continue;
		}
		if (!itemsByDestPage.has(destPageIndex)) {
			itemsByDestPage.set(destPageIndex, []);
		}
		itemsByDestPage.get(destPageIndex).push(item);
	}

	let resolveItems = (destItems, destEntries) => {
		let itemGroups = new Map();
		for (let item of destItems) {
			if (!itemGroups.has(item.sourceLink)) {
				itemGroups.set(item.sourceLink, []);
			}
			itemGroups.get(item.sourceLink).push(item);
		}

		for (let items of itemGroups.values()) {
			let destinationsByBlock = new Map();
			for (let item of items) {
				let destRange = getDestinationRange(
					item.text,
					item.processedLink.dest,
					destEntries,
					destinationRangeCache
				);
				if (destRange) {
					destinationsByBlock.set(destRange.blockRef.join(','), destRange);
				}
			}

			let destRange = destinationsByBlock.size === 1
				? destinationsByBlock.values().next().value
				: null;
			for (let item of items) {
				if (destRange) {
					item.processedLink.dest = { ...destRange, blockRef: [...destRange.blockRef] };
					item.processedLink.destinationResolution = 'source-text';
				}
				else {
					delete item.processedLink.dest;
				}
			}
		}
	};

	for (let [destPageIndex, destItems] of itemsByDestPage) {
		if (destPageIndex === pageIndex) {
			resolveItems(destItems, pageEntries);
		}
		else {
			structureIndex.withPageEntries(destPageIndex, entries => resolveItems(destItems, entries));
		}
	}
}

function addLinkRef(linkRefsMap, item) {
	if (!linkRefsMap.has(item.blockRefKey)) {
		linkRefsMap.set(item.blockRefKey, []);
	}

	linkRefsMap.get(item.blockRefKey).push({
		...item.processedLink,
		src: {
			blockRef: [...item.blockRef],
			offsetStart: item.offsetStart,
			offsetEnd: item.offsetEnd,
			text: item.text
		}
	});
}

export function getAnnotLinkRefs(structure, linkMap, structureIndex = createStructureIndex(structure)) {
	let linkRefsMap = new Map();
	let destinationRangeCache = new Map();

	// Iterate through all links in linkMap (pageIndex -> links[])
	for (let [pageIndex, links] of linkMap) {
		structureIndex.withPageEntries(pageIndex, (pageBlockTextEntries) => {
			let pageItems = [];

			for (let link of links) {
				let { rect, rects } = link.src;

				for (let entry of pageBlockTextEntries) {
					let { blockRef, blockRefKey, bt, pageRect } = entry;
					let sourceRects = rects?.length ? rects : [rect];
					if (!pageRect || !sourceRects.some(sourceRect => rectsIntersect(pageRect, sourceRect))) {
						continue;
					}

					// Find the text ranges that intersect with this link
					let ranges = getUnderlyingTextRanges(bt, { pageIndex, rect, rects });
					for (let { offsetStart, offsetEnd, text } of ranges) {
						pageItems.push({
							blockRef,
							blockRefKey,
							offsetStart,
							offsetEnd,
							text,
							sourceLink: link,
							processedLink: { ...link },
						});
					}
				}
			}

			resolveDestinationLinks(pageItems, pageIndex, pageBlockTextEntries, structureIndex, destinationRangeCache);
			for (let item of pageItems) {
				addLinkRef(linkRefsMap, item);
			}
		});
	}

	return linkRefsMap;
}

export function addRefs(existingRefs, newRefs) {
	for (let [blockRefKey, newLinks] of newRefs) {
		let existingLinks = existingRefs.get(blockRefKey);
		for (let newLink of newLinks) {
			let { offsetStart, offsetEnd } = newLink.src;
			// Check if this range intersects with any existing link
			let intersects = false;
			if (existingLinks) {
				for (let existingLink of existingLinks) {
					let { offsetStart: existingStart, offsetEnd: existingEnd } = existingLink.src;
					if (offsetStart <= existingEnd && existingStart <= offsetEnd) {
						intersects = true;
						break;
					}
				}
			}
			if (!intersects) {
				if (!existingRefs.has(blockRefKey)) {
					existingRefs.set(blockRefKey, []);
					existingLinks = existingRefs.get(blockRefKey);
				}
				existingLinks.push(newLink);
			}
		}
	}
}

export function getParsedLinkRefs(structure, structureIndex = null) {
	let linkRefsMap = new Map();

	if (!structure?.content) {
		return linkRefsMap;
	}

	let urlRegExp = new RegExp(/(https?:\/\/|www\.)[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&\/\/=]*)/);
	let doiRegExp = new RegExp(/10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i);

	const trimTrailingPunctuation = (value) => {
		let trimmed = value;
		while (trimmed.length) {
			let last = trimmed[trimmed.length - 1];
			if (',.;:!?'.includes(last) || last === ']' || last === '}') {
				trimmed = trimmed.slice(0, -1);
				continue;
			}
			if (last === ')') {
				let openCount = (trimmed.match(/\(/g) || []).length;
				let closeCount = (trimmed.match(/\)/g) || []).length;
				if (closeCount > openCount) {
					trimmed = trimmed.slice(0, -1);
					continue;
				}
			}
			break;
		}
		return trimmed;
	};

	const rangesOverlap = (a, b) => a.offsetStart <= b.offsetEnd && b.offsetStart <= a.offsetEnd;

	// Walk through all top-level blocks
	for (let i = 0; i < structure.content.length; i++) {
		if (structure.content[i].type === 'preformatted') continue;
		let blockRef = [i];
		let bt = structureIndex
			? structureIndex.withBlockText(blockRef, (bt) => bt)
			: getBlockText(structure, blockRef);

		if (!bt.text || bt.text.length === 0) {
			continue;
		}

		let text = bt.text;
		let links = [];

		// Find URL matches
		let match;
		let regex = new RegExp(urlRegExp.source, 'g');
		while ((match = regex.exec(text)) !== null) {
			if (bt.attrs[match.index]?.style?.monospace) continue;
			let url = match[0];
			if (url.includes('@')) {
				continue;
			}
			url = trimTrailingPunctuation(url);
			if (!url) {
				continue;
			}
			links.push({
				offsetStart: match.index,
				offsetEnd: match.index + url.length - 1,
				url
			});
		}

		// Find DOI matches
		regex = new RegExp(doiRegExp.source, 'gi');
		while ((match = regex.exec(text)) !== null) {
			if (bt.attrs[match.index]?.style?.monospace) continue;
			let doi = trimTrailingPunctuation(match[0]);
			if (!doi) {
				continue;
			}
			let newLink = {
				offsetStart: match.index,
				offsetEnd: match.index + doi.length - 1
			};
			if (links.some(link => rangesOverlap(link, newLink))) {
				continue;
			}
			let url = 'https://doi.org/' + encodeURIComponent(doi);
			links.push({
				...newLink,
				url
			});
		}

		// Add links to linkRefsMap
		for (let link of links) {
			let { offsetStart, offsetEnd, url } = link;
			let linkText = text.substring(offsetStart, offsetEnd + 1);

			let blockRefKey = blockRef.join(',');

			if (!linkRefsMap.has(blockRefKey)) {
				linkRefsMap.set(blockRefKey, []);
			}

			linkRefsMap.get(blockRefKey).push({
				url,
				src: {
					blockRef: [...blockRef],
					offsetStart,
					offsetEnd,
					text: linkText
				}
			});
		}
	}

	return linkRefsMap;
}

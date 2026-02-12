import {
  resolveDestination, getRectCenter, getRangeRects, getClosestDistance
} from './util.js';
import { getBlockText, getNextBlockRef, getTextNodesAtRange } from './zst/index.js';

export async function getLinksFromAnnotations(pdfDocument, page) {
	let links = [];
	let annotations = await page._parsedAnnotations;
	for (let annotation of annotations) {
		annotation = annotation.data;
		let { url, dest, rect } = annotation;
		if ((!url && !dest) || !rect) {
			continue;
		}
		let link = { src: { pageIndex: page.pageIndex, rect } };
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

function getUnderlyingTextRange(bt, {pageIndex, rect }) {
	// Find continuous sequence of characters that intersect with the link rect
	let offsetStart = null;
	let offsetEnd = null;

	for (let i = 0; i < bt.text.length; i++) {
		let charRect = bt.rects[i];
		let charPageIndex = bt.pageIndexes[i];

		// Skip if no rect info or different page
		if (!charRect || charPageIndex !== pageIndex) {
			// If we had started a sequence, break it (non-continuous)
			if (offsetStart !== null) {
				offsetStart = null;
				offsetEnd = null;
			}
			continue;
		}

		// Check if character center is within link rect
		let [x, y] = getRectCenter(charRect);
		if (rect[0] <= x && x <= rect[2] && rect[1] <= y && y <= rect[3]) {
			if (offsetStart !== null) {
				// Check continuity - if not continuous, reset
				if (i !== offsetEnd + 1) {
					offsetStart = null;
					offsetEnd = null;
					break;
				}
			} else {
				offsetStart = i;
			}
			offsetEnd = i;
		}
	}

	// Extract text if we found a valid range
	let text = '';
	if (offsetStart !== null && offsetEnd !== null) {
		text = bt.text.substring(offsetStart, offsetEnd + 1);
	}

	return { offsetStart, offsetEnd, text };
}

function intersectWithBlock(bt, {pageIndex, rect }) {
	// Check if any character in the block's text intersects with the link rect on the given page
	if (!bt.text || bt.text.length === 0) {
		return false;
	}

	for (let i = 0; i < bt.text.length; i++) {
		let charRect = bt.rects[i];
		let charPageIndex = bt.pageIndexes[i];

		// Skip if no rect info or different page
		if (!charRect || charPageIndex !== pageIndex) {
			continue;
		}

		// Check if character center is within link rect
		let [x, y] = getRectCenter(charRect);
		if (rect[0] <= x && x <= rect[2] && rect[1] <= y && y <= rect[3]) {
			return true;
		}
	}

	return false;
}

// Get all block refs that appear on a specific page by walking through content ranges
function getBlockRefsForPage(structure, pageIndex) {
	if (!structure.pages || !structure.pages[pageIndex]) {
		return [];
	}

	let page = structure.pages[pageIndex];
	if (!page.contentRanges || page.contentRanges.length === 0) {
		return [];
	}

	let blockRefs = [];

	for (let range of page.contentRanges) {
		if (!range.start?.ref || !range.end?.ref) {
			continue;
		}

		// Walk from start ref to end ref, collecting all block refs
		let currentBlockRef = range.start.ref.slice(0, 1); // Start with top-level block

		// First, add the start block ref (may be nested)
		if (range.start.ref.length > 0) {
			blockRefs.push([...range.start.ref.slice(0, 1)]);
		}

		// Then collect all top-level blocks between start and end
		let startTopLevel = range.start.ref[0];
		let endTopLevel = range.end.ref[0];

		for (let i = startTopLevel; i <= endTopLevel; i++) {
			if (!blockRefs.some(ref => ref[0] === i)) {
				blockRefs.push([i]);
			}
		}
	}

	return blockRefs;
}

function getDestinationRange(structure, sourceText, dest) {
	if (!structure?.content || !sourceText || dest?.pageIndex === undefined) {
		return null;
	}

	let pageBlockRefs = getBlockRefsForPage(structure, dest.pageIndex);
	if (!pageBlockRefs || pageBlockRefs.length === 0) {
		return null;
	}

	let bestMatch = null;
	let bestDistance = Infinity;
	let bestIsHeading = false;

	for (let topLevelBlockRef of pageBlockRefs) {
		let blockRef = topLevelBlockRef;

		do {
			let bt = getBlockText(structure, blockRef);

			if (!bt.text || bt.text.length === 0) {
				let nextRef = getNextBlockRef(structure, blockRef);
				if (nextRef && nextRef[0] === topLevelBlockRef[0]) {
					blockRef = nextRef;
				} else {
					blockRef = null;
				}
				continue;
			}

			// Search for sourceText in the block text
			let index = bt.text.indexOf(sourceText);
			if (index === -1) {
				let nextRef = getNextBlockRef(structure, blockRef);
				if (nextRef && nextRef[0] === topLevelBlockRef[0]) {
					blockRef = nextRef;
				} else {
					blockRef = null;
				}
				continue;
			}

			// Found a match - calculate distance from dest.rect to the matching text
			let offsetStart = index;
			let offsetEnd = index + sourceText.length - 1;

			// Get the actual block node to check if it's a heading
			let blockNode = structure.content[blockRef[0]];
			for (let i = 1; i < blockRef.length; i++) {
				blockNode = blockNode?.content?.[blockRef[i]];
			}
			let isHeading = blockNode?.type === 'heading';

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
				// Same heading status, prefer closer match
				bestMatch = { blockRef: [...blockRef], offsetStart, offsetEnd };
				bestDistance = minDistance;
			}

			// Get next block
			let nextRef = getNextBlockRef(structure, blockRef);
			if (nextRef && nextRef[0] === topLevelBlockRef[0]) {
				blockRef = nextRef;
			} else {
				blockRef = null;
			}
		} while (blockRef);
	}

	return bestMatch;
}

export function getAnnotLinkRefs(structure, linkMap) {
	let linkRefsMap = new Map();

	// Iterate through all links in linkMap (pageIndex -> links[])
	for (let [pageIndex, links] of linkMap) {
		// Get blocks that appear on this page
		let pageBlockRefs = getBlockRefsForPage(structure, pageIndex);

	for (let link of links) {
		let { rect } = link.src;

		// Iterate through blocks on this page and their descendants
		for (let topLevelBlockRef of pageBlockRefs) {
				// Start from this top-level block and iterate through all its descendants
				let blockRef = topLevelBlockRef;
				do {
					let bt = getBlockText(structure, blockRef);

					// Find the text range that intersects with this link
					let { offsetStart, offsetEnd, text } = getUnderlyingTextRange(bt, { pageIndex, rect });

					// Skip blocks that don't intersect with the source rect
					if (offsetStart === null || offsetEnd === null) {
						// Get next block, but only within descendants of the current top-level block
						let nextRef = getNextBlockRef(structure, blockRef);
						if (nextRef && nextRef[0] === topLevelBlockRef[0]) {
							blockRef = nextRef;
						} else {
							blockRef = null;
						}
						continue;
					}

					let blockRefKey = blockRef.join(',');

					if (!linkRefsMap.has(blockRefKey)) {
						linkRefsMap.set(blockRefKey, []);
					}

					let processedLink = { ...link };

					// Replace dest with destination range if present
					if (link.dest) {
						let destRange = getDestinationRange(structure, text, link.dest);
						if (destRange) {
							processedLink.dest = destRange;
						} else {
							delete processedLink.dest;
						}
					}

					linkRefsMap.get(blockRefKey).push({
						...processedLink,
						src: {
							blockRef: [...blockRef],
							offsetStart,
							offsetEnd,
							text
						}
					});

					// Get next block, but only within descendants of the current top-level block
					let nextRef = getNextBlockRef(structure, blockRef);
					if (nextRef && nextRef[0] === topLevelBlockRef[0]) {
						blockRef = nextRef;
					} else {
						blockRef = null;
					}
				} while (blockRef);
			}
		}
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

export function getParsedLinkRefs(structure) {
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
		let blockRef = [i];
		let bt = getBlockText(structure, blockRef);

		if (!bt.text || bt.text.length === 0) {
			continue;
		}

		let text = bt.text;
		let links = [];

		// Find URL matches
		let match;
		let regex = new RegExp(urlRegExp.source, 'g');
		while ((match = regex.exec(text)) !== null) {
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

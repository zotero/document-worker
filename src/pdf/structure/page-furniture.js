import { getNestedBlockPlainText } from '../../../structured-document-text/src/text.js';

const MIN_REPEATED_PAGES = 3;
const MIN_REPEATED_PAGE_RATIO = 0.25;
const EDGE_BAND_RATIO = 0.12;
const LOCATION_BUCKET_RATIO = 0.05;
const MIN_REPEATED_TEXT_LENGTH = 8;
const MAX_REPEATED_TEXT_LENGTH = 160;
const EXACT_BBOX_TYPES = new Set(['paragraph', 'heading']);
// Ignore insignificant extraction noise while keeping the bbox match much
// tighter than the general location buckets.
const BBOX_COORDINATE_SCALE = 10;

function getPrimaryPageRect(block) {
	const rect = block?.anchor?.pageRects?.[0];
	if (!Array.isArray(rect) || rect.length < 5) {
		return null;
	}
	return rect;
}

function getBlockPageIndex(block) {
	return getPrimaryPageRect(block)?.[0] ?? null;
}

function getExactBboxKey(block) {
	const rect = getPrimaryPageRect(block);
	const coordinates = rect?.slice(1, 5);
	if (!coordinates || coordinates.some(value => !Number.isFinite(value))) {
		return null;
	}
	return coordinates
		.map(value => Math.round(value * BBOX_COORDINATE_SCALE))
		.join(':');
}

function getPageRegionKeys(block, page) {
	const rect = getPrimaryPageRect(block);
	const pageRect = page?.viewRect;
	if (!rect || !Array.isArray(pageRect) || pageRect.length < 4) {
		return [];
	}

	const pageWidth = pageRect[2] - pageRect[0];
	const pageHeight = pageRect[3] - pageRect[1];
	if (pageWidth <= 0 || pageHeight <= 0) {
		return [];
	}

	const leftBand = pageRect[0] + pageWidth * EDGE_BAND_RATIO;
	const rightBand = pageRect[2] - pageWidth * EDGE_BAND_RATIO;
	const topBand = pageRect[1] + pageHeight * EDGE_BAND_RATIO;
	const bottomBand = pageRect[3] - pageHeight * EDGE_BAND_RATIO;
	const centerX = (rect[1] + rect[3]) / 2;
	const centerY = (rect[2] + rect[4]) / 2;
	const yBucket = Math.round(((centerY - pageRect[1]) / pageHeight) / LOCATION_BUCKET_RATIO);
	const keys = [];
	if (centerY <= topBand) {
		keys.push(`top:${yBucket}`);
	}
	if (centerY >= bottomBand) {
		keys.push(`bottom:${yBucket}`);
	}
	if (centerX <= leftBand) {
		keys.push(`left:${yBucket}`);
	}
	if (centerX >= rightBand) {
		keys.push(`right:${yBucket}`);
	}
	return keys;
}

function normalizeRepeatedText(text) {
	return text
		.replace(/\s+/gu, ' ')
		.trim()
		.toLowerCase();
}

function normalizeNumberPattern(text) {
	return text.replace(/\p{N}+/gu, '#');
}

function getTextGroupKeys(text) {
	const keys = [text];
	const numberPattern = normalizeNumberPattern(text);
	if (numberPattern !== text && numberPattern.length >= MIN_REPEATED_TEXT_LENGTH) {
		keys.push(numberPattern);
	}
	return keys;
}

function getRepeatedFurnitureCandidate(block, page) {
	if (!block || block.type !== 'paragraph') {
		return null;
	}
	const regionKeys = getPageRegionKeys(block, page);
	if (!regionKeys.length) {
		return null;
	}

	const text = normalizeRepeatedText(getNestedBlockPlainText(block));
	if (text.length < MIN_REPEATED_TEXT_LENGTH || text.length > MAX_REPEATED_TEXT_LENGTH) {
		return null;
	}

	return { textKeys: getTextGroupKeys(text), regionKeys };
}

function getExactRepeatedFurnitureCandidate(block, page) {
	if (!block || !EXACT_BBOX_TYPES.has(block.type)) {
		return null;
	}
	const regionKeys = getPageRegionKeys(block, page);
	if (!regionKeys.some(key => key.startsWith('top:') || key.startsWith('bottom:'))) {
		return null;
	}

	const text = normalizeRepeatedText(getNestedBlockPlainText(block));
	if (!text || text.length > MAX_REPEATED_TEXT_LENGTH) {
		return null;
	}

	const bboxKey = getExactBboxKey(block);
	return bboxKey ? `${text}\0${bboxKey}` : null;
}

export function excludeRepeatedPageFurniture(structure) {
	if (!structure || !Array.isArray(structure.content) || !Array.isArray(structure.catalog?.pages)) {
		return structure;
	}

	const pageCount = structure.catalog.pages.length;
	if (pageCount < MIN_REPEATED_PAGES) {
		return structure;
	}

	const groups = new Map();
	const exactGroups = new Map();
	for (let i = 0; i < structure.content.length; i++) {
		const block = structure.content[i];
		const pageIndex = getBlockPageIndex(block);
		if (!Number.isInteger(pageIndex)) {
			continue;
		}

		const page = structure.catalog.pages[pageIndex];
		const exactKey = getExactRepeatedFurnitureCandidate(block, page);
		if (exactKey) {
			const group = exactGroups.get(exactKey) || { refs: new Set(), pages: new Set() };
			if (!block.flowClass) {
				group.refs.add(i);
			}
			group.pages.add(pageIndex);
			exactGroups.set(exactKey, group);
		}

		const candidate = getRepeatedFurnitureCandidate(block, page);
		if (!candidate) {
			continue;
		}

		for (const textKey of candidate.textKeys) {
			for (const regionKey of candidate.regionKeys) {
				const groupKey = `${textKey}\0${regionKey}`;
				const group = groups.get(groupKey) || { refs: new Set(), pages: new Set() };
				if (!block.flowClass) {
					group.refs.add(i);
				}
				group.pages.add(pageIndex);
				groups.set(groupKey, group);
			}
		}
	}

	const minPages = Math.max(MIN_REPEATED_PAGES, Math.ceil(pageCount * MIN_REPEATED_PAGE_RATIO));
	for (const group of exactGroups.values()) {
		if (group.pages.size < minPages) {
			continue;
		}
		for (const ref of group.refs) {
			structure.content[ref].flowClass = 'excluded';
		}
	}

	for (const group of groups.values()) {
		if (group.pages.size < minPages) {
			continue;
		}
		for (const ref of group.refs) {
			structure.content[ref].flowClass = 'excluded';
		}
	}

	return structure;
}

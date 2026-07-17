import {
	buildInferenceErrorFallbackBlocks,
	buildParagraphFallbackBlocks,
	detectPreformattedBlocks,
	prepareBlockSegPageInput,
} from './input.js';
import clustererRuntimeMetadata from './clusterer/runtime.json' with { type: 'json' };
import { getBlockClusterRuntime } from './clusterer/runtime.js';
import { buildBlockClassifierFeatures } from './classifier/features.js';
import { getBlockSegClassifierRuntime } from './classifier/runtime.js';

const CLUSTER_BASE_COUNT = 10;
const BODY_CLUSTER_BASE = 1;
const MAX_INFERENCE_LINES_PER_PAGE = clustererRuntimeMetadata.fixedShape.maxTextTokens;
const GRAPHIC_BLOCK_TYPES = new Set(['image', 'table', 'equation']);
const OBJECT_COMPONENT_GAP = 1.5;
const BLOCKER_INFLATE = 1.5;
const MIN_SIGHT_OVERLAP = 0.5;
const DISTANCE_EPSILON = 1e-6;
const OBJECT_IMAGE_SUBTYPES = new Set(['image', 'inline-image', 'xobject']);
const STANDALONE_IMAGE_MIN_WIDTH_RATIO = 0.15;
const STANDALONE_IMAGE_MIN_HEIGHT_RATIO = 0.08;
const STANDALONE_IMAGE_MIN_AREA_RATIO = 0.015;
const STANDALONE_IMAGE_MIN_SIZE_MATCHES = 2;
const PAGE_SUBSTRATE_MIN_COVERAGE = 0.8;
const PAGE_SUBSTRATE_MAX_TILE_OVERLAP_RATIO = 0.1;
const PAGE_SUBSTRATE_MAX_TILE_GAP_RATIO = 0.005;
const IMAGE_PROVENANCE_MIN_BLOCK_COVERAGE = 0.2;
const IMAGE_PROVENANCE_MIN_COMPONENT_SPAN_RATIO = 0.25;
const RULED_TABLE_ORIENTATION_RATIO = 8;
const RULED_TABLE_MIN_RULE_LENGTH_RATIO = 0.04;
const RULED_TABLE_MAX_RULE_THICKNESS = 2.5;
const RULED_TABLE_POSITION_TOLERANCE = 3;
const RULED_TABLE_MIN_HORIZONTAL_POSITIONS = 2;
const RULED_TABLE_MIN_TEXT_OVERLAP = 0.55;
const RULED_TABLE_MIN_RULE_COVERAGE = 0.55;
const RULED_TABLE_VERTICAL_PADDING_RATIO = 1.5;
const RULED_TABLE_MAX_FRAGMENT_GAP_RATIO = 3;
const RULED_TABLE_MIN_HEADER_FRAGMENTS = 8;
const RULED_TABLE_MIN_HEADER_LINES = 8;
const RULED_TABLE_TEXT_BLOCK_TYPES = new Set(['body', 'caption', 'footnote', 'list_item']);
const SCANNED_TABLE_MIN_FRAGMENTS = 4;
const SCANNED_TABLE_CAPTION_GAP_RATIO = 4;
const SCANNED_TABLE_MIN_PAGE_IMAGE_COVERAGE = 0.8;
const SCANNED_TABLE_MAX_WIDTH_RATIO = 0.6;
const SCANNED_TABLE_HEADER_TOP_BAND_RATIO = 0.12;
const SCANNED_TABLE_HEADER_MAX_TEXT_LENGTH = 40;
const SCANNED_TABLE_HEADER_MIN_UPPERCASE_RATIO = 0.7;
const SCANNED_TABLE_JUNK_MAX_TEXT_LENGTH = 8;
const SCANNED_TABLE_JUNK_MAX_WIDTH_RATIO = 0.08;
const SCANNED_TABLE_MAX_FRAGMENT_GAP_RATIO = 4;
const DISPLAY_EQUATION_MAX_FRAGMENT_GAP_RATIO = 2.5;
const DISPLAY_EQUATION_MAX_HORIZONTAL_GAP_RATIO = 1.5;
const DISPLAY_EQUATION_SHORT_TEXT_LENGTH = 12;
const DISPLAY_EQUATION_VISUAL_JOIN_MIN_VERTICAL_OVERLAP_RATIO = 0.5;
const DISPLAY_EQUATION_VISUAL_JOIN_MAX_HORIZONTAL_GAP_RATIO = 0.25;
const DISPLAY_EQUATION_STACKED_MIN_VERTICAL_OVERLAP_RATIO = 0.1;
const DISPLAY_EQUATION_STACKED_MIN_HORIZONTAL_OVERLAP_RATIO = 0.8;
const DISPLAY_EQUATION_STACKED_MAX_LINE_COUNT_RATIO = 0.5;
const DISPLAY_EQUATION_PROSE_MIN_LETTER_RATIO = 0.6;
const DISPLAY_EQUATION_PROSE_MIN_AVERAGE_WORD_LENGTH = 3;
const EQUATION_SATELLITE_MAX_AREA_RATIO = 0.35;
const TRIVIAL_EQUATION_MAX_CHARACTER_COUNT = 3;
const FORM_SCENE_MAX_TEXT_CHARS_PER_PAINT_OBJECT = 3;
export const MAX_IMAGE_BLOCKS_PER_PAGE = 32;
const equationTextProfileCache = new WeakMap();

function getPageNumber(pageDataItem) {
	return Number.isInteger(pageDataItem?.pageIndex) ? pageDataItem.pageIndex + 1 : '?';
}

function recordLayoutFallback(pageDataItem, val, fallback) {
	const pageIndex = Number.isInteger(pageDataItem?.pageIndex) ? pageDataItem.pageIndex : null;
	const record = {
		type: 'text_only_layout',
		pageIndex,
		pageNumber: getPageNumber(pageDataItem),
		...fallback,
	};
	if (val) {
		val.layoutFallbacks ||= [];
		val.layoutFallbacks.push(record);
	}
	return record;
}

function buildRecordedParagraphFallback(pageDataItem, val, reason, details = {}) {
	recordLayoutFallback(pageDataItem, val, { reason, ...details });
	return buildParagraphFallbackBlocks(pageDataItem, val);
}

function clusterBaseFromLabel(label) {
	const n = Number(label);
	if (!Number.isInteger(n)) {
		return BODY_CLUSTER_BASE;
	}
	if (n >= 0 && n < CLUSTER_BASE_COUNT) {
		return n;
	}
	const cont = n - CLUSTER_BASE_COUNT;
	if (cont >= 0 && cont < CLUSTER_BASE_COUNT) {
		return cont;
	}
	return BODY_CLUSTER_BASE;
}

function isContinuationLabel(label) {
	const n = Number(label);
	return Number.isInteger(n) && n >= CLUSTER_BASE_COUNT;
}

function expandBbox(bbox, rect) {
	if (!bbox) {
		return rect.slice(0, 4);
	}
	return [
		Math.min(bbox[0], rect[0]),
		Math.min(bbox[1], rect[1]),
		Math.max(bbox[2], rect[2]),
		Math.max(bbox[3], rect[3]),
	];
}

function isValidRect(rect) {
	return Array.isArray(rect)
		&& rect.length === 4
		&& rect.every(Number.isFinite)
		&& rect[2] >= rect[0]
		&& rect[3] >= rect[1];
}

function rectsIntersect(a, b) {
	return isValidRect(a)
		&& isValidRect(b)
		&& !(b[0] > a[2] || b[2] < a[0] || b[1] > a[3] || b[3] < a[1]);
}

function validRectsIntersect(a, b) {
	return !(b[0] > a[2] || b[2] < a[0] || b[1] > a[3] || b[3] < a[1]);
}

function inflateRect(rect, amount) {
	return [
		rect[0] - amount,
		rect[1] - amount,
		rect[2] + amount,
		rect[3] + amount,
	];
}

function unionRects(rects) {
	let bbox = null;
	for (const rect of rects) {
		if (!isValidRect(rect)) {
			continue;
		}
		bbox = expandBbox(bbox, rect);
	}
	return bbox || [0, 0, 0, 0];
}

function unionValidRects(a, b) {
	return [
		Math.min(a[0], b[0]),
		Math.min(a[1], b[1]),
		Math.max(a[2], b[2]),
		Math.max(a[3], b[3]),
	];
}

function rectDistance(a, b) {
	if (!isValidRect(a) || !isValidRect(b)) {
		return Infinity;
	}
	const dx = b[0] > a[2] ? b[0] - a[2] : a[0] > b[2] ? a[0] - b[2] : 0;
	const dy = b[1] > a[3] ? b[1] - a[3] : a[1] > b[3] ? a[1] - b[3] : 0;
	return Math.hypot(dx, dy);
}

function rectArea(rect) {
	if (!isValidRect(rect)) {
		return 0;
	}
	return Math.max(0, rect[2] - rect[0]) * Math.max(0, rect[3] - rect[1]);
}

function validRectArea(rect) {
	return Math.max(0, rect[2] - rect[0]) * Math.max(0, rect[3] - rect[1]);
}

function intersectionArea(a, b) {
	if (!rectsIntersect(a, b)) {
		return 0;
	}
	return Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]))
		* Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
}

function validRectContains(outer, inner, tolerance = 0) {
	return inner[0] >= outer[0] - tolerance
		&& inner[1] >= outer[1] - tolerance
		&& inner[2] <= outer[2] + tolerance
		&& inner[3] <= outer[3] + tolerance;
}

function validRectCenterInside(rect, container) {
	const cx = (rect[0] + rect[2]) / 2;
	const cy = (rect[1] + rect[3]) / 2;
	return cx >= container[0] && cx <= container[2] && cy >= container[1] && cy <= container[3];
}

function rectsEqual(a, b) {
	return isValidRect(a)
		&& isValidRect(b)
		&& a[0] === b[0]
		&& a[1] === b[1]
		&& a[2] === b[2]
		&& a[3] === b[3];
}

function getLineRect(lines, lineId) {
	const line = lines[lineId];
	return isValidRect(line?.rect) ? line.rect : null;
}

function getBlockLineText(block, lines) {
	return (block?.lines || [])
		.map(lineId => lines[lineId]?.text || '')
		.join(' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function getBlockLineHeight(block, lines) {
	const heights = [];
	for (const lineId of block?.lines || []) {
		const rect = getLineRect(lines, lineId);
		const height = rect ? rect[3] - rect[1] : 0;
		if (height > 0) {
			heights.push(height);
		}
	}
	if (heights.length) {
		heights.sort((a, b) => a - b);
		return heights[Math.floor(heights.length / 2)];
	}
	if (isValidRect(block?.bbox)) {
		const height = block.bbox[3] - block.bbox[1];
		if (height > 0) {
			return height;
		}
	}
	return 0;
}

function getLineBlockMetrics(lineIds, lines, fallbackBbox) {
	let startOffset = null;
	let endOffset = null;
	let rects = [];
	for (const lineId of lineIds) {
		const line = lines[lineId];
		if (!line) {
			continue;
		}
		if (isValidRect(line.rect)) {
			rects.push(line.rect);
		}
		if (Number.isInteger(line.startOffset)) {
			startOffset = startOffset === null ? line.startOffset : Math.min(startOffset, line.startOffset);
		}
		if (Number.isInteger(line.endOffset)) {
			endOffset = endOffset === null ? line.endOffset : Math.max(endOffset, line.endOffset);
		}
	}
	const bbox = rects.length ? unionRects(rects) : fallbackBbox?.slice(0, 4) || [0, 0, 0, 0];
	return {
		bbox,
		startOffset: startOffset ?? 0,
		endOffset: endOffset ?? startOffset ?? 0,
	};
}

function createBlockFromLines(sourceBlock, lineIds, lines, bbox = null) {
	const metrics = getLineBlockMetrics(lineIds, lines, sourceBlock.bbox);
	return {
		...sourceBlock,
		lines: lineIds.slice(),
		bbox: bbox || metrics.bbox,
		startOffset: metrics.startOffset,
		endOffset: metrics.endOffset,
	};
}

function buildBlockRefinementContext(blocks, lines) {
	const sourceBlocks = Array.isArray(blocks) ? blocks : [];
	const blockerEntries = [];
	const distanceEntries = [];
	for (const block of sourceBlocks) {
		if (!block || typeof block !== 'object') {
			continue;
		}
		const lineHeight = getBlockLineHeight(block, lines);
		if (!isValidRect(block.bbox)) {
			continue;
		}
		blockerEntries.push({
			block,
			rect: inflateRect(block.bbox, BLOCKER_INFLATE),
		});
		if (lineHeight > 0) {
			distanceEntries.push({
				block,
				bbox: block.bbox,
				lineHeight,
			});
		}
	}
	// getBlockers preserves this order, so intersection scans can stop once a blocker starts past the candidate.
	blockerEntries.sort((a, b) => a.rect[0] - b.rect[0]);
	return {
		distanceEntries,
		getBlockers(excludedBlocks = new Set()) {
			const blockers = [];
			for (const entry of blockerEntries) {
				if (!excludedBlocks.has(entry.block)) {
					blockers.push(entry.rect);
				}
			}
			return blockers;
		},
	};
}

function intersectsAny(rect, blockers) {
	if (!isValidRect(rect)) {
		return false;
	}
	return sortedBlockersIntersectRect(rect, blockers);
}

function validIntersectsAny(rect, blockers) {
	return sortedBlockersIntersectRect(rect, blockers);
}

function sortedBlockersIntersectRect(rect, blockers) {
	return sortedBlockersIntersectBounds(rect[0], rect[1], rect[2], rect[3], blockers);
}

function sortedBlockersIntersectBounds(x1, y1, x2, y2, blockers) {
	for (const blocker of blockers) {
		if (blocker[0] > x2) {
			break;
		}
		if (
			blocker[2] >= x1
			&& blocker[1] <= y2
			&& blocker[3] >= y1
		) {
			return true;
		}
	}
	return false;
}

function clearSightRect(rect, blockers) {
	if (!isValidRect(rect)) {
		return false;
	}
	return !intersectsAny(rect, blockers);
}

function validClearSightRect(rect, blockers) {
	return !validIntersectsAny(rect, blockers);
}

function hasDirectSightValid(a, b, blockers) {
	if (validRectsIntersect(a, b)) {
		return validClearSightRect(unionValidRects(a, b), blockers);
	}

	const overlapX1 = Math.max(a[0], b[0]);
	const overlapX2 = Math.min(a[2], b[2]);
	const overlapY1 = Math.max(a[1], b[1]);
	const overlapY2 = Math.min(a[3], b[3]);
	const overlapX = overlapX2 - overlapX1;
	const overlapY = overlapY2 - overlapY1;

	if (overlapX >= MIN_SIGHT_OVERLAP) {
		const y1 = a[3] < b[1] ? a[3] : b[3];
		const y2 = a[3] < b[1] ? b[1] : a[1];
		return validClearSightRect([overlapX1, y1, overlapX2, y2], blockers);
	}
	if (overlapY >= MIN_SIGHT_OVERLAP) {
		const x1 = a[2] < b[0] ? a[2] : b[2];
		const x2 = a[2] < b[0] ? b[0] : a[0];
		return validClearSightRect([x1, overlapY1, x2, overlapY2], blockers);
	}
	return false;
}

function buildObjectRefinementContext(objectLines) {
	const lines = Array.isArray(objectLines) ? objectLines : [];
	const validObjects = [];
	for (let i = 0; i < lines.length; i++) {
		const object = lines[i];
		if (!isValidRect(object?.rect)) {
			continue;
		}
		validObjects.push({
			index: i,
			bbox: object.rect.slice(0, 4),
			subtype: object.subtype,
		});
	}
	return { validObjects };
}

function createDisjointSet(size) {
	const parents = Array.from({ length: size }, (_, index) => index);
	const find = (index) => {
		let root = index;
		while (parents[root] !== root) root = parents[root];
		while (parents[index] !== index) {
			const next = parents[index];
			parents[index] = root;
			index = next;
		}
		return root;
	};
	const union = (first, second) => {
		const firstRoot = find(first);
		const secondRoot = find(second);
		if (firstRoot !== secondRoot) parents[secondRoot] = firstRoot;
	};
	return { find, union };
}

function clipRectToPage(rect, pageRect) {
	if (!isValidRect(rect) || !isValidRect(pageRect)) {
		return null;
	}
	const clipped = [
		Math.max(rect[0], pageRect[0]),
		Math.max(rect[1], pageRect[1]),
		Math.min(rect[2], pageRect[2]),
		Math.min(rect[3], pageRect[3]),
	];
	return validRectArea(clipped) > 0 ? clipped : null;
}

function getRectUnionArea(rects, pageRect) {
	const clippedRects = rects
		.map(rect => clipRectToPage(rect, pageRect))
		.filter(Boolean);
	if (!clippedRects.length) {
		return 0;
	}
	const events = [];
	for (let id = 0; id < clippedRects.length; id++) {
		events.push({ x: clippedRects[id][0], id, entering: true });
		events.push({ x: clippedRects[id][2], id, entering: false });
	}
	events.sort((a, b) => a.x - b.x || Number(a.entering) - Number(b.entering));

	const active = new Set();
	let area = 0;
	let previousX = events[0].x;
	for (let i = 0; i < events.length;) {
		const x = events[i].x;
		if (x > previousX && active.size) {
			const intervals = [...active]
				.map(id => [clippedRects[id][1], clippedRects[id][3]])
				.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
			let coveredY = 0;
			let [start, end] = intervals[0];
			for (const interval of intervals.slice(1)) {
				if (interval[0] <= end) {
					end = Math.max(end, interval[1]);
				}
				else {
					coveredY += end - start;
					[start, end] = interval;
				}
			}
			coveredY += end - start;
			area += (x - previousX) * coveredY;
		}
		while (i < events.length && events[i].x === x) {
			if (events[i].entering) {
				active.add(events[i].id);
			}
			else {
				active.delete(events[i].id);
			}
			i++;
		}
		previousX = x;
	}
	return area;
}

function rasterObjectsCanShareSubstrate(first, second, maxGap) {
	if (rectDistance(first.bbox, second.bbox) > maxGap) {
		return false;
	}
	const smallerArea = Math.min(validRectArea(first.bbox), validRectArea(second.bbox));
	if (smallerArea <= 0) {
		return false;
	}
	return intersectionArea(first.bbox, second.bbox) / smallerArea
		<= PAGE_SUBSTRATE_MAX_TILE_OVERLAP_RATIO;
}

function getPageSubstrateObjectIndexes(objectContext, pageRect) {
	if (!isValidRect(pageRect)) {
		return new Set();
	}
	const pageArea = validRectArea(pageRect);
	if (pageArea <= 0) {
		return new Set();
	}

	const rasterObjects = objectContext.validObjects
		.filter(object => OBJECT_IMAGE_SUBTYPES.has(object.subtype))
		.sort((a, b) => a.bbox[0] - b.bbox[0] || a.index - b.index);
	const { find, union } = createDisjointSet(rasterObjects.length);
	const pageWidth = pageRect[2] - pageRect[0];
	const pageHeight = pageRect[3] - pageRect[1];
	const maxGap = Math.max(OBJECT_COMPONENT_GAP, Math.min(pageWidth, pageHeight) * PAGE_SUBSTRATE_MAX_TILE_GAP_RATIO);
	for (let i = 0; i < rasterObjects.length; i++) {
		for (let j = i + 1; j < rasterObjects.length; j++) {
			if (rasterObjects[j].bbox[0] > rasterObjects[i].bbox[2] + maxGap) {
				break;
			}
			if (rasterObjectsCanShareSubstrate(rasterObjects[i], rasterObjects[j], maxGap)) {
				union(i, j);
			}
		}
	}

	const groups = new Map();
	for (let i = 0; i < rasterObjects.length; i++) {
		const root = find(i);
		if (!groups.has(root)) {
			groups.set(root, []);
		}
		groups.get(root).push(rasterObjects[i]);
	}

	const objectIndexes = new Set();
	for (const objects of groups.values()) {
		const coverage = getRectUnionArea(objects.map(object => object.bbox), pageRect) / pageArea;
		if (coverage < PAGE_SUBSTRATE_MIN_COVERAGE) {
			continue;
		}
		for (const object of objects) {
			objectIndexes.add(object.index);
		}
	}

	// Page-sized non-raster objects are backgrounds rather than independent
	// figure provenance. Keep them out of graphic expansion as well.
	for (const object of objectContext.validObjects) {
		if (objectIndexes.has(object.index)) {
			continue;
		}
		const clipped = clipRectToPage(object.bbox, pageRect);
		const coverage = clipped ? validRectArea(clipped) / pageArea : 0;
		if (coverage < PAGE_SUBSTRATE_MIN_COVERAGE) {
			continue;
		}
		objectIndexes.add(object.index);
	}

	return objectIndexes;
}

function excludeSubstrateObjects(objectContext, substrateObjectIndexes) {
	if (!substrateObjectIndexes.size) {
		return objectContext;
	}
	return {
		validObjects: objectContext.validObjects.filter(object => !substrateObjectIndexes.has(object.index)),
	};
}

function buildGraphicObjectContexts(objectLines, pageRect) {
	const sourceObjectContext = buildObjectRefinementContext(objectLines);
	const substrateObjectIndexes = getPageSubstrateObjectIndexes(sourceObjectContext, pageRect);
	return {
		sourceObjectContext,
		independentObjectContext: excludeSubstrateObjects(
			sourceObjectContext,
			substrateObjectIndexes,
		),
	};
}

function getHorizontalRuleCandidate(object, pageRect) {
	if (object?.subtype !== 'path' || !isValidRect(object.bbox) || !isValidRect(pageRect)) {
		return null;
	}
	const width = object.bbox[2] - object.bbox[0];
	const height = object.bbox[3] - object.bbox[1];
	const pageWidth = Math.max(1, pageRect[2] - pageRect[0]);
	if (width <= 0 || height <= 0) {
		return null;
	}
	if (
		width >= height * RULED_TABLE_ORIENTATION_RATIO
		&& width / pageWidth >= RULED_TABLE_MIN_RULE_LENGTH_RATIO
		&& height <= RULED_TABLE_MAX_RULE_THICKNESS
	) {
		return {
			bbox: object.bbox,
			y: (object.bbox[1] + object.bbox[3]) / 2,
		};
	}
	return null;
}

function clusterRulesByPosition(rules) {
	const sortedRules = rules
		.filter(rule => Number.isFinite(rule?.y))
		.sort((a, b) => a.y - b.y);
	const clusters = [];
	for (const rule of sortedRules) {
		const last = clusters[clusters.length - 1];
		if (!last || rule.y - last.y > RULED_TABLE_POSITION_TOLERANCE) {
			clusters.push({ y: rule.y, rules: [rule] });
			continue;
		}
		last.y = (last.y * last.rules.length + rule.y) / (last.rules.length + 1);
		last.rules.push(rule);
	}
	return clusters;
}

function hasDegradedTableText(lineIds, lines) {
	let text = '';
	for (const lineId of lineIds) {
		text += lines[lineId]?.text || '';
	}
	const compactText = text.replace(/\s+/g, '');
	if (!compactText) {
		return false;
	}
	const replacementChars = (compactText.match(/\uFFFD/g) || []).length;
	return replacementChars > compactText.length * 0.3;
}

function getHorizontalRules(objectContext, pageRect) {
	if (!isValidRect(pageRect)) {
		return [];
	}
	return objectContext.validObjects
		.map(object => getHorizontalRuleCandidate(object, pageRect))
		.filter(Boolean);
}

function horizontalOverlapRatio(a, b) {
	const overlap = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
	const width = Math.max(1, Math.min(a[2] - a[0], b[2] - b[0]));
	return overlap / width;
}

function horizontalOverlapLength(a, b) {
	return Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
}

function horizontalCoverageRatio(rect, rules) {
	const spans = [];
	for (const rule of rules) {
		const x1 = Math.max(rect[0], rule.bbox[0]);
		const x2 = Math.min(rect[2], rule.bbox[2]);
		if (x2 > x1) {
			spans.push([x1, x2]);
		}
	}
	if (!spans.length) {
		return 0;
	}
	spans.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
	let covered = 0;
	let [currentStart, currentEnd] = spans[0];
	for (const [start, end] of spans.slice(1)) {
		if (start > currentEnd) {
			covered += currentEnd - currentStart;
			currentStart = start;
			currentEnd = end;
			continue;
		}
		currentEnd = Math.max(currentEnd, end);
	}
	covered += currentEnd - currentStart;
	return covered / Math.max(1, rect[2] - rect[0]);
}

function getRuleCoverageClusters(rules, textBbox) {
	return clusterRulesByPosition(rules)
		.filter(cluster => horizontalCoverageRatio(textBbox, cluster.rules) >= RULED_TABLE_MIN_RULE_COVERAGE);
}

function getCoveredRulesNearText(textBbox, lineHeight, horizontalRules) {
	const verticalPadding = lineHeight * RULED_TABLE_VERTICAL_PADDING_RATIO;
	const candidateRules = horizontalRules.filter(rule => (
		horizontalOverlapLength(textBbox, rule.bbox) > 0
		&& rule.y >= textBbox[1] - verticalPadding
		&& rule.y <= textBbox[3] + verticalPadding
	));
	return getRuleCoverageClusters(candidateRules, textBbox);
}

function getTableRunTextBbox(blockIndexes, blocks, lines) {
	const lineRects = blockIndexes
		.flatMap(blockIndex => blocks[blockIndex].lines || [])
		.map(lineId => getLineRect(lines, lineId))
		.filter(Boolean);
	if (lineRects.length) {
		return unionRects(lineRects);
	}
	return unionRects(blockIndexes.map(blockIndex => blocks[blockIndex].bbox));
}

function getTableRunLineIds(blockIndexes, blocks, lines) {
	return [...new Set(blockIndexes.flatMap(blockIndex => blocks[blockIndex].lines || []))]
		.filter(lineId => getLineRect(lines, lineId));
}

function getTableBlockTextBbox(block, lines) {
	const lineRects = (block?.lines || [])
		.map(lineId => getLineRect(lines, lineId))
		.filter(Boolean);
	if (lineRects.length) {
		return unionRects(lineRects);
	}
	return isValidRect(block?.bbox) ? block.bbox : null;
}

function isRuledTableTextBlock(block, lines, horizontalRules) {
	if (!RULED_TABLE_TEXT_BLOCK_TYPES.has(block?.type)) {
		return false;
	}
	const textBbox = getTableBlockTextBbox(block, lines);
	if (!textBbox) {
		return false;
	}
	const lineHeight = Math.max(getBlockLineHeight(block, lines), 1);
	return getCoveredRulesNearText(textBbox, lineHeight, horizontalRules).length >= RULED_TABLE_MIN_HORIZONTAL_POSITIONS;
}

function verticalGap(a, b) {
	return Math.max(0, Math.max(a[1], b[1]) - Math.min(a[3], b[3]));
}

function canContinueTableFragmentRun(first, second, lines) {
	const firstBbox = getTableBlockTextBbox(first, lines);
	const secondBbox = getTableBlockTextBbox(second, lines);
	if (!firstBbox || !secondBbox) {
		return true;
	}
	const lineHeight = Math.max(
		getBlockLineHeight(first, lines),
		getBlockLineHeight(second, lines),
		1
	);
	const gap = verticalGap(firstBbox, secondBbox);
	if (horizontalOverlapRatio(firstBbox, secondBbox) < RULED_TABLE_MIN_TEXT_OVERLAP) {
		return gap <= lineHeight;
	}
	return gap <= lineHeight * RULED_TABLE_MAX_FRAGMENT_GAP_RATIO;
}

function getTableRunLineHeight(blockIndexes, blocks, lines) {
	return Math.max(
		...blockIndexes.map(blockIndex => getBlockLineHeight(blocks[blockIndex], lines)),
		1
	);
}

function getTableRunRuleEvidence(blockIndexes, blocks, lines, horizontalRules) {
	const textBbox = getTableRunTextBbox(blockIndexes, blocks, lines);
	const lineHeight = getTableRunLineHeight(blockIndexes, blocks, lines);
	const ruleClusters = getCoveredRulesNearText(textBbox, lineHeight, horizontalRules);
	if (ruleClusters.length < RULED_TABLE_MIN_HORIZONTAL_POSITIONS) {
		return null;
	}
	const lineIds = getTableRunLineIds(blockIndexes, blocks, lines);
	if (hasDegradedTableText(lineIds, lines)) {
		return null;
	}
	const matchingRules = ruleClusters.flatMap(cluster => cluster.rules);
	return {
		bbox: unionRects([
			textBbox,
			...matchingRules.map(rule => rule.bbox),
		]),
	};
}

function getHeaderRuleTableRunEvidence(blockIndexes, blocks, lines, horizontalRules) {
	if (blockIndexes.length < RULED_TABLE_MIN_HEADER_FRAGMENTS) {
		return null;
	}
	const lineIds = getTableRunLineIds(blockIndexes, blocks, lines);
	if (lineIds.length < RULED_TABLE_MIN_HEADER_LINES || hasDegradedTableText(lineIds, lines)) {
		return null;
	}
	const textBbox = getTableRunTextBbox(blockIndexes, blocks, lines);
	const verticalPadding = getTableRunLineHeight(blockIndexes, blocks, lines) * RULED_TABLE_VERTICAL_PADDING_RATIO;
	const candidateRules = horizontalRules.filter(rule => (
		horizontalOverlapLength(textBbox, rule.bbox) > 0
		&& rule.y >= textBbox[3] - verticalPadding
		&& rule.y <= textBbox[3] + verticalPadding
	));
	const ruleClusters = getRuleCoverageClusters(candidateRules, textBbox);
	if (!ruleClusters.length) {
		return null;
	}
	const matchingRules = ruleClusters.flatMap(cluster => cluster.rules);
	return {
		bbox: unionRects([
			textBbox,
			...matchingRules.map(rule => rule.bbox),
		]),
	};
}

function getConsecutiveTableRuns(blocks, lines, horizontalRules, { splitLargeGaps = true, includeRuledText = false } = {}) {
	const runs = [];
	let run = [];
	let hasTable = false;
	const flush = () => {
		if (run.length >= 2 && hasTable) {
			runs.push(run);
		}
		run = [];
		hasTable = false;
	};
	for (let i = 0; i < blocks.length; i++) {
		const block = blocks[i];
		if (
			block?.type === 'table'
			|| (includeRuledText && isRuledTableTextBlock(block, lines, horizontalRules))
		) {
			const previousIndex = run[run.length - 1];
			if (
				splitLargeGaps
				&& Number.isInteger(previousIndex)
				&& !canContinueTableFragmentRun(blocks[previousIndex], block, lines)
			) {
				flush();
			}
			run.push(i);
			hasTable ||= block.type === 'table';
		}
		else {
			flush();
		}
	}
	flush();
	return runs;
}

function createMergedTableBlock(blockIndexes, blocks, lines, bbox) {
	const sourceBlock = blocks[
		blockIndexes.find(blockIndex => blocks[blockIndex]?.type === 'table')
	] || blocks[blockIndexes[0]];
	const lineIds = [];
	for (const blockIndex of blockIndexes) {
		lineIds.push(...(blocks[blockIndex].lines || []));
	}
	const uniqueLineIds = [...new Set(lineIds)]
		.filter(lineId => getLineRect(lines, lineId))
		.sort((a, b) => {
			const lineA = lines[a];
			const lineB = lines[b];
			return (lineA?.startOffset ?? a) - (lineB?.startOffset ?? b);
		});
	const metrics = getLineBlockMetrics(uniqueLineIds, lines, sourceBlock.bbox);
	return {
		...sourceBlock,
		type: 'table',
		lines: uniqueLineIds,
		bbox: unionRects([
			bbox,
			...blockIndexes.map(blockIndex => blocks[blockIndex].bbox),
			metrics.bbox,
		]),
		startOffset: metrics.startOffset,
		endOffset: metrics.endOffset,
	};
}

function hasFullPageImageObject(objectContext, pageRect) {
	if (!isValidRect(pageRect)) {
		return false;
	}
	const pageArea = validRectArea(pageRect);
	if (pageArea <= 0) {
		return false;
	}
	return objectContext.validObjects.some(object => (
		OBJECT_IMAGE_SUBTYPES.has(object.subtype)
		&& validRectArea(object.bbox) / pageArea >= SCANNED_TABLE_MIN_PAGE_IMAGE_COVERAGE
	));
}

function isNearbyTableCaption(block, tableBbox, lines) {
	if (block?.type !== 'caption') {
		return false;
	}
	const captionBbox = getTableBlockTextBbox(block, lines);
	if (!captionBbox || !tableBbox) {
		return false;
	}
	const lineHeight = Math.max(getBlockLineHeight(block, lines), 1);
	return verticalGap(captionBbox, tableBbox) <= lineHeight * SCANNED_TABLE_CAPTION_GAP_RATIO
		&& horizontalOverlapRatio(captionBbox, tableBbox) >= RULED_TABLE_MIN_TEXT_OVERLAP;
}

function startsScannedTableCaption(block, lines) {
	return /^table\b/i.test(getBlockLineText(block, lines));
}

function isLeadingScannedHeaderFragment(block, lines, pageRect) {
	if (block?.type !== 'table' || !isValidRect(block.bbox) || !isValidRect(pageRect)) {
		return false;
	}
	const text = getBlockLineText(block, lines);
	if (!text || text.length > SCANNED_TABLE_HEADER_MAX_TEXT_LENGTH || startsScannedTableCaption(block, lines)) {
		return false;
	}
	const pageHeight = Math.max(1, pageRect[3] - pageRect[1]);
	const centerY = (block.bbox[1] + block.bbox[3]) / 2;
	if (centerY < pageRect[3] - pageHeight * SCANNED_TABLE_HEADER_TOP_BAND_RATIO) {
		return false;
	}
	const letters = text.match(/\p{L}/gu) || [];
	if (!letters.length || /\d/u.test(text)) {
		return false;
	}
	const uppercaseLetters = letters.filter(letter => letter === letter.toUpperCase()).length;
	return uppercaseLetters / letters.length >= SCANNED_TABLE_HEADER_MIN_UPPERCASE_RATIO;
}

function createExcludedTextBlock(block) {
	return {
		...block,
		type: 'body',
		flowClass: 'excluded',
	};
}

function isTinyScannedTableJunk(block, lines, pageRect) {
	if (block?.type !== 'table' || !isValidRect(block.bbox) || !isValidRect(pageRect)) {
		return false;
	}
	const text = getBlockLineText(block, lines);
	if (!text || text.length > SCANNED_TABLE_JUNK_MAX_TEXT_LENGTH || /\p{L}/u.test(text)) {
		return false;
	}
	const pageWidth = Math.max(1, pageRect[2] - pageRect[0]);
	return (block.bbox[2] - block.bbox[0]) / pageWidth <= SCANNED_TABLE_JUNK_MAX_WIDTH_RATIO;
}

function cleanupScannedTableJunkFragments(blocks, lines, pageRect) {
	let changed = false;
	const result = blocks.map(block => {
		if (!isTinyScannedTableJunk(block, lines, pageRect)) {
			return block;
		}
		changed = true;
		return createExcludedTextBlock(block);
	});
	return changed ? result : blocks;
}

function canContinueDenseScannedTableRun(first, second, lines) {
	const firstBbox = getTableBlockTextBbox(first, lines);
	const secondBbox = getTableBlockTextBbox(second, lines);
	if (!firstBbox || !secondBbox) {
		return false;
	}
	const lineHeight = Math.max(
		getBlockLineHeight(first, lines),
		getBlockLineHeight(second, lines),
		1
	);
	return verticalGap(firstBbox, secondBbox) <= lineHeight * SCANNED_TABLE_MAX_FRAGMENT_GAP_RATIO;
}

function getDenseScannedTableRuns(blocks, lines) {
	const runs = [];
	let run = [];
	const flush = () => {
		if (run.length >= SCANNED_TABLE_MIN_FRAGMENTS) {
			runs.push(run);
		}
		run = [];
	};

	for (let i = 0; i < blocks.length; i++) {
		const block = blocks[i];
		if (block?.type !== 'table') {
			flush();
			continue;
		}
		if (run.length && !canContinueDenseScannedTableRun(blocks[run[run.length - 1]], block, lines)) {
			flush();
		}
		run.push(i);
	}
	flush();
	return runs;
}

function getScannedTableMergeSegment(blockIndexes, blocks, lines, textBbox) {
	if (isNearbyTableCaption(blocks[blockIndexes[0] - 1], textBbox, lines)) {
		return blockIndexes;
	}
	const captionOffset = blockIndexes.findIndex(blockIndex => startsScannedTableCaption(blocks[blockIndex], lines));
	if (captionOffset < 0) {
		return null;
	}
	return blockIndexes.slice(captionOffset);
}

function mergeDenseScannedTableFragments(blocks, lines, pageRect) {
	const pageWidth = isValidRect(pageRect) ? Math.max(1, pageRect[2] - pageRect[0]) : 1;
	const mergeByFirstIndex = new Map();
	const replaceByIndex = new Map();
	const skipIndexes = new Set();

	for (const blockIndexes of getDenseScannedTableRuns(blocks, lines)) {
		const textBbox = getTableRunTextBbox(blockIndexes, blocks, lines);
		if (!textBbox || (textBbox[2] - textBbox[0]) / pageWidth > SCANNED_TABLE_MAX_WIDTH_RATIO) {
			continue;
		}
		const mergeIndexes = getScannedTableMergeSegment(blockIndexes, blocks, lines, textBbox);
		if (!mergeIndexes || mergeIndexes.length < SCANNED_TABLE_MIN_FRAGMENTS) {
			continue;
		}
		const mergeBbox = getTableRunTextBbox(mergeIndexes, blocks, lines) || textBbox;
		const firstIndex = mergeIndexes[0];
		mergeByFirstIndex.set(firstIndex, createMergedTableBlock(mergeIndexes, blocks, lines, mergeBbox));
		for (const blockIndex of mergeIndexes.slice(1)) {
			skipIndexes.add(blockIndex);
		}
		for (const blockIndex of blockIndexes) {
			if (blockIndex >= firstIndex) {
				break;
			}
			if (isLeadingScannedHeaderFragment(blocks[blockIndex], lines, pageRect)) {
				replaceByIndex.set(blockIndex, createExcludedTextBlock(blocks[blockIndex]));
			}
		}
	}

	if (!mergeByFirstIndex.size && !replaceByIndex.size) {
		return blocks;
	}

	const result = [];
	for (let i = 0; i < blocks.length; i++) {
		if (skipIndexes.has(i)) {
			continue;
		}
		result.push(mergeByFirstIndex.get(i) || replaceByIndex.get(i) || blocks[i]);
	}
	return result;
}

function mergeRuledTableFragments(blocks, lines, objectContext, pageRect) {
	const horizontalRules = getHorizontalRules(objectContext, pageRect);
	if (horizontalRules.length < RULED_TABLE_MIN_HORIZONTAL_POSITIONS) {
		return blocks;
	}

	const mergeByFirstIndex = new Map();
	const skipIndexes = new Set();
	for (const blockIndexes of getConsecutiveTableRuns(blocks, lines, horizontalRules, { includeRuledText: true })) {
		const evidence = getTableRunRuleEvidence(blockIndexes, blocks, lines, horizontalRules);
		if (!evidence) {
			continue;
		}
		const firstIndex = blockIndexes[0];
		mergeByFirstIndex.set(firstIndex, createMergedTableBlock(blockIndexes, blocks, lines, evidence.bbox));
		for (const blockIndex of blockIndexes.slice(1)) {
			skipIndexes.add(blockIndex);
		}
	}
	for (const blockIndexes of getConsecutiveTableRuns(blocks, lines, horizontalRules, { splitLargeGaps: false })) {
		if (blockIndexes.some(blockIndex => skipIndexes.has(blockIndex) || mergeByFirstIndex.has(blockIndex))) {
			continue;
		}
		const evidence = getHeaderRuleTableRunEvidence(blockIndexes, blocks, lines, horizontalRules);
		if (!evidence) {
			continue;
		}
		const firstIndex = blockIndexes[0];
		mergeByFirstIndex.set(firstIndex, createMergedTableBlock(blockIndexes, blocks, lines, evidence.bbox));
		for (const blockIndex of blockIndexes.slice(1)) {
			skipIndexes.add(blockIndex);
		}
	}

	if (!mergeByFirstIndex.size) {
		return blocks;
	}

	const result = [];
	for (let i = 0; i < blocks.length; i++) {
		if (skipIndexes.has(i)) {
			continue;
		}
		result.push(mergeByFirstIndex.get(i) || blocks[i]);
	}
	return result;
}

function buildObjectComponents(objectContext, blockers = []) {
	const components = objectContext.validObjects.map((object, id) => ({
		id,
		version: 1,
		active: true,
		bbox: object.bbox,
	}));
	const objectCount = components.length;
	const mergeablePairs = [];
	// This preserves the old greedy scan order while avoiding full rescans after each merge.
	const comparePairs = (a, b) => a.key - b.key;
	const pushPair = pair => {
		mergeablePairs.push(pair);
		let index = mergeablePairs.length - 1;
		while (index > 0) {
			const parentIndex = (index - 1) >> 1;
			if (comparePairs(mergeablePairs[parentIndex], pair) <= 0) {
				break;
			}
			mergeablePairs[index] = mergeablePairs[parentIndex];
			index = parentIndex;
		}
		mergeablePairs[index] = pair;
	};
	const popPair = () => {
		const first = mergeablePairs[0];
		const last = mergeablePairs.pop();
		if (mergeablePairs.length && last) {
			let index = 0;
			while (true) {
				const leftIndex = index * 2 + 1;
				const rightIndex = leftIndex + 1;
				if (leftIndex >= mergeablePairs.length) {
					break;
				}
				const childIndex = rightIndex < mergeablePairs.length
					&& comparePairs(mergeablePairs[rightIndex], mergeablePairs[leftIndex]) < 0
					? rightIndex
					: leftIndex;
				if (comparePairs(last, mergeablePairs[childIndex]) <= 0) {
					break;
				}
				mergeablePairs[index] = mergeablePairs[childIndex];
				index = childIndex;
			}
			mergeablePairs[index] = last;
		}
		return first;
	};
	const addMergeablePair = (first, second) => {
		let a = first;
		let b = second;
		if (a.id > b.id) {
			a = second;
			b = first;
		}
		const aBbox = a.bbox;
		const bBbox = b.bbox;
		if (
			bBbox[0] > aBbox[2] + OBJECT_COMPONENT_GAP
			|| bBbox[2] < aBbox[0] - OBJECT_COMPONENT_GAP
			|| bBbox[1] > aBbox[3] + OBJECT_COMPONENT_GAP
			|| bBbox[3] < aBbox[1] - OBJECT_COMPONENT_GAP
		) {
			return;
		}
		const x1 = Math.min(aBbox[0], bBbox[0]);
		const y1 = Math.min(aBbox[1], bBbox[1]);
		const x2 = Math.max(aBbox[2], bBbox[2]);
		const y2 = Math.max(aBbox[3], bBbox[3]);
		if (sortedBlockersIntersectBounds(x1, y1, x2, y2, blockers)) {
			return;
		}
		pushPair({
			key: a.id * objectCount + b.id,
			firstId: a.id,
			secondId: b.id,
			firstVersion: a.version,
			secondVersion: b.version,
			bbox: [x1, y1, x2, y2],
		});
	};
	const getIntervalPairCount = (sortedComponents, minIndex, maxIndex, limit) => {
		let count = 0;
		for (let i = 0; i < sortedComponents.length; i++) {
			const first = sortedComponents[i];
			const maxValue = first.bbox[maxIndex] + OBJECT_COMPONENT_GAP;
			for (let j = i + 1; j < sortedComponents.length; j++) {
				if (sortedComponents[j].bbox[minIndex] > maxValue) {
					break;
				}
				count++;
				if (count >= limit) {
					return count;
				}
			}
		}
		return count;
	};
	const addInitialPairsForAxis = (sortedComponents, minIndex, maxIndex) => {
		for (let i = 0; i < sortedComponents.length; i++) {
			const first = sortedComponents[i];
			const maxValue = first.bbox[maxIndex] + OBJECT_COMPONENT_GAP;
			for (let j = i + 1; j < sortedComponents.length; j++) {
				const second = sortedComponents[j];
				if (second.bbox[minIndex] > maxValue) {
					break;
				}
				addMergeablePair(first, second);
			}
		}
	};
	const addInitialMergeablePairs = () => {
		if (!objectContext.componentOrder) {
			const byX = components
				.slice()
				.sort((a, b) => a.bbox[0] - b.bbox[0] || a.id - b.id);
			const byY = components
				.slice()
				.sort((a, b) => a.bbox[1] - b.bbox[1] || a.id - b.id);
			const countLimit = 1000000;
			const xPairCount = getIntervalPairCount(byX, 0, 2, countLimit);
			const yPairCount = getIntervalPairCount(byY, 1, 3, countLimit);
			objectContext.componentAxis = yPairCount < xPairCount ? 1 : 0;
			objectContext.componentOrder = (objectContext.componentAxis ? byY : byX)
				.map(component => component.id);
		}
		const sortedComponents = objectContext.componentOrder.map(id => components[id]);
		const minIndex = objectContext.componentAxis;
		addInitialPairsForAxis(sortedComponents, minIndex, minIndex + 2);
	};

	addInitialMergeablePairs();

	while (mergeablePairs.length) {
		const pair = popPair();
		const first = components[pair.firstId];
		const second = components[pair.secondId];
		if (
			!first.active
			|| !second.active
			|| first.version !== pair.firstVersion
			|| second.version !== pair.secondVersion
		) {
			continue;
		}

		first.bbox = pair.bbox;
		first.version++;
		second.active = false;

		for (const component of components) {
			if (component.active && component !== first) {
				addMergeablePair(first, component);
			}
		}
	}

	const result = [];
	for (const component of components) {
		if (component.active) {
			result.push(component.bbox);
		}
	}
	return result;
}

function componentSupportsImageBlock(componentBbox, block, pageRect) {
	if (!isValidRect(componentBbox) || !isValidRect(block?.bbox)) {
		return false;
	}
	const componentArea = validRectArea(componentBbox);
	const blockArea = validRectArea(block.bbox);
	if (componentArea <= 0 || blockArea <= 0) {
		return false;
	}
	const pageArea = isValidRect(pageRect) ? validRectArea(pageRect) : 0;
	if (pageArea > 0 && componentArea / pageArea >= PAGE_SUBSTRATE_MIN_COVERAGE) {
		return false;
	}
	const overlapArea = intersectionArea(componentBbox, block.bbox);
	if (overlapArea / blockArea >= IMAGE_PROVENANCE_MIN_BLOCK_COVERAGE) {
		return true;
	}
	const componentWidth = componentBbox[2] - componentBbox[0];
	const componentHeight = componentBbox[3] - componentBbox[1];
	const blockWidth = block.bbox[2] - block.bbox[0];
	const blockHeight = block.bbox[3] - block.bbox[1];
	return overlapArea / componentArea >= 0.8
		&& componentWidth / blockWidth >= IMAGE_PROVENANCE_MIN_COMPONENT_SPAN_RATIO
		&& componentHeight / blockHeight >= IMAGE_PROVENANCE_MIN_COMPONENT_SPAN_RATIO;
}

function buildImageEligibilityPredicate(blocks, lines, pageRect, independentObjectContext) {
	const objects = independentObjectContext.validObjects;
	if (!objects.length) {
		return () => false;
	}
	if (objects.length === 1) {
		return block => componentSupportsImageBlock(objects[0].bbox, block, pageRect);
	}

	let blockContext = null;
	return (block) => {
		blockContext ||= buildBlockRefinementContext(blocks, lines);
		const blockers = blockContext.getBlockers(new Set([block]));
		const components = buildObjectComponents(independentObjectContext, blockers);
		return components.some(componentBbox => componentSupportsImageBlock(componentBbox, block, pageRect));
	};
}

function shouldJoinValidObjectImageCandidate(candidateBbox, objectBbox) {
	if (validRectContains(candidateBbox, objectBbox, OBJECT_COMPONENT_GAP)) {
		return true;
	}
	return validRectsIntersect(candidateBbox, objectBbox)
		&& validRectCenterInside(objectBbox, candidateBbox)
		&& validRectArea(objectBbox) <= validRectArea(candidateBbox) * 1.05;
}

function buildObjectImageCandidates(objectContext) {
	const objects = objectContext.validObjects;
	let candidates = [];

	for (const object of objects) {
		if (!OBJECT_IMAGE_SUBTYPES.has(object.subtype)) {
			continue;
		}
		const objectIndexes = new Set([object.index]);
		let bbox = object.bbox;
		let changed = true;

		while (changed) {
			changed = false;
			for (const nextObject of objects) {
				if (objectIndexes.has(nextObject.index)) {
					continue;
				}
				if (!shouldJoinValidObjectImageCandidate(bbox, nextObject.bbox)) {
					continue;
				}
				objectIndexes.add(nextObject.index);
				bbox = unionValidRects(bbox, nextObject.bbox);
				changed = true;
			}
		}

		candidates.push({
			bbox,
			hasXObject: object.subtype === 'xobject',
		});
	}

	let merged = true;
	while (merged) {
		merged = false;
		for (let i = 0; i < candidates.length && !merged; i++) {
			for (let j = i + 1; j < candidates.length; j++) {
				if (!validRectsIntersect(candidates[i].bbox, candidates[j].bbox)) {
					continue;
				}
				candidates[i] = {
					bbox: unionValidRects(candidates[i].bbox, candidates[j].bbox),
					hasXObject: candidates[i].hasXObject || candidates[j].hasXObject,
				};
				candidates.splice(j, 1);
				merged = true;
				break;
			}
		}
	}

	return candidates;
}

function getGraphicComponentIds(lineIds, lines, objectComponents, blockers) {
	const rects = [];
	const lineRectIndexes = new Map();

	for (const lineId of lineIds) {
		const rect = getLineRect(lines, lineId);
		if (!rect) {
			continue;
		}
		lineRectIndexes.set(lineId, rects.length);
		rects.push(rect);
	}
	for (let i = 0; i < objectComponents.length; i++) {
		rects.push(objectComponents[i]);
	}

	const { find, union } = createDisjointSet(rects.length);
	for (let i = 0; i < rects.length; i++) {
		for (let j = i + 1; j < rects.length; j++) {
			if (!hasDirectSightValid(rects[i], rects[j], blockers)) {
				continue;
			}
			union(i, j);
		}
	}

	const componentByLine = new Map();
	for (const [lineId, rectIndex] of lineRectIndexes) {
		componentByLine.set(lineId, find(rectIndex));
	}
	return componentByLine;
}

function splitGraphicBlock(block, blockContext, lines, objectContext) {
	const lineIds = (block.lines || []).filter(lineId => getLineRect(lines, lineId));
	if (lineIds.length <= 1) {
		return [block];
	}

	const blockers = blockContext.getBlockers(new Set([block]));
	const objectComponents = buildObjectComponents(objectContext, blockers);
	const componentByLine = getGraphicComponentIds(lineIds, lines, objectComponents, blockers);
	const groups = [];
	let currentGroup = [];
	let currentComponent = null;

	for (const lineId of lineIds) {
		const component = componentByLine.get(lineId) ?? lineId;
		if (currentGroup.length && component !== currentComponent) {
			groups.push(currentGroup);
			currentGroup = [];
		}
		currentGroup.push(lineId);
		currentComponent = component;
	}
	if (currentGroup.length) {
		groups.push(currentGroup);
	}

	if (groups.length <= 1) {
		return [block];
	}
	return groups.map(group => createBlockFromLines(block, group, lines));
}

function objectBelongsCloserToAnotherBlock(objectBbox, currentBbox, currentBlock, blockContext) {
	const currentDistance = rectDistance(objectBbox, currentBbox);
	for (const entry of blockContext.distanceEntries) {
		if (entry.block === currentBlock) {
			continue;
		}
		const blockDistance = rectDistance(objectBbox, entry.bbox);
		if (blockDistance <= entry.lineHeight && currentDistance + DISTANCE_EPSILON >= blockDistance) {
			return true;
		}
	}
	return false;
}

function expandGraphicBlock(block, blockContext, lines, objectContext) {
	if (!GRAPHIC_BLOCK_TYPES.has(block.type)) {
		return block;
	}

	const lineIds = (block.lines || []).filter(lineId => getLineRect(lines, lineId));
	const metrics = getLineBlockMetrics(lineIds, lines, block.bbox);
	const blockers = blockContext.getBlockers(new Set([block]));
	const objectComponents = buildObjectComponents(objectContext, blockers);
	let bbox = metrics.bbox;
	const includedObjects = new Set();
	let changed = true;

	while (changed) {
		changed = false;
		for (let i = 0; i < objectComponents.length; i++) {
			if (includedObjects.has(i)) {
				continue;
			}
			if (!isValidRect(bbox) || !hasDirectSightValid(bbox, objectComponents[i], blockers)) {
				continue;
			}
			if (objectBelongsCloserToAnotherBlock(objectComponents[i], bbox, block, blockContext)) {
				continue;
			}
			includedObjects.add(i);
			bbox = unionValidRects(bbox, objectComponents[i]);
			changed = true;
		}
	}

	return {
		...block,
		bbox,
		startOffset: metrics.startOffset,
		endOffset: metrics.endOffset,
	};
}

function expandGraphicBlocks(blocks, blockContext, lines, objectContext) {
	let changed = false;
	const result = blocks.map(block => {
		const expanded = expandGraphicBlock(block, blockContext, lines, objectContext);
		if (expanded !== block && !rectsEqual(block.bbox, expanded.bbox)) {
			changed = true;
		}
		return expanded;
	});
	return { blocks: result, changed };
}

function orthogonalOverlapEnough(a1, a2, b1, b2) {
	const overlap = Math.min(a2, b2) - Math.max(a1, b1);
	if (overlap < MIN_SIGHT_OVERLAP) {
		return false;
	}
	const minSize = Math.max(Math.min(a2 - a1, b2 - b1), MIN_SIGHT_OVERLAP);
	return overlap / minSize >= 0.1;
}

function canSweepBorder(from, to, blockers) {
	if (!isValidRect(from) || !isValidRect(to)) {
		return false;
	}
	if (rectsIntersect(from, to)) {
		return clearSightRect(unionRects([from, to]), blockers);
	}

	if (to[0] >= from[2] && orthogonalOverlapEnough(from[1], from[3], to[1], to[3])) {
		return clearSightRect([from[2], from[1], to[0], from[3]], blockers);
	}
	if (to[2] <= from[0] && orthogonalOverlapEnough(from[1], from[3], to[1], to[3])) {
		return clearSightRect([to[2], from[1], from[0], from[3]], blockers);
	}
	if (to[1] >= from[3] && orthogonalOverlapEnough(from[0], from[2], to[0], to[2])) {
		return clearSightRect([from[0], from[3], from[2], to[1]], blockers);
	}
	if (to[3] <= from[1] && orthogonalOverlapEnough(from[0], from[2], to[0], to[2])) {
		return clearSightRect([from[0], to[3], from[2], from[1]], blockers);
	}
	return false;
}

function canMergeImageBlocks(first, second, blockContext) {
	const blockers = blockContext.getBlockers(new Set([first, second]));
	return canSweepBorder(first.bbox, second.bbox, blockers)
		|| canSweepBorder(second.bbox, first.bbox, blockers);
}

function mergeGraphicBlocks(first, second, lines) {
	const lineIds = [...(first.lines || []), ...(second.lines || [])]
		.filter(lineId => getLineRect(lines, lineId))
		.sort((a, b) => {
			const lineA = lines[a];
			const lineB = lines[b];
			return (lineA?.startOffset ?? a) - (lineB?.startOffset ?? b);
		});
	const metrics = getLineBlockMetrics(lineIds, lines, unionRects([first.bbox, second.bbox]));
	return {
		...first,
		flowClass: first.flowClass || second.flowClass,
		lines: lineIds,
		bbox: unionRects([first.bbox, second.bbox]),
		startOffset: metrics.startOffset,
		endOffset: metrics.endOffset,
	};
}

function getBlockLineGroupsExcluding(block, excludedLineIds) {
	const groups = [];
	let group = [];
	for (const lineId of block.lines || []) {
		if (excludedLineIds.has(lineId)) {
			if (group.length) groups.push(group);
			group = [];
			continue;
		}
		group.push(lineId);
	}
	if (group.length) groups.push(group);
	return groups;
}

function getLineCharRanges(lineIds, lines) {
	const merged = [];
	for (const lineId of lineIds) {
		const line = lines[lineId];
		if (!Number.isInteger(line?.startOffset) || !Number.isInteger(line?.endOffset)) {
			continue;
		}
		const previous = merged[merged.length - 1];
		if (previous && line.startOffset <= previous[1] + 1) {
			previous[1] = Math.max(previous[1], line.endOffset);
		}
		else {
			merged.push([line.startOffset, line.endOffset]);
		}
	}
	return merged;
}

function getPaintGlyphKey(line) {
	if (!Array.isArray(line?.chars) || !line.chars.length) {
		return null;
	}
	const { fontName, paintGlyph } = line.chars[0] || {};
	if (
		(typeof paintGlyph !== 'string' && !Number.isFinite(paintGlyph))
		|| typeof fontName !== 'string'
	) {
		return null;
	}
	const paintKey = `${fontName}\0${paintGlyph}`;
	return line.chars.every(char => (
		(typeof char?.paintGlyph === 'string' || Number.isFinite(char?.paintGlyph))
		&& typeof char?.fontName === 'string'
		&& `${char.fontName}\0${char.paintGlyph}` === paintKey
	)) ? paintKey : null;
}

function getRepeatedPaintGlyphLineIds(lines) {
	const linesByPaintKey = new Map();
	for (const line of lines) {
		const paintKey = getPaintGlyphKey(line);
		if (!paintKey) continue;
		if (!linesByPaintKey.has(paintKey)) linesByPaintKey.set(paintKey, []);
		linesByPaintKey.get(paintKey).push(line.id);
	}
	return new Set(
		[...linesByPaintKey.values()]
			.filter(lineIds => lineIds.length > MAX_IMAGE_BLOCKS_PER_PAGE)
			.flat(),
	);
}

function isPaintFragmentBlock(block, paintFragmentLineIds) {
	return isValidRect(block?.bbox)
		&& block?.lines?.length
		&& block.lines.every(lineId => paintFragmentLineIds.has(lineId));
}

function createPaintSceneImage(blocks, sceneLineIds, retainedLineIds, bbox, context) {
	const metrics = getLineBlockMetrics(sceneLineIds, context.lines, bbox);
	const flowClasses = new Set(blocks.map(block => block.flowClass).filter(Boolean));
	return {
		type: 'image',
		flowClass: flowClasses.size === 1 ? [...flowClasses][0] : 'auxiliary',
		bbox: bbox.slice(0, 4),
		lines: retainedLineIds,
		startOffset: metrics.startOffset,
		endOffset: metrics.endOffset,
		_charRanges: getLineCharRanges(retainedLineIds, context.lines),
	};
}

function replaceSceneBlocks(
	blocks,
	sceneBlocks,
	bbox,
	context,
	includedLineIds = null,
	retainedLineIds = null,
) {
	const { lines, validateReplacement } = context;
	const sceneBlockSet = new Set(sceneBlocks);
	const sceneLineIds = includedLineIds || new Set(sceneBlocks.flatMap(block => block.lines || []));
	const remaining = [];
	for (const block of blocks) {
		const blockLineIds = block.lines || [];
		const hasSceneLine = blockLineIds.some(lineId => sceneLineIds.has(lineId));
		if (!sceneBlockSet.has(block) && !hasSceneLine) {
			remaining.push(block);
			continue;
		}
		if (
			sceneBlockSet.has(block)
			&& blockLineIds.every(lineId => sceneLineIds.has(lineId))
		) {
			continue;
		}
		const groups = getBlockLineGroupsExcluding(block, sceneLineIds);
		for (const group of groups) {
			remaining.push(createBlockFromLines(block, group, lines));
		}
	}
	const lineIds = [...sceneLineIds]
		.filter(lineId => lines[lineId])
		.sort((a, b) => (lines[a]?.startOffset ?? a) - (lines[b]?.startOffset ?? b));
	const imageLineIds = retainedLineIds === null
		? lineIds
		: lineIds.filter(lineId => retainedLineIds.has(lineId));
	const sceneImage = createPaintSceneImage(
		sceneBlocks,
		lineIds,
		imageLineIds,
		bbox,
		context,
	);
	remaining.push(sceneImage);
	const replacement = remaining.sort((a, b) => a.startOffset - b.startOffset);
	return validateReplacement(replacement, sceneImage)
		? replacement
		: null;
}

function formSceneContainsLine(scene, line) {
	return Number.isFinite(scene?.seq)
		&& Array.isArray(line?.formXObjectSeqs)
		&& line.formXObjectSeqs.includes(scene.seq);
}

function collapseFormPaintScenes(blocks, formScenes, context) {
	const { lines, pageRect, paintFragmentLineIds } = context;
	const pageArea = isValidRect(pageRect) ? validRectArea(pageRect) : 0;
	const candidates = (formScenes || [])
		.filter(scene => (
			isValidRect(scene?.rect)
			&& Number.isInteger(scene.paintObjectCount)
			&& scene.paintObjectCount > MAX_IMAGE_BLOCKS_PER_PAGE
			&& (
				Number.isInteger(scene.textCharCount)
				&& scene.textCharCount
					<= scene.paintObjectCount * FORM_SCENE_MAX_TEXT_CHARS_PER_PAINT_OBJECT
			)
			&& passesStandaloneImageSize({ bbox: scene.rect }, pageRect)
			&& (
				pageArea <= 0
				|| validRectArea(scene.rect) / pageArea < PAGE_SUBSTRATE_MIN_COVERAGE
			)
		))
		.sort((a, b) => (
			(b.formXObjectSeqs?.length || 0) - (a.formXObjectSeqs?.length || 0)
			|| validRectArea(a.rect) - validRectArea(b.rect)
		));
	if (!candidates.length) {
		return blocks;
	}

	let result = blocks;
	const coveredFormSeqs = new Set();
	for (const scene of candidates) {
		if (coveredFormSeqs.has(scene.seq)) {
			continue;
		}
		if (result.some(block => (
			block?.type === 'image'
			&& isValidRect(block.bbox)
			&& validRectContains(block.bbox, scene.rect, OBJECT_COMPONENT_GAP)
		))) {
			continue;
		}
		const formLineIds = new Set(
			lines.filter(line => formSceneContainsLine(scene, line)).map(line => line.id),
		);
		const fragmentLineIds = new Set(
			[...formLineIds].filter(lineId => paintFragmentLineIds.has(lineId)),
		);
		const fragmentBlocks = result.filter(block => (
			(block.lines || []).some(lineId => fragmentLineIds.has(lineId))
		));
		const lineFreeGraphicBlocks = result.filter(block => (
			GRAPHIC_BLOCK_TYPES.has(block?.type)
			&& !(block.lines || []).length
			&& isValidRect(block.bbox)
			&& validRectContains(scene.rect, block.bbox, OBJECT_COMPONENT_GAP)
		));
		let sceneBlocks = [...fragmentBlocks, ...lineFreeGraphicBlocks];
		let sceneLineIds = fragmentLineIds;
		const fragmentCount = fragmentLineIds.size + lineFreeGraphicBlocks.length;
		if (fragmentCount <= MAX_IMAGE_BLOCKS_PER_PAGE) {
			const formBlocks = result.filter(block => (
				(block.lines || []).some(lineId => formLineIds.has(lineId))
			));
			if (
				fragmentLineIds.size
				|| formBlocks.length <= MAX_IMAGE_BLOCKS_PER_PAGE
				|| formBlocks.some(block => block.type === 'table')
			) {
				continue;
			}
			sceneBlocks = [...formBlocks, ...lineFreeGraphicBlocks];
			sceneLineIds = formLineIds;
		}
		const replacement = replaceSceneBlocks(
			result,
			sceneBlocks,
			scene.rect,
			context,
			sceneLineIds,
			fragmentLineIds.size ? new Set() : null,
		);
		if (!replacement) {
			continue;
		}
		result = replacement;
		for (const seq of scene.formXObjectSeqs || [scene.seq]) {
			coveredFormSeqs.add(seq);
		}
	}
	return result;
}

function buildPaintFragmentComponents(blocks, paintFragmentLineIds) {
	const fragments = blocks
		.filter(block => isPaintFragmentBlock(block, paintFragmentLineIds))
		.map((block, id) => ({ id, block, bbox: block.bbox }));
	if (fragments.length <= MAX_IMAGE_BLOCKS_PER_PAGE) {
		return [];
	}
	const heights = fragments
		.map(fragment => fragment.bbox[3] - fragment.bbox[1])
		.filter(height => height > 0)
		.sort((a, b) => a - b);
	const gap = Math.max(OBJECT_COMPONENT_GAP, heights[Math.floor(heights.length / 2)] || 0);
	const { find, union } = createDisjointSet(fragments.length);
	const byX = fragments.slice().sort((a, b) => a.bbox[0] - b.bbox[0] || a.id - b.id);
	for (let i = 0; i < byX.length; i++) {
		const first = byX[i];
		for (let j = i + 1; j < byX.length; j++) {
			const second = byX[j];
			if (second.bbox[0] > first.bbox[2] + gap) {
				break;
			}
			if (
				second.bbox[1] <= first.bbox[3] + gap
				&& second.bbox[3] >= first.bbox[1] - gap
			) {
				union(first.id, second.id);
			}
		}
	}
	const groups = new Map();
	for (const fragment of fragments) {
		const root = find(fragment.id);
		if (!groups.has(root)) groups.set(root, []);
		groups.get(root).push(fragment.block);
	}
	return [...groups.values()].filter(group => group.length > MAX_IMAGE_BLOCKS_PER_PAGE);
}

function collapseFragmentsIntoImageScenes(blocks, context) {
	const { pageRect, paintFragmentLineIds } = context;
	const images = blocks.filter(block => (
		block?.type === 'image'
		&& isValidRect(block.bbox)
		&& passesStandaloneImageSize(block, pageRect)
	));
	if (!images.length) {
		return blocks;
	}
	const fragmentsByImage = new Map(images.map(image => [image, []]));
	for (const block of blocks) {
		if (!isPaintFragmentBlock(block, paintFragmentLineIds)) {
			continue;
		}
		let containingImage = null;
		for (const image of images) {
			if (
				validRectCenterInside(block.bbox, image.bbox)
				&& (
					!containingImage
					|| validRectArea(image.bbox) < validRectArea(containingImage.bbox)
				)
			) {
				containingImage = image;
			}
		}
		if (containingImage) {
			fragmentsByImage.get(containingImage).push(block);
		}
	}

	let result = blocks;
	for (const image of images) {
		const fragments = fragmentsByImage.get(image);
		if (fragments.length <= MAX_IMAGE_BLOCKS_PER_PAGE || !result.includes(image)) {
			continue;
		}
		const sceneBlocks = [image, ...fragments.filter(fragment => result.includes(fragment))];
		const bbox = unionRects(sceneBlocks.map(block => block.bbox));
		const retainedLineIds = new Set(
			(image.lines || []).filter(lineId => !paintFragmentLineIds.has(lineId)),
		);
		result = replaceSceneBlocks(
			result,
			sceneBlocks,
			bbox,
			context,
			null,
			retainedLineIds,
		) || result;
	}
	return result;
}

function expandSceneBboxWithObjects(bbox, objectContext) {
	let expanded = bbox.slice();
	const includedObjects = new Set();
	let changed = true;
	while (changed) {
		changed = false;
		for (const object of objectContext.validObjects) {
			if (
				includedObjects.has(object)
				|| rectDistance(expanded, object.bbox) > OBJECT_COMPONENT_GAP
			) {
				continue;
			}
			includedObjects.add(object);
			const next = unionValidRects(expanded, object.bbox);
			if (!rectsEqual(next, expanded)) {
				expanded = next;
				changed = true;
			}
		}
	}
	return expanded;
}

function collapseFragmentPaintScenes(blocks, context) {
	const { pageRect, objectContext, paintFragmentLineIds } = context;
	let result = blocks;
	for (const component of buildPaintFragmentComponents(blocks, paintFragmentLineIds)) {
		const liveBlocks = component.filter(block => result.includes(block));
		if (liveBlocks.length <= MAX_IMAGE_BLOCKS_PER_PAGE) {
			continue;
		}
		let bbox = unionRects(liveBlocks.map(block => block.bbox));
		bbox = expandSceneBboxWithObjects(bbox, objectContext);
		if (!passesStandaloneImageSize({ bbox }, pageRect)) {
			continue;
		}
		result = replaceSceneBlocks(
			result,
			liveBlocks,
			bbox,
			context,
			null,
			new Set(),
		) || result;
	}
	return result;
}

export function collapsePaintScenes(
	blocks,
	lines,
	formScenes,
	pageRect,
	objectContext,
) {
	if (!Array.isArray(blocks) || !Array.isArray(lines)) {
		return blocks || [];
	}
	const context = {
		lines,
		pageRect,
		objectContext,
		paintFragmentLineIds: getRepeatedPaintGlyphLineIds(lines),
		validateReplacement: (replacement, sceneImage) => (
			buildImageEligibilityPredicate(
				replacement,
				lines,
				pageRect,
				objectContext,
			)(sceneImage)
		),
	};
	let result = collapseFormPaintScenes(blocks, formScenes, context);
	result = collapseFragmentsIntoImageScenes(result, context);
	result = collapseFragmentPaintScenes(result, context);
	return result;
}

function canMergeEquationBlocks(first, second, blockContext) {
	if (first?.type !== 'equation' || second?.type !== 'equation') {
		return false;
	}
	if (intersectionArea(first.bbox, second.bbox) <= 0) {
		return false;
	}
	const blockers = blockContext.getBlockers(new Set([first, second]));
	return clearSightRect(unionRects([first.bbox, second.bbox]), blockers);
}

function getEquationTextProfile(block, lines) {
	const cached = equationTextProfileCache.get(block);
	if (cached?.lines === lines) return cached.profile;

	const text = getBlockLineText(block, lines).replace(/\s+/g, ' ').trim();
	const characters = Array.from(text).filter(character => !/\s/u.test(character));
	const words = text.match(/\p{L}{2,}/gu) || [];
	let letterCount = 0;
	let mathSymbolCount = 0;
	for (const character of characters) {
		if (/\p{L}/u.test(character)) letterCount++;
		else if (/\p{Sm}/u.test(character)) mathSymbolCount++;
	}
	const profile = {
		textLength: text.length,
		firstCharacter: characters[0] || '',
		lastCharacter: characters.at(-1) || '',
		characterCount: characters.length,
		letterCount,
		mathSymbolCount,
		wordCount: words.length,
		averageWordLength: words.reduce((sum, word) => sum + Array.from(word).length, 0)
			/ Math.max(words.length, 1),
	};
	equationTextProfileCache.set(block, { lines, profile });
	return profile;
}

function isProseDominantEquationFragment(block, lines) {
	const profile = getEquationTextProfile(block, lines);
	return profile.wordCount > 1
		&& profile.mathSymbolCount <= 1
		&& profile.averageWordLength >= DISPLAY_EQUATION_PROSE_MIN_AVERAGE_WORD_LENGTH
		&& profile.letterCount / Math.max(profile.characterCount, 1)
			>= DISPLAY_EQUATION_PROSE_MIN_LETTER_RATIO;
}

function hasEquationContinuationBoundary(profile, allowOpeningStart = false) {
	return /\p{S}/u.test(profile.firstCharacter)
		|| (allowOpeningStart && /\p{Ps}/u.test(profile.firstCharacter))
		|| /\p{Pe}/u.test(profile.firstCharacter)
		|| /\p{S}/u.test(profile.lastCharacter)
		|| /\p{Ps}/u.test(profile.lastCharacter);
}

function hasEquationFragmentSignal(block, lines, allowOpeningStart = false) {
	const profile = getEquationTextProfile(block, lines);
	if (!profile.characterCount) return false;
	if (profile.textLength <= DISPLAY_EQUATION_SHORT_TEXT_LENGTH) {
		return true;
	}
	return hasEquationContinuationBoundary(profile, allowOpeningStart);
}

function hasDisplayEquationContinuationSignal(first, second, lines) {
	if (
		isProseDominantEquationFragment(first, lines)
		|| isProseDominantEquationFragment(second, lines)
	) {
		return false;
	}
	return hasEquationFragmentSignal(first, lines, true)
		|| hasEquationFragmentSignal(
			second,
			lines,
			verticalOverlapRatio(first.bbox, second.bbox) > 0,
		);
}

function horizontalGap(a, b) {
	if (!isValidRect(a) || !isValidRect(b)) {
		return Infinity;
	}
	if (b[0] > a[2]) {
		return b[0] - a[2];
	}
	if (a[0] > b[2]) {
		return a[0] - b[2];
	}
	return 0;
}

function displayEquationHorizontallyRelated(first, second, lineHeight) {
	return horizontallyRelated(first.bbox, second.bbox)
		|| horizontalGap(first.bbox, second.bbox) <= lineHeight * DISPLAY_EQUATION_MAX_HORIZONTAL_GAP_RATIO;
}

function verticalOverlapRatio(a, b) {
	if (!isValidRect(a) || !isValidRect(b)) {
		return 0;
	}
	const overlap = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
	if (overlap <= 0) {
		return 0;
	}
	const minHeight = Math.max(Math.min(a[3] - a[1], b[3] - b[1]), MIN_SIGHT_OVERLAP);
	return overlap / minHeight;
}

function visuallyJoinedEquationFragments(first, second, lineHeight) {
	return verticalOverlapRatio(first.bbox, second.bbox) >= DISPLAY_EQUATION_VISUAL_JOIN_MIN_VERTICAL_OVERLAP_RATIO
		&& horizontalGap(first.bbox, second.bbox) <= lineHeight * DISPLAY_EQUATION_VISUAL_JOIN_MAX_HORIZONTAL_GAP_RATIO;
}

function stackedEquationFragmentsOverlap(first, second) {
	const firstLineCount = first.lines?.length || 0;
	const secondLineCount = second.lines?.length || 0;
	return verticalOverlapRatio(first.bbox, second.bbox)
		>= DISPLAY_EQUATION_STACKED_MIN_VERTICAL_OVERLAP_RATIO
		&& horizontalOverlapRatio(first.bbox, second.bbox)
			>= DISPLAY_EQUATION_STACKED_MIN_HORIZONTAL_OVERLAP_RATIO
		&& Math.min(firstLineCount, secondLineCount)
			/ Math.max(firstLineCount, secondLineCount, 1)
			<= DISPLAY_EQUATION_STACKED_MAX_LINE_COUNT_RATIO;
}

function canContinueDisplayEquationRun(first, second, lines) {
	if (first?.type !== 'equation' || second?.type !== 'equation') {
		return false;
	}
	if (!isValidRect(first.bbox) || !isValidRect(second.bbox)) {
		return false;
	}
	const lineHeight = Math.max(
		getBlockLineHeight(first, lines),
		getBlockLineHeight(second, lines),
		1
	);
	if (visuallyJoinedEquationFragments(first, second, lineHeight)) {
		return true;
	}
	if (stackedEquationFragmentsOverlap(first, second)) {
		return true;
	}
	if (verticalGap(first.bbox, second.bbox) > lineHeight * DISPLAY_EQUATION_MAX_FRAGMENT_GAP_RATIO) {
		return false;
	}
	if (!displayEquationHorizontallyRelated(first, second, lineHeight)) {
		return false;
	}
	if (!hasDisplayEquationContinuationSignal(first, second, lines)) {
		return false;
	}
	return true;
}

function createMergedGraphicBlockRun(blockIndexes, blocks, lines) {
	const sourceBlock = blocks[blockIndexes[0]];
	const lineIds = [];
	for (const blockIndex of blockIndexes) {
		lineIds.push(...(blocks[blockIndex].lines || []));
	}
	const uniqueLineIds = [...new Set(lineIds)]
		.filter(lineId => getLineRect(lines, lineId))
		.sort((a, b) => {
			const lineA = lines[a];
			const lineB = lines[b];
			return (lineA?.startOffset ?? a) - (lineB?.startOffset ?? b);
		});
	const bbox = unionRects(blockIndexes.map(blockIndex => blocks[blockIndex].bbox));
	const metrics = getLineBlockMetrics(uniqueLineIds, lines, bbox);
	return {
		...sourceBlock,
		flowClass: blockIndexes
			.map(blockIndex => blocks[blockIndex].flowClass)
			.find(Boolean) || sourceBlock.flowClass,
		lines: uniqueLineIds,
		bbox,
		startOffset: metrics.startOffset,
		endOffset: metrics.endOffset,
	};
}

function mergeDisplayEquationFragmentRunsOnce(blocks, lines) {
	const mergeByFirstIndex = new Map();
	const skipIndexes = new Set();

	for (let start = 0; start < blocks.length;) {
		if (blocks[start]?.type !== 'equation') {
			start++;
			continue;
		}

		let end = start;
		while (end + 1 < blocks.length && blocks[end + 1]?.type === 'equation') {
			end++;
		}

		let i = start;
		while (i <= end) {
			const run = [i];
			while (run[run.length - 1] < end) {
				const previousIndex = run[run.length - 1];
				const nextIndex = previousIndex + 1;
				if (!canContinueDisplayEquationRun(blocks[previousIndex], blocks[nextIndex], lines)) {
					break;
				}
				run.push(nextIndex);
			}
			if (run.length > 1) {
				mergeByFirstIndex.set(run[0], createMergedGraphicBlockRun(run, blocks, lines));
				for (const blockIndex of run.slice(1)) {
					skipIndexes.add(blockIndex);
				}
			}
			i = run[run.length - 1] + 1;
		}

		start = end + 1;
	}

	if (!mergeByFirstIndex.size) {
		return { blocks, changed: false };
	}

	const result = [];
	for (let i = 0; i < blocks.length; i++) {
		if (skipIndexes.has(i)) {
			continue;
		}
		result.push(mergeByFirstIndex.get(i) || blocks[i]);
	}
	return { blocks: result, changed: true };
}

function mergeDisplayEquationFragmentRuns(blocks, lines) {
	let result = blocks;
	let didMerge = false;
	let changed = true;
	while (changed) {
		const merged = mergeDisplayEquationFragmentRunsOnce(result, lines);
		result = merged.blocks;
		changed = merged.changed;
		didMerge ||= changed;
	}
	return { blocks: result, changed: didMerge };
}

function mergeAdjacentGraphicBlocks(blocks, lines) {
	let result = blocks;
	let didMerge = false;
	let changed = true;
	while (changed) {
		changed = false;
		const blockContext = buildBlockRefinementContext(result, lines);
		const next = [];
		for (let i = 0; i < result.length; i++) {
			const block = result[i];
			const following = result[i + 1];
			if (
				block?.type === 'image'
				&& following?.type === 'image'
				&& canMergeImageBlocks(block, following, blockContext)
			) {
				next.push(mergeGraphicBlocks(block, following, lines));
				i++;
				changed = true;
				didMerge = true;
			}
			else if (canMergeEquationBlocks(block, following, blockContext)) {
				next.push(mergeGraphicBlocks(block, following, lines));
				i++;
				changed = true;
				didMerge = true;
			}
			else {
				next.push(block);
			}
		}
		result = next;
	}
	return { blocks: result, changed: didMerge };
}

function findOverlappingImageBlock(blocks, candidate) {
	let best = null;
	let bestArea = 0;
	for (const block of blocks) {
		if (block?.type !== 'image' || !isValidRect(block.bbox)) {
			continue;
		}
		const area = intersectionArea(block.bbox, candidate.bbox);
		if (area > bestArea) {
			best = block;
			bestArea = area;
		}
	}
	return best;
}

function horizontallyRelated(a, b) {
	if (!isValidRect(a) || !isValidRect(b)) {
		return false;
	}
	const overlap = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
	if (overlap > 0) {
		return true;
	}
	const aWidth = Math.max(a[2] - a[0], MIN_SIGHT_OVERLAP);
	const bWidth = Math.max(b[2] - b[0], MIN_SIGHT_OVERLAP);
	return Math.abs((a[0] + a[2]) / 2 - (b[0] + b[2]) / 2) <= Math.max(aWidth, bWidth);
}

function findObjectImageInsertionIndex(blocks, bbox) {
	let lastAbove = -1;
	for (let i = 0; i < blocks.length; i++) {
		const blockBbox = blocks[i]?.bbox;
		if (!isValidRect(blockBbox) || !horizontallyRelated(blockBbox, bbox)) {
			continue;
		}
		if (blockBbox[3] <= bbox[1] + MIN_SIGHT_OVERLAP) {
			return i;
		}
		if (blockBbox[1] >= bbox[3] - MIN_SIGHT_OVERLAP) {
			lastAbove = i;
		}
	}
	return lastAbove + 1;
}

function createObjectImageBlock(candidate) {
	return {
		type: 'image',
		flowClass: 'auxiliary',
		bbox: candidate.bbox.slice(0, 4),
		lines: [],
		startOffset: 0,
		endOffset: -1,
		text: '',
	};
}

function passesStandaloneImageSize(candidate, pageRect) {
	if (!isValidRect(candidate?.bbox)) {
		return false;
	}
	if (!isValidRect(pageRect)) {
		return true;
	}

	const width = candidate.bbox[2] - candidate.bbox[0];
	const height = candidate.bbox[3] - candidate.bbox[1];
	const pageWidth = pageRect[2] - pageRect[0];
	const pageHeight = pageRect[3] - pageRect[1];
	const pageArea = pageWidth * pageHeight;
	if (width <= 0 || height <= 0 || pageArea <= 0) {
		return false;
	}

	let matches = 0;
	if (width >= pageWidth * STANDALONE_IMAGE_MIN_WIDTH_RATIO) {
		matches++;
	}
	if (height >= pageHeight * STANDALONE_IMAGE_MIN_HEIGHT_RATIO) {
		matches++;
	}
	if (width * height >= pageArea * STANDALONE_IMAGE_MIN_AREA_RATIO) {
		matches++;
	}
	return matches >= STANDALONE_IMAGE_MIN_SIZE_MATCHES;
}

function insertObjectImageBlocks(blocks, objectContext, pageRect = null) {
	const candidates = buildObjectImageCandidates(objectContext);
	if (!candidates.length) {
		return blocks;
	}

	const result = blocks.map(block => ({ ...block }));
	const standalone = [];
	for (const candidate of candidates) {
		const intersectsNonImageBlock = result.some(block => block?.type !== 'image' && rectsIntersect(block?.bbox, candidate.bbox));
		if (intersectsNonImageBlock) {
			continue;
		}

		const imageBlock = findOverlappingImageBlock(result, candidate);
		if (imageBlock) {
			imageBlock.bbox = unionRects([imageBlock.bbox, candidate.bbox]);
			continue;
		}
		if (!passesStandaloneImageSize(candidate, pageRect)) {
			continue;
		}
		standalone.push(createObjectImageBlock(candidate));
	}

	standalone.sort((a, b) => b.bbox[3] - a.bbox[3] || a.bbox[0] - b.bbox[0]);
	for (const block of standalone) {
		result.splice(findObjectImageInsertionIndex(result, block.bbox), 0, block);
	}
	return result;
}

export function refineGraphicBlocks(
	blocks,
	lines,
	objectLines = [],
	pageRect = null,
	objectContexts = null,
) {
	const sourceBlocks = Array.isArray(blocks) ? blocks : [];
	objectContexts ||= buildGraphicObjectContexts(objectLines, pageRect);
	const { sourceObjectContext, independentObjectContext: objectContext } = objectContexts;
	if (!sourceBlocks.length) {
		return insertObjectImageBlocks(sourceBlocks, objectContext, pageRect);
	}

	let refined = [];
	const sourceBlockContext = buildBlockRefinementContext(sourceBlocks, lines);
	for (const block of sourceBlocks) {
		if (GRAPHIC_BLOCK_TYPES.has(block?.type)) {
			refined.push(...splitGraphicBlock(block, sourceBlockContext, lines, objectContext));
		}
		else {
			refined.push(block);
		}
	}

	let refinedBlockContext = buildBlockRefinementContext(refined, lines);
	let expanded = expandGraphicBlocks(refined, refinedBlockContext, lines, objectContext);
	refined = expanded.blocks;
	let merged = mergeAdjacentGraphicBlocks(refined, lines);
	refined = merged.blocks;
	let displayMerged = mergeDisplayEquationFragmentRuns(refined, lines);
	refined = displayMerged.blocks;
	if (expanded.changed || merged.changed || displayMerged.changed) {
		refinedBlockContext = buildBlockRefinementContext(refined, lines);
		refined = expandGraphicBlocks(refined, refinedBlockContext, lines, objectContext).blocks;
	}
	refined = mergeRuledTableFragments(refined, lines, objectContext, pageRect);
	if (hasFullPageImageObject(sourceObjectContext, pageRect)) {
		refined = mergeDenseScannedTableFragments(refined, lines, pageRect);
		refined = cleanupScannedTableJunkFragments(refined, lines, pageRect);
	}
	refined = insertObjectImageBlocks(refined, objectContext, pageRect);
	return refined;
}

function addLineToBlock(block, line) {
	block.bbox = expandBbox(block.bbox, line.rect);
	block.lines.push(line.id);
	if (Number.isInteger(line.startOffset)) {
		block.startOffset = Number.isInteger(block.startOffset)
			? Math.min(block.startOffset, line.startOffset)
			: line.startOffset;
	}
	if (Number.isInteger(line.endOffset)) {
		block.endOffset = Number.isInteger(block.endOffset)
			? Math.max(block.endOffset, line.endOffset)
			: line.endOffset;
	}
}

function buildClusterBlocks(lines, labels) {
	const blocks = [];
	let currentBlock = null;

	const flush = () => {
		if (currentBlock) {
			blocks.push(currentBlock);
			currentBlock = null;
		}
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const label = labels[i];
		const base = clusterBaseFromLabel(label);
		const shouldContinue = isContinuationLabel(label) && currentBlock && currentBlock.clusterBase === base;
		if (!shouldContinue) {
			flush();
			currentBlock = {
				type: 'body',
				clusterBase: base,
				bbox: null,
				lines: [],
				startOffset: line.startOffset,
				endOffset: line.endOffset,
			};
		}
		addLineToBlock(currentBlock, line);
	}
	flush();

	for (const block of blocks) {
		delete block.clusterBase;
		if (!Number.isInteger(block.startOffset)) {
			block.startOffset = 0;
		}
		if (!Number.isInteger(block.endOffset)) {
			block.endOffset = block.startOffset;
		}
	}
	return blocks;
}

function getFinalBlockType(predictedType, fallbackType) {
	if (predictedType === 'paragraph') {
		return 'body';
	}
	if (predictedType) {
		return predictedType;
	}
	return fallbackType || 'body';
}

export function applyBlockClassifierPredictions(blocks, predictions) {
	for (let i = 0; i < blocks.length; i++) {
		const block = blocks[i];
		const prediction = predictions[i];
		const blockType = prediction?.blockTypeName;
		const flowClass = prediction?.flowClassName || 'body';
		block.type = getFinalBlockType(blockType, block.type);
		block.flowClass = flowClass;
	}
	return blocks;
}

function attachBlockText(blocks, lines) {
	for (const block of blocks) {
		block.text = block.lines
			.map(id => lines[id])
			.filter(Boolean)
			.map(line => line.text || '')
			.join(' ');
	}
	return blocks;
}

function isAuxiliaryImageFragment(block) {
	return block?.flowClass === 'auxiliary'
		&& block.type === 'image';
}

function mergeImageFragments(fragments, lines) {
	const lineIds = [...new Set(fragments.flatMap(block => block.lines || []))]
		.filter(lineId => lines[lineId])
		.sort((a, b) => (lines[a]?.startOffset ?? a) - (lines[b]?.startOffset ?? b));
	const bbox = unionRects(fragments.map(block => block.bbox));
	const metrics = lineIds.length ? getLineBlockMetrics(lineIds, lines, bbox) : null;
	const flowClasses = new Set(fragments.map(block => block.flowClass));
	return {
		type: 'image',
		flowClass: flowClasses.size === 1 ? fragments[0].flowClass : 'body',
		bbox,
		lines: lineIds,
		startOffset: metrics?.startOffset ?? 0,
		endOffset: metrics?.endOffset ?? -1,
	};
}

function countImageBlocks(blocks) {
	return blocks.reduce((count, block) => count + (block?.type === 'image' ? 1 : 0), 0);
}

function mergeAuxiliaryGraphicRuns(blocks, lines, shouldMerge) {
	const firstFragmentIndex = blocks.findIndex(isAuxiliaryImageFragment);
	if (firstFragmentIndex < 0) return blocks;
	const result = blocks.slice(0, firstFragmentIndex);
	for (let i = firstFragmentIndex; i < blocks.length;) {
		if (!isAuxiliaryImageFragment(blocks[i])) {
			result.push(blocks[i]);
			i++;
			continue;
	}

		let end = i + 1;
		while (end < blocks.length && isAuxiliaryImageFragment(blocks[end])) {
			end++;
		}
		const fragments = blocks.slice(i, end);
		if (fragments.length > 1 && shouldMerge(fragments)) {
			result.push(mergeImageFragments(fragments, lines));
		}
		else {
			for (const fragment of fragments) {
				result.push(fragment);
			}
		}
		i = end;
	}
	return result;
}

function getImageLayoutRect(imageEntries, pageRect) {
	let rect = isValidRect(pageRect) ? pageRect.slice(0, 4) : null;
	if (!rect || rect[2] === rect[0] || rect[3] === rect[1]) {
		rect = unionRects(imageEntries.map(entry => entry.block.bbox));
	}
	if (rect[2] === rect[0]) {
		rect[2] = rect[0] + 1;
	}
	if (rect[3] === rect[1]) {
		rect[3] = rect[1] + 1;
	}
	return rect;
}

function getSpatialGridDimensions(limit, rect) {
	const width = Math.max(1, rect[2] - rect[0]);
	const height = Math.max(1, rect[3] - rect[1]);
	const columns = Math.max(1, Math.min(limit, Math.round(Math.sqrt(limit * width / height))));
	const rows = Math.max(1, Math.floor(limit / columns));
	return { columns, rows };
}

function compactImagesBySpatialRegion(blocks, lines, pageRect, limit) {
	const imageEntries = [];
	for (let index = 0; index < blocks.length; index++) {
		if (blocks[index]?.type === 'image') {
			imageEntries.push({ block: blocks[index], index });
		}
	}
	const layoutRect = getImageLayoutRect(imageEntries, pageRect);
	const { columns, rows } = getSpatialGridDimensions(limit, layoutRect);
	const width = layoutRect[2] - layoutRect[0];
	const height = layoutRect[3] - layoutRect[1];
	const clusters = new Map();

	for (const entry of imageEntries) {
		const bbox = entry.block.bbox;
		let column = 0;
		let row = 0;
		if (isValidRect(bbox)) {
			const centerX = (bbox[0] + bbox[2]) / 2;
			const centerY = (bbox[1] + bbox[3]) / 2;
			column = Math.max(0, Math.min(columns - 1, Math.floor((centerX - layoutRect[0]) / width * columns)));
			row = Math.max(0, Math.min(rows - 1, Math.floor((centerY - layoutRect[1]) / height * rows)));
		}
		const key = row * columns + column;
		if (!clusters.has(key)) {
			clusters.set(key, []);
		}
		clusters.get(key).push(entry);
	}

	const replacements = new Map();
	const skipped = new Set();
	for (const entries of clusters.values()) {
		if (entries.length === 1) continue;
		const firstIndex = entries[0].index;
		replacements.set(firstIndex, mergeImageFragments(entries.map(entry => entry.block), lines));
		for (let i = 1; i < entries.length; i++) {
			skipped.add(entries[i].index);
		}
	}

	const result = [];
	for (let i = 0; i < blocks.length; i++) {
		if (skipped.has(i)) {
			continue;
		}
		result.push(replacements.get(i) || blocks[i]);
	}
	return result;
}

/**
 * Enforce a content-independent upper bound on renderable image blocks for a
 * page. Pages within the budget are returned untouched. Over-budget pages first
 * collapse adjacent auxiliary graphics, then use bounded spatial regions as a
 * fallback so arbitrary block ordering cannot evade the limit.
 */
export function compactExcessiveImageBlocks(
	blocks,
	lines,
	pageRect,
	maxImageBlocks = MAX_IMAGE_BLOCKS_PER_PAGE,
) {
	if (!Array.isArray(blocks) || !blocks.length) {
		return blocks || [];
	}
	const limit = Math.max(1, Math.floor(maxImageBlocks));
	if (countImageBlocks(blocks) <= limit) {
		return blocks;
	}

	const runCompacted = mergeAuxiliaryGraphicRuns(blocks, lines, () => true);
	if (countImageBlocks(runCompacted) <= limit) {
		return runCompacted;
	}
	return compactImagesBySpatialRegion(runCompacted, lines, pageRect, limit);
}

function mergeSmallAuxiliaryGraphicRuns(blocks, lines, pageRect) {
	return mergeAuxiliaryGraphicRuns(
		blocks,
		lines,
		fragments => fragments.some(block => !passesStandaloneImageSize(block, pageRect)),
	);
}

function isTrivialEquationFragment(block, lines, pageRect) {
	const profile = getEquationTextProfile(block, lines);
	if (!profile.characterCount) {
		return !passesStandaloneImageSize(block, pageRect);
	}
	const isLowInformation = (
		profile.letterCount === 0
		&& profile.mathSymbolCount === 0
	) || (
		profile.characterCount <= TRIVIAL_EQUATION_MAX_CHARACTER_COUNT
		&& profile.mathSymbolCount === 0
	);
	return isLowInformation && !passesStandaloneImageSize(block, pageRect);
}

function hasEquationSatellite(first, second) {
	const firstArea = rectArea(first?.bbox);
	const secondArea = rectArea(second?.bbox);
	if (firstArea <= 0 || secondArea <= 0) return false;
	return Math.min(firstArea, secondArea) / Math.max(firstArea, secondArea)
		<= EQUATION_SATELLITE_MAX_AREA_RATIO;
}

function canMergeAlignedEquationFragments(first, second, blockContext, lines) {
	if (first?.type !== 'equation' || second?.type !== 'equation') return false;
	if (!hasEquationSatellite(first, second)) return false;
	if (
		isProseDominantEquationFragment(first, lines)
		|| isProseDominantEquationFragment(second, lines)
	) {
		return false;
	}
	if (
		verticalOverlapRatio(first.bbox, second.bbox)
		< DISPLAY_EQUATION_VISUAL_JOIN_MIN_VERTICAL_OVERLAP_RATIO
	) {
		return false;
	}
	const blockers = blockContext.getBlockers(new Set([first, second]));
	return clearSightRect(unionRects([first.bbox, second.bbox]), blockers);
}

function mergeAlignedEquationFragments(blocks, lines) {
	const hasCandidatePair = blocks.some((block, index) => {
		const next = blocks[index + 1];
		return block?.type === 'equation'
			&& next?.type === 'equation'
			&& hasEquationSatellite(block, next);
	});
	if (!hasCandidatePair) return blocks;

	let result = blocks;
	let changed = true;
	while (changed) {
		changed = false;
		const blockContext = buildBlockRefinementContext(result, lines);
		const next = [];
		for (let i = 0; i < result.length; i++) {
			const first = result[i];
			const second = result[i + 1];
			if (canMergeAlignedEquationFragments(first, second, blockContext, lines)) {
				next.push(mergeGraphicBlocks(first, second, lines));
				i++;
				changed = true;
				continue;
			}
			next.push(first);
		}
		result = next;
	}
	return result;
}

function demoteOrDropGraphicFragment(block) {
	if (block.lines?.length) {
		return { ...block, type: 'body' };
	}
	return null;
}

/**
 * Ensure image and equation nodes are useful standalone render targets. Small
 * adjacent image fragments are consolidated; remaining sub-figure images and
 * trivial equation fragments become text blocks or are dropped when empty.
 */
export function enforceStandaloneGraphicQuality(
	blocks,
	lines,
	pageRect,
	objectLines = [],
	objectContexts = null,
) {
	let consolidated = mergeSmallAuxiliaryGraphicRuns(blocks, lines, pageRect);
	consolidated = mergeAlignedEquationFragments(consolidated, lines);
	const hasImageBlocks = consolidated.some(block => block?.type === 'image');
	let hasIndependentImageProvenance = null;
	if (hasImageBlocks) {
		objectContexts ||= buildGraphicObjectContexts(objectLines, pageRect);
		hasIndependentImageProvenance = buildImageEligibilityPredicate(
			consolidated,
			lines,
			pageRect,
			objectContexts.independentObjectContext,
		);
	}
	const result = [];
	for (const block of consolidated) {
		let replacement = block;
		if (
			block?.type === 'image'
			&& (
				!passesStandaloneImageSize(block, pageRect)
				|| !hasIndependentImageProvenance(block)
			)
		) {
			replacement = demoteOrDropGraphicFragment(block);
		}
		else if (block?.type === 'equation' && isTrivialEquationFragment(block, lines, pageRect)) {
			replacement = demoteOrDropGraphicFragment(block);
		}
		if (replacement) {
			result.push(replacement);
		}
	}
	return result;
}

function finalizePageBlocks(blocks, prepared, pageRect) {
	const { textLines, objectLines, formScenes } = prepared;
	const objectContexts = buildGraphicObjectContexts(objectLines, pageRect);
	blocks = refineGraphicBlocks(blocks, textLines, objectLines, pageRect, objectContexts);
	blocks = compactExcessiveImageBlocks(blocks, textLines, pageRect);
	blocks = enforceStandaloneGraphicQuality(
		blocks,
		textLines,
		pageRect,
		objectLines,
		objectContexts,
	);
	blocks = collapsePaintScenes(
		blocks,
		textLines,
		formScenes,
		pageRect,
		objectContexts.independentObjectContext,
	);
	blocks = compactExcessiveImageBlocks(blocks, textLines, pageRect);
	blocks = detectPreformattedBlocks(blocks, textLines);
	return attachBlockText(blocks, textLines);
}

function getCachedClusterRuntime(runtimeCache, onnxRuntimeProvider, modelProvider) {
	if (!runtimeCache) {
		return getBlockClusterRuntime(onnxRuntimeProvider, modelProvider);
	}
	runtimeCache.clusterRuntimePromise ||= getBlockClusterRuntime(onnxRuntimeProvider, modelProvider);
	return runtimeCache.clusterRuntimePromise;
}

function getCachedClassifierRuntime(runtimeCache, onnxRuntimeProvider, modelProvider) {
	if (!runtimeCache) {
		return getBlockSegClassifierRuntime(onnxRuntimeProvider, modelProvider);
	}
	runtimeCache.classifierRuntimePromise ||= getBlockSegClassifierRuntime(onnxRuntimeProvider, modelProvider);
	return runtimeCache.classifierRuntimePromise;
}

async function inferPage(pageDataItem, onnxRuntimeProvider, modelProvider, val = {}, runtimeCache = null) {
	const prepared = prepareBlockSegPageInput(pageDataItem);
	const { textLines, objectLines, lineFeatures, objectFeatures } = prepared;
	if (!lineFeatures.length) {
		return finalizePageBlocks([], prepared, pageDataItem?.viewBox);
	}
	if (lineFeatures.length > MAX_INFERENCE_LINES_PER_PAGE) {
		const fallbackBlocks = buildRecordedParagraphFallback(pageDataItem, val, 'too_many_lines', {
			lineCount: lineFeatures.length,
			objectCount: objectFeatures.length,
			limit: MAX_INFERENCE_LINES_PER_PAGE,
		});
		return finalizePageBlocks(fallbackBlocks, prepared, pageDataItem?.viewBox);
	}

	const clusterRuntime = await getCachedClusterRuntime(runtimeCache, onnxRuntimeProvider, modelProvider);
	const { labels } = await clusterRuntime.run(lineFeatures, objectFeatures);
	let blocks = buildClusterBlocks(textLines, labels);

	const classifierRuntime = await getCachedClassifierRuntime(runtimeCache, onnxRuntimeProvider, modelProvider);
	const features = buildBlockClassifierFeatures({
		blocks,
		lines: textLines,
		lineFeatures,
		objectFeatures,
	});
	const predictions = await classifierRuntime.run(features);
	blocks = applyBlockClassifierPredictions(blocks, predictions);
	return finalizePageBlocks(blocks, prepared, pageDataItem?.viewBox);
}

export async function inference(pageDataList, onnxRuntimeProvider, modelProvider, val) {
	return inferPage(pageDataList[0], onnxRuntimeProvider, modelProvider, val);
}

export async function inferenceBatch(pageDataList, onnxRuntimeProvider, modelProvider, vals = []) {
	const blockLists = [];
	const runtimeCache = {};
	for (let i = 0; i < pageDataList.length; i++) {
		blockLists.push(await inferPage(pageDataList[i], onnxRuntimeProvider, modelProvider, vals[i] || {}, runtimeCache));
	}
	return blockLists;
}

export { buildInferenceErrorFallbackBlocks };

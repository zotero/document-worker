import { getBlockPlainText } from '../../../../structured-document-text/src/pdf/index.js';
import { contentsLocatorMatchesPageLabel } from '../contents.js';
import { titles as REFERENCE_TITLES } from '../reference/titles.js';
import { getClosestDistance, resolveDestination } from '../util.js';

const ACKNOWLEDGMENT_TOP_TITLES = [
	'acknowledgment',
	'acknowledgments',
	'acknowledgement',
	'acknowledgements',
];
const ABSTRACT_TERMINAL_TITLES = [
	'abstract',
	'resume',
	'résumé',
	'resumé',
	'resumen',
	'summary',
	'zusammenfassung',
];
const KEYWORD_TERMINAL_TITLES = [
	'index terms',
	'key word',
	'key words',
	'keyword',
	'keywords',
	'mots clés',
	'mots cles',
	'palabras clave',
	'schlagworter',
	'schlagwörter',
	'schlüsselwörter',
	'subject terms',
];
const COPYRIGHT_TERMINAL_TITLES = [
	'copyright',
];
const REFERENCE_TOP_TITLES = [
	'references',
	'bibliography',
];
const REFERENCE_TERMINAL_TITLES = new Set(REFERENCE_TITLES.map(normalizeLooseTitle));

// Match outline numbers like "1.2.3", "A.1", "IV.2", but not regular words.
const OUTLINE_NUMBER_RE = /^\s*((?:\d+|[A-Za-z]+)(?:[.-](?:\d+|[A-Za-z]+))*)(?=\s|[.)\-:]|$)/;
const ROMAN_NUMERAL_RE = /^[IVXivx]+$/;

function getOutlineNumberParts(text) {
	if (!text || typeof text !== 'string') return [];
	const match = OUTLINE_NUMBER_RE.exec(text);
	if (!match) return [];

	const parts = match[1].split(/[.-]/);
	if (parts.length === 1) {
		const part = parts[0];
		const isDigits = /^\d+$/.test(part);
		const isSingleLetter = /^[A-Za-z]$/.test(part);
		const isRomanNumeral = ROMAN_NUMERAL_RE.test(part) && part.length <= 4;
		if (!isDigits && !isSingleLetter && !isRomanNumeral) {
			return [];
		}
	}

	for (const part of parts) {
		const isDigits = /^\d+$/.test(part);
		if (!isDigits) {
			const isSingleLetter = /^[A-Za-z]$/.test(part);
			const isRomanNumeral = ROMAN_NUMERAL_RE.test(part) && part.length <= 4;
			if (!isSingleLetter && !isRomanNumeral) {
				return [];
			}
		}
	}

	return parts;
}

function getUppercaseRatio(text) {
	if (!text || typeof text !== 'string' || text.length === 0) return 0;
	let uppercaseCount = 0;
	for (const char of text) {
		if (char === char.toUpperCase()) uppercaseCount++;
	}
	return Number((uppercaseCount / text.length).toFixed(2));
}

function isNumericChild(parentParts, childParts) {
	if (!Array.isArray(parentParts) || !Array.isArray(childParts)) return false;
	if (parentParts.length === 0) return false;

	if (childParts.length === parentParts.length + 1) {
		for (let i = 0; i < parentParts.length; i++) {
			if (parentParts[i] !== childParts[i]) return false;
		}
		return true;
	}

	if (childParts.length === parentParts.length) {
		for (let i = 0; i < parentParts.length - 1; i++) {
			if (parentParts[i] !== childParts[i]) return false;
		}
		return true;
	}

	return false;
}

function normalizeFontName(name) {
	if (!name || typeof name !== 'string') return '';
	const plusIndex = name.indexOf('+');
	if (plusIndex !== -1 && plusIndex < name.length - 1) {
		name = name.slice(plusIndex + 1);
	}
	return name.trim();
}

function fontWeightScore(name) {
	if (!name) return 0;
	const lowered = name.toLowerCase();
	if (lowered.includes('black')) return 4;
	if (lowered.includes('heavy')) return 3.5;
	if (lowered.includes('bold')) return 3;
	if (lowered.includes('semibold') || lowered.includes('demi')) return 2.5;
	if (lowered.includes('medium')) return 2;
	if (lowered.includes('regular')) return 1;
	return 0;
}

function clamp(value, min, max) {
	return Math.min(Math.max(value, min), max);
}

function getMedian(values) {
	if (!values.length) return 0;
	const sorted = values.slice().sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function computeItemStyle(item) {
	const fontSize = Number.isFinite(item._fontSize) ? item._fontSize : 0;
	const sizeBucket = Math.round(fontSize * 2) / 2;
	const fontName = normalizeFontName(item._fontName || '');
	const upper = getUppercaseRatio(item.title) >= 0.9;
	item._styleKey = `${fontName}|${sizeBucket}|${upper}`;
	item._sizeBucket = sizeBucket;
	item._upper = upper;
	item._numericParts = getOutlineNumberParts(item.title);
	return item;
}

function normalizeLooseTitle(title) {
	if (!title || typeof title !== 'string') return '';
	return title
		.normalize('NFKC')
		.replace(/[^\p{L}\p{N}]+/gu, ' ')
		.trim()
		.toLowerCase();
}

function buildAllBlocksByPage(blocks) {
	const allBlocksByPage = new Map();
	for (let i = 0; i < blocks.length; i++) {
		const block = blocks[i];
		if (block.flowClass === 'excluded') continue;
		const metrics = block._metrics || {};
		const anchorRect = block?.anchor?.pageRects?.[0];
		const rect = metrics.rect || (anchorRect ? anchorRect.slice(1) : null);
		const pageIndex = anchorRect ? anchorRect[0] : (Number.isFinite(metrics.pageIndex) ? metrics.pageIndex : null);
		if (!Number.isFinite(pageIndex)) continue;

		const entry = {
			title: getBlockPlainText(block),
			type: block.type,
			_blockIndex: i,
			_pageIndex: pageIndex,
			_rect: rect,
			_fontName: metrics.fontName || metrics.firstCharFontName || '',
			_fontSize: metrics.fontSize || metrics.firstCharFontSize || 0,
			_firstCharFontName: metrics.firstCharFontName || '',
			_firstCharFontSize: metrics.firstCharFontSize || 0,
			_contentsNavigationHeading: block._contentsNavigationHeading === true,
		};

		let list = allBlocksByPage.get(pageIndex);
		if (!list) {
			list = [];
			allBlocksByPage.set(pageIndex, list);
		}
		list.push(entry);
	}
	return allBlocksByPage;
}

function extractHeadingItems(blocks) {
	const headingItems = [];
	for (let i = 0; i < blocks.length; i++) {
		const block = blocks[i];
		if (block.flowClass === 'excluded' || block._contentsNavigationHeading) continue;
		if (block.type !== 'heading') continue;
		const metrics = block._metrics || {};
		const anchorRect = block?.anchor?.pageRects?.[0];
		const rect = metrics.rect || (anchorRect ? anchorRect.slice(1) : null);
		const pageIndex = anchorRect ? anchorRect[0] : (Number.isFinite(metrics.pageIndex) ? metrics.pageIndex : null);
		const item = {
			title: getBlockPlainText(block),
			ref: [i],
			_blockIndex: i,
			_pageIndex: pageIndex,
			_rect: rect,
			_fontName: metrics.fontName || metrics.firstCharFontName || '',
			_fontSize: metrics.fontSize || metrics.firstCharFontSize || 0,
			_orderIndex: i,
		};
		computeItemStyle(item);
		headingItems.push(item);
	}
	return headingItems;
}

function normalizeText(text) {
	if (!text || typeof text !== 'string') return '';
	return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

function textMatches(nativeTitle, blockText) {
	const normNative = normalizeText(nativeTitle);
	const normBlock = normalizeText(blockText);
	if (!normNative || !normBlock) return false;
	return normBlock.startsWith(normNative) || normNative.startsWith(normBlock);
}

function truncateToNativeTitle(blockTitle, nativeTitle) {
	if (!blockTitle || !nativeTitle) return blockTitle || '';
	const nativeLen = nativeTitle.length;
	if (nativeLen <= 0 || blockTitle.length <= nativeLen) return blockTitle;

	const searchStart = Math.max(0, nativeLen - 3);
	const searchEnd = Math.min(blockTitle.length - 1, nativeLen + 3);
	let cutPoint = nativeLen;
	let bestDistance = Number.POSITIVE_INFINITY;

	for (let i = searchStart; i <= searchEnd; i++) {
		if (/\s/.test(blockTitle[i])) {
			const distance = Math.abs(i - nativeLen);
			if (distance < bestDistance) {
				bestDistance = distance;
				cutPoint = i;
			}
		}
	}

	return blockTitle.slice(0, cutPoint).trim();
}

export async function getNativeOutline(pdfDocument) {
	if (!pdfDocument) return [];
	let items;
	try {
		items = await pdfDocument.pdfManager.ensureCatalog('documentOutline');
	} catch {
		items = null;
	}
	if (!items) return [];

	async function transformItems(list) {
		const result = [];
		for (const item of list) {
			const newItem = {
				title: item.title || '',
				items: [],
			};
			if (item.dest) {
				const position = await resolveDestination(pdfDocument, item.dest);
				if (position) {
					newItem.location = { position };
				}
			} else if (item.unsafeUrl) {
				newItem.url = item.unsafeUrl;
			}
			if (item.items && item.items.length) {
				newItem.items = await transformItems(item.items);
			}
			result.push(newItem);
		}
		return result;
	}

	let outline = await transformItems(items);
	if (outline.length === 1 && outline[0].items.length > 1) {
		outline = outline[0].items;
	}
	return outline;
}

export function flattenNativeOutline(items, depth = 0, parent = null, out = [], orderRef = { value: 0 }) {
	for (const item of items || []) {
		const orderIndex = orderRef.value++;
		const pageIndex = item?.location?.position?.pageIndex;
		let rect = item?.location?.position?.rect;
		if (!rect && Array.isArray(item?.location?.position?.rects) && item.location.position.rects.length) {
			rect = item.location.position.rects[0];
		}
		const node = {
			title: item.title || '',
			_depth: depth,
			_pageIndex: Number.isFinite(pageIndex) ? pageIndex : null,
			_rect: Array.isArray(rect) ? rect : null,
			_orderIndex: orderIndex,
			_location: item.location,
			_url: item.url,
			_parent: parent,
			_children: [],
		};
		if (parent) {
			parent._children.push(node);
		}
		out.push(node);
		if (item.items && item.items.length) {
			flattenNativeOutline(item.items, depth + 1, node, out, orderRef);
		}
	}
	return out;
}

function matchNativeToBlocks(nativeNodes, allBlocksByPage) {
	const matches = [];
	const usedBlocks = new Set();
	for (const native of nativeNodes) {
		if (!Number.isFinite(native._pageIndex)) continue;
		const pageBlocks = allBlocksByPage.get(native._pageIndex) || [];
		for (const block of pageBlocks) {
			if (usedBlocks.has(block)) continue;
			if (block.type !== 'heading') continue;
			if (textMatches(native.title, block.title)) {
				usedBlocks.add(block);
				matches.push({ native, block });
				break;
			}
		}
	}
	return matches;
}

function buildNativeMatchedItems(matches) {
	const items = [];
	for (const { native, block } of matches) {
		const title = truncateToNativeTitle(block.title || '', native.title || '');
		const item = {
			title,
			ref: [block._blockIndex],
			_blockIndex: block._blockIndex,
			_pageIndex: block._pageIndex,
			_rect: block._rect,
			_fontName: block._fontName || '',
			_fontSize: block._fontSize || 0,
			_orderIndex: block._blockIndex,
			_nativeDepth: native._depth,
			_nativeParent: native._parent,
			_nativeChildren: native._children,
		};
		computeItemStyle(item);
		items.push(item);
	}
	return items;
}

function recoverInlineHeadings(allBlocksByPage, confirmedStyles, usedBlockIndices) {
	const recoveredItems = [];
	if (!confirmedStyles.size) return recoveredItems;

	const skipTypes = new Set(['note', 'caption', 'table', 'image', 'math']);
	for (const pageBlocks of allBlocksByPage.values()) {
		for (const block of pageBlocks) {
			if (usedBlockIndices.has(block._blockIndex)) continue;
			if (block._contentsNavigationHeading) continue;
			if (skipTypes.has(block.type)) continue;
			if (!block.title || block.title.length > 150) continue;

			const firstCharFontSize = block._firstCharFontSize || 0;
			const firstCharFontName = normalizeFontName(block._firstCharFontName || '');
			if (!firstCharFontName && !firstCharFontSize) continue;

			const upper = getUppercaseRatio(block.title) >= 0.9;
			const firstCharSizeBucket = Math.round(firstCharFontSize * 2) / 2;
			const firstCharStyleKey = `${firstCharFontName}|${firstCharSizeBucket}|${upper}`;
			if (!confirmedStyles.has(firstCharStyleKey)) continue;

			const blockFontSize = block._fontSize || 0;
			const blockFontName = normalizeFontName(block._fontName || '');
			const blockSizeBucket = Math.round(blockFontSize * 2) / 2;
			const blockStyleKey = `${blockFontName}|${blockSizeBucket}|${upper}`;
			if (firstCharStyleKey === blockStyleKey) continue;

			const item = {
				title: block.title,
				ref: [block._blockIndex],
				_blockIndex: block._blockIndex,
				_pageIndex: block._pageIndex,
				_rect: block._rect,
				_fontName: block._firstCharFontName || '',
				_fontSize: firstCharFontSize,
				_orderIndex: block._blockIndex,
				_recovered: true,
			};
			computeItemStyle(item);
			recoveredItems.push(item);
			usedBlockIndices.add(block._blockIndex);
		}
	}

	return recoveredItems;
}

function getComparableTitleKey(title) {
	return normalizeLooseTitle(title).replace(/\s/gu, '');
}

function getBlockStyles(block) {
	const upper = getUppercaseRatio(block.title) >= 0.9;
	const styles = [];
	for (const [fontName, fontSize] of [
		[block._fontName, block._fontSize],
		[block._firstCharFontName, block._firstCharFontSize],
	]) {
		const normalizedFontName = normalizeFontName(fontName || '');
		const sizeBucket = Math.round((fontSize || 0) * 2) / 2;
		if (normalizedFontName || sizeBucket) {
			styles.push({
				key: `${normalizedFontName}|${sizeBucket}|${upper}`,
				fontName,
				fontSize,
			});
		}
	}
	return styles.filter((style, index) => (
		styles.findIndex(candidate => candidate.key === style.key) === index
	));
}

function getRowDestinations(row) {
	return row.linkDestinations || [];
}

function selectDestinationMatch(candidates, destination) {
	if (candidates.length === 1) return candidates[0];
	if (!destination?.rect || candidates.some(candidate => !candidate._rect)) return null;
	const ranked = candidates
		.map(candidate => ({
			candidate,
			distance: getClosestDistance(candidate._rect, destination.rect),
		}))
		.sort((a, b) => a.distance - b.distance);
	return ranked.length > 1 && ranked[0].distance === ranked[1].distance
		? null
		: ranked[0]?.candidate || null;
}

function findLinkedTitleMatch(row, candidatesByPage) {
	const titleKey = row.titleKey || getComparableTitleKey(row.title);
	if (!titleKey) return null;
	const matches = [];
	for (const destination of getRowDestinations(row)) {
		if (!Number.isInteger(destination.pageIndex)) continue;
		const candidates = (candidatesByPage.get(destination.pageIndex) || [])
			.filter(candidate => getComparableTitleKey(candidate.title) === titleKey);
		const match = selectDestinationMatch(candidates, destination);
		if (match) matches.push({ match, destination });
	}
	const unique = matches.filter(({ match }, index) => (
		matches.findIndex(candidate => candidate.match._blockIndex === match._blockIndex) === index
	));
	return unique.length === 1
		? { ...unique[0].match, _matchedDestination: unique[0].destination }
		: null;
}

function groupItemsByPage(items) {
	const result = new Map();
	for (const item of items) {
		if (!Number.isInteger(item._pageIndex)) continue;
		if (!result.has(item._pageIndex)) result.set(item._pageIndex, []);
		result.get(item._pageIndex).push(item);
	}
	return result;
}

function findContentsBlockMatch(row, pageBlocks) {
	const rowKey = row.titleKey || getComparableTitleKey(row.title);
	if (!rowKey) return null;
	const matches = [];
	for (let start = 0; start < pageBlocks.length; start++) {
		if (pageBlocks[start].type !== 'heading') continue;
		let title = '';
		for (let end = start; end < pageBlocks.length; end++) {
			const block = pageBlocks[end];
			if (block.type !== 'heading' && block.type !== 'paragraph') break;
			title = title ? `${title} ${block.title}` : block.title;
			const key = getComparableTitleKey(title);
			if (key === rowKey) {
				matches.push({ title, block: pageBlocks[start] });
				break;
			}
			if (!key || !rowKey.startsWith(key)) break;
		}
	}
	return matches.length === 1 ? matches[0] : null;
}

function buildPrintedContentsOutline(allBlocksByPage, navigationRegions, pageLabels) {
	const items = [];
	const usedBlockIndices = new Set();
	for (const region of navigationRegions) {
		if (region.source !== 'heading-concentration') continue;
		for (const row of region.rows || []) {
			if (
				!Number.isInteger(row.targetPage)
				|| !contentsLocatorMatchesPageLabel(row.locatorKey, pageLabels?.[row.targetPage])
			) {
				continue;
			}
			const match = findContentsBlockMatch(
				row,
				allBlocksByPage.get(row.targetPage) || [],
			);
			if (!match || usedBlockIndices.has(match.block._blockIndex)) continue;
			usedBlockIndices.add(match.block._blockIndex);
			items.push({
				title: match.title,
				ref: [match.block._blockIndex],
			});
		}
	}
	return items.sort((a, b) => a.ref[0] - b.ref[0]);
}

function markAlignedContentsHeadings(headingItems, navigationRegions) {
	const alignedBlockIndices = new Set();
	if (!navigationRegions?.length) return alignedBlockIndices;
	const navigationPages = new Set(navigationRegions.map(region => region.pageIndex));
	const headingsByTitle = new Map();
	for (const item of headingItems) {
		if (navigationPages.has(item._pageIndex)) continue;
		const key = getComparableTitleKey(item.title);
		if (!key) continue;
		if (!headingsByTitle.has(key)) headingsByTitle.set(key, []);
		headingsByTitle.get(key).push(item);
	}

	for (const region of navigationRegions) {
		const matches = [];
		const usedBlockIndices = new Set();
		for (const row of region.rows || []) {
			const candidates = (headingsByTitle.get(row.titleKey || getComparableTitleKey(row.title)) || [])
				.filter(item => item._pageIndex > region.pageIndex);
			if (candidates.length !== 1 || usedBlockIndices.has(candidates[0]._blockIndex)) continue;
			matches.push(candidates[0]);
			usedBlockIndices.add(candidates[0]._blockIndex);
		}
		if (
			matches.length
			&& matches.every((item, index) => (
				index === 0 || matches[index - 1]._blockIndex < item._blockIndex
			))
		) {
			for (const item of matches) {
				item._contentsAnchor = true;
				alignedBlockIndices.add(item._blockIndex);
			}
		}
	}
	return alignedBlockIndices;
}

// Two independently recognized linked headings establish that a navigation
// region follows the body outline. Only exact linked block matches that
// preserve that sequence and reuse an anchored heading style are recovered.
function recoverContentsHeadings(
	allBlocksByPage,
	headingItems,
	usedBlockIndices,
	navigationRegions,
) {
	if (!navigationRegions?.length) return [];
	const navigationPages = new Set(navigationRegions.map(region => region.pageIndex));
	const headingsByPage = groupItemsByPage(headingItems.filter(item => (
		!navigationPages.has(item._pageIndex)
	)));
	const candidatesByPage = new Map();
	for (const pageBlocks of allBlocksByPage.values()) {
		for (const block of pageBlocks) {
			if (
				(block.type !== 'paragraph' && block.type !== 'heading')
				|| usedBlockIndices.has(block._blockIndex)
				|| block._contentsNavigationHeading
				|| navigationPages.has(block._pageIndex)
			) {
				continue;
			}
			if (!candidatesByPage.has(block._pageIndex)) candidatesByPage.set(block._pageIndex, []);
			candidatesByPage.get(block._pageIndex).push(block);
		}
	}

	const recoveredItems = [];
	for (const region of navigationRegions) {
		const rows = (region.rows || []).map((row, rowIndex) => ({
			row,
			rowIndex,
			anchor: findLinkedTitleMatch(row, headingsByPage),
		}));
		const anchors = rows.filter(item => item.anchor);
		const orderedAnchors = region.source === 'destination-link'
			&& anchors.length >= 2 && anchors.every((item, index) => (
			index === 0 || anchors[index - 1].anchor._blockIndex < item.anchor._blockIndex
		));
		const anchorStyles = new Set(anchors.map(item => item.anchor._styleKey).filter(Boolean));
		if (orderedAnchors) for (const rowMatch of rows) {
			if (rowMatch.anchor) continue;
			const candidate = findLinkedTitleMatch(rowMatch.row, candidatesByPage);
			if (!candidate || usedBlockIndices.has(candidate._blockIndex)) continue;
			const destinationRect = candidate._matchedDestination?.rect;
			if (destinationRect && candidate._rect) {
				const candidateDistance = getClosestDistance(candidate._rect, destinationRect);
				const closerHeading = (headingsByPage.get(candidate._pageIndex) || []).some(heading => (
					heading._rect
					&& getClosestDistance(heading._rect, destinationRect) <= candidateDistance
				));
				if (closerHeading) continue;
			}
			const matchingStyle = getBlockStyles(candidate)
				.find(style => anchorStyles.has(style.key));
			if (!matchingStyle) continue;
			const preservesOrder = anchors.every(anchor => (
				anchor.rowIndex < rowMatch.rowIndex
					? anchor.anchor._blockIndex < candidate._blockIndex
					: anchor.anchor._blockIndex > candidate._blockIndex
			));
			if (!preservesOrder) continue;
			const outlineItem = {
				title: candidate.title,
				ref: [candidate._blockIndex],
				_blockIndex: candidate._blockIndex,
				_pageIndex: candidate._pageIndex,
				_rect: candidate._rect,
				_fontName: matchingStyle.fontName || '',
				_fontSize: matchingStyle.fontSize || 0,
				_orderIndex: candidate._blockIndex,
				_recovered: true,
			};
			computeItemStyle(outlineItem);
			recoveredItems.push(outlineItem);
			usedBlockIndices.add(candidate._blockIndex);
		}
	}
	return recoveredItems;
}

function computeStyleStats(items) {
	const stats = new Map();
	const sizes = [];
	for (const item of items) {
		if (!item || !item._styleKey) continue;
		const fontSize = Number.isFinite(item._fontSize) ? item._fontSize : 0;
		sizes.push(fontSize);
		let stat = stats.get(item._styleKey);
		if (!stat) {
			const fontName = normalizeFontName(item._fontName || '');
			stat = {
				key: item._styleKey,
				fontSize: item._sizeBucket,
				fontName,
				upper: item._upper,
				count: 0,
				weight: fontWeightScore(fontName),
				rare: false,
				frequent: false,
				smallFont: false,
				sizeGap: 0,
			};
			stats.set(item._styleKey, stat);
		}
		stat.count += 1;
	}

	const total = items.length || 1;
	const median = getMedian(sizes);
	const styles = Array.from(stats.values());
	styles.sort((a, b) => {
		if (b.fontSize !== a.fontSize) return b.fontSize - a.fontSize;
		if (a.upper !== b.upper) return a.upper ? -1 : 1;
		if (b.weight !== a.weight) return b.weight - a.weight;
		return a.count - b.count;
	});

	for (let i = 0; i < styles.length; i++) {
		const style = styles[i];
		style.rare = style.count <= 1 || style.count / total < 0.02;
		style.frequent = style.count / total > 0.35;
		style.smallFont = median > 0 && style.fontSize < median * 0.7;
		const next = styles[i + 1];
		style.sizeGap = next ? Math.abs(style.fontSize - next.fontSize) : style.fontSize;
	}

	return stats;
}

function getTitleRefIndexes(titleRefs) {
	const refs = Array.isArray(titleRefs?.[0]) ? titleRefs : [titleRefs];
	const indexes = new Set();
	for (const ref of refs) {
		if (Array.isArray(ref) && Number.isInteger(ref[0])) {
			indexes.add(ref[0]);
		}
	}
	return indexes;
}

function isReferenceTopTitle(title) {
	return REFERENCE_TOP_TITLES.includes(normalizeLooseTitle(title));
}

function isReferenceTerminalTitle(title) {
	return REFERENCE_TERMINAL_TITLES.has(normalizeLooseTitle(title)) || isReferenceTopTitle(title);
}

function isAcknowledgmentTopTitle(title) {
	return ACKNOWLEDGMENT_TOP_TITLES.includes(normalizeLooseTitle(title));
}

function isAbstractTerminalTitle(title) {
	return ABSTRACT_TERMINAL_TITLES.includes(normalizeLooseTitle(title));
}

function isKeywordTerminalTitle(title) {
	return KEYWORD_TERMINAL_TITLES.includes(normalizeLooseTitle(title));
}

function isCopyrightTerminalTitle(title) {
	return COPYRIGHT_TERMINAL_TITLES.includes(normalizeLooseTitle(title));
}

function markForceTop(items, titleRefs = []) {
	const titleRefIndexes = getTitleRefIndexes(titleRefs);
	for (const item of items) {
		const isReferenceTitleRef = Array.isArray(item.ref) && titleRefIndexes.has(item.ref[0]);
		if (isReferenceTopTitle(item.title) || isAcknowledgmentTopTitle(item.title) || isReferenceTitleRef) {
			item._forceTop = true;
			item._forceTopTerminal = true;
		}
		else if (isAbstractTerminalTitle(item.title)) {
			item._forceTopTerminal = true;
		}
		else if (isCopyrightTerminalTitle(item.title)) {
			item._forceTopTerminal = true;
		}
	}
}

function markKeywordTitleTerminals(items) {
	for (const item of collectOutlineItems(items)) {
		if (isKeywordTerminalTitle(item?.title)) {
			item._forceTopTerminal = true;
		}
	}
}

function getNodeOrderKey(node) {
	const orderIndex = Number.isFinite(node._orderIndex) ? node._orderIndex : Number.POSITIVE_INFINITY;
	return [orderIndex];
}

function compareOrderKey(a, b) {
	for (let i = 0; i < a.length; i++) {
		if (a[i] < b[i]) return -1;
		if (a[i] > b[i]) return 1;
	}
	return 0;
}

function buildStyleDepthMap(nativeMatchedItems, combinedItems) {
	const nativeMap = new Map();
	const nativeAmbiguous = new Set();
	for (const item of nativeMatchedItems) {
		if (!item._styleKey) continue;
		const depth = Number.isFinite(item._nativeDepth) ? item._nativeDepth + 1 : null;
		if (!Number.isFinite(depth) || depth < 1) continue;
		if (nativeAmbiguous.has(item._styleKey)) continue;

		const existing = nativeMap.get(item._styleKey);
		if (existing == null) {
			nativeMap.set(item._styleKey, depth);
		} else if (existing !== depth) {
			nativeMap.delete(item._styleKey);
			nativeAmbiguous.add(item._styleKey);
		}
	}

	const numericMap = new Map();
	const numericAmbiguous = new Set();
	let prevNumericParts = null;
	for (const item of combinedItems) {
		if (!item._numericParts || !item._numericParts.length) {
			prevNumericParts = null;
			continue;
		}
		if (prevNumericParts && !isNumericChild(prevNumericParts, item._numericParts)) {
			// Sequence break; each heading still maps independently.
		}
		prevNumericParts = item._numericParts;

		const styleKey = item._styleKey;
		if (!styleKey) continue;
		const depth = item._numericParts.length;
		if (numericAmbiguous.has(styleKey)) continue;

		const existing = numericMap.get(styleKey);
		if (existing == null) {
			numericMap.set(styleKey, depth);
		} else if (existing !== depth) {
			numericMap.delete(styleKey);
			numericAmbiguous.add(styleKey);
		}
	}

	const styleDepthMap = new Map();
	for (const [styleKey, depth] of numericMap) {
		styleDepthMap.set(styleKey, { depth, source: 'numeric' });
	}
	for (const [styleKey, depth] of nativeMap) {
		if (styleDepthMap.has(styleKey)) continue;
		if (numericAmbiguous.has(styleKey)) continue;
		styleDepthMap.set(styleKey, { depth, source: 'native' });
	}

	return styleDepthMap;
}

function styleInStack(stack, styleKey) {
	for (let i = 1; i < stack.length; i++) {
		if (stack[i]._styleKey === styleKey) return true;
	}
	return false;
}

function findShallowestStyleDepth(stack, styleKey) {
	for (let i = 1; i < stack.length; i++) {
		if (stack[i]._styleKey === styleKey) return i;
	}
	return null;
}

function buildOutline(items, styleDepthMap, maxDepth) {
	const root = { children: [], _level: 0 };
	const stack = [root];
	let prevItem = null;

	for (const item of items) {
		let depth;

		if (item._forceTop) {
			depth = 1;
		} else if (item._numericParts && item._numericParts.length) {
			depth = item._numericParts.length;
		} else if (item._styleKey && styleDepthMap.has(item._styleKey) && !styleInStack(stack, item._styleKey)) {
			depth = styleDepthMap.get(item._styleKey).depth;
		} else if (prevItem && item._styleKey && prevItem._styleKey && item._styleKey === prevItem._styleKey) {
			depth = prevItem._level || 1;
		} else if (item._styleKey && styleInStack(stack, item._styleKey)) {
			depth = findShallowestStyleDepth(stack, item._styleKey);
		} else {
			depth = stack.length;
		}

		if (!Number.isFinite(depth) || depth < 1) depth = 1;
		depth = clamp(depth, 1, maxDepth);

		while (stack.length > depth) {
			stack.pop();
		}
		if (depth > stack.length) {
			depth = stack.length;
		}

		const parent = stack[stack.length - 1];
		parent.children = parent.children || [];
		parent.children.push(item);
		item._level = depth;
		item.children = item.children || [];
		stack.push(item);
		prevItem = item;
	}

	return root.children;
}

function unwrapUniqueStyleParents(items, styleCounts) {
	const result = [];
	for (const item of items) {
		if (!item || typeof item !== 'object') continue;
		const children = Array.isArray(item.children) ? unwrapUniqueStyleParents(item.children, styleCounts) : [];
		item.children = children;

		const styleKey = item._styleKey;
		const isUnique = styleKey && styleCounts.get(styleKey) === 1;
		if (children.length && isUnique && !item._forceTop && !item._contentsAnchor) {
			result.push(...children);
		} else {
			result.push(item);
		}
	}
	return result;
}

function collectOutlineItems(items, out = []) {
	for (const item of items || []) {
		out.push(item);
		collectOutlineItems(item.children, out);
	}
	return out;
}

function flattenOutlineNodes(items, parent = null, out = []) {
	for (const item of items || []) {
		item._parentItem = parent;
		out.push(item);
		flattenOutlineNodes(item.children, item, out);
	}
	return out;
}

function clearParentLinks(items) {
	for (const item of items || []) {
		delete item._parentItem;
		clearParentLinks(item.children);
	}
}

function isAncestorOf(ancestor, item) {
	let parent = item?._parentItem || null;
	while (parent) {
		if (parent === ancestor) {
			return true;
		}
		parent = parent._parentItem || null;
	}
	return false;
}

function getOutlineOrderIndex(item) {
	if (Array.isArray(item?.ref) && Number.isInteger(item.ref[0])) {
		return item.ref[0];
	}
	return Number.isFinite(item?._orderIndex) ? item._orderIndex : Number.POSITIVE_INFINITY;
}

function removeFromCurrentParent(rootItems, item) {
	const siblings = item._parentItem ? item._parentItem.children : rootItems;
	if (!Array.isArray(siblings)) {
		return;
	}
	const index = siblings.indexOf(item);
	if (index !== -1) {
		siblings.splice(index, 1);
	}
}

function insertByOrder(parent, item) {
	parent.children = Array.isArray(parent.children) ? parent.children : [];
	const orderIndex = getOutlineOrderIndex(item);
	let index = parent.children.findIndex(child => getOutlineOrderIndex(child) > orderIndex);
	if (index === -1) {
		index = parent.children.length;
	}
	parent.children.splice(index, 0, item);
	item._parentItem = parent;
}

function numericPartsStartWith(parts, prefix) {
	return Array.isArray(parts)
		&& Array.isArray(prefix)
		&& prefix.length > 0
		&& parts.length > prefix.length
		&& prefix.every((part, index) => part === parts[index]);
}

function findNumericParent(item, nodes) {
	if (!Array.isArray(item?._numericParts) || item._numericParts.length <= 1) {
		return null;
	}
	const currentParentParts = item._parentItem?._numericParts || [];
	if (currentParentParts.length > 0 && numericPartsStartWith(item._numericParts, currentParentParts)) {
		return null;
	}
	if (item._parentItem && currentParentParts.length === 0) {
		return null;
	}

	const itemOrderIndex = getOutlineOrderIndex(item);
	let best = null;
	for (const candidate of nodes) {
		if (candidate === item || !Array.isArray(candidate?._numericParts)) {
			continue;
		}
		if (!numericPartsStartWith(item._numericParts, candidate._numericParts)) {
			continue;
		}
		if (getOutlineOrderIndex(candidate) > itemOrderIndex) {
			continue;
		}
		if (!best
			|| candidate._numericParts.length > best._numericParts.length
			|| (
				candidate._numericParts.length === best._numericParts.length
				&& getOutlineOrderIndex(candidate) > getOutlineOrderIndex(best)
			)) {
			best = candidate;
		}
	}
	return best;
}

function repairNumericHierarchy(items) {
	if (!Array.isArray(items) || !items.length) {
		return items;
	}
	const nodes = flattenOutlineNodes(items);
	for (const item of nodes.slice().sort((a, b) => getOutlineOrderIndex(a) - getOutlineOrderIndex(b))) {
		const parent = findNumericParent(item, nodes);
		if (!parent || item._parentItem === parent || isAncestorOf(item, parent)) {
			continue;
		}
		removeFromCurrentParent(items, item);
		insertByOrder(parent, item);
	}
	clearParentLinks(items);
	return items;
}

function conflictsWithNumericHierarchy(parent, child) {
	const parentParts = parent?._numericParts || [];
	const childParts = child?._numericParts || [];
	return parentParts.length > 0
		&& childParts.length > 0
		&& !numericPartsStartWith(childParts, parentParts);
}

function buildNativeItemMap(nativeMatches, items) {
	const itemByBlockIndex = new Map();
	for (const item of collectOutlineItems(items)) {
		if (Array.isArray(item.ref) && Number.isInteger(item.ref[0])) {
			itemByBlockIndex.set(item.ref[0], item);
		}
	}

	const nativeItemMap = new Map();
	for (const { native, block } of nativeMatches) {
		const item = itemByBlockIndex.get(block._blockIndex);
		if (item) {
			nativeItemMap.set(native, item);
		}
	}
	return nativeItemMap;
}

function isTerminalTitleItem(item) {
	return !!item?._forceTopTerminal
		|| isReferenceTerminalTitle(item?.title)
		|| isAcknowledgmentTopTitle(item?.title);
}

function repairNativeParentHierarchy(items, nativeMatches) {
	if (!Array.isArray(items) || !items.length || !nativeMatches.length) {
		return items;
	}

	flattenOutlineNodes(items);
	const nativeItemMap = buildNativeItemMap(nativeMatches, items);
	for (const { native } of nativeMatches) {
		const item = nativeItemMap.get(native);
		const parent = nativeItemMap.get(native?._parent);
		if (!item || !parent || item._parentItem === parent || isAncestorOf(item, parent)) {
			continue;
		}
		if (getOutlineOrderIndex(parent) > getOutlineOrderIndex(item)) {
			continue;
		}
		if (isTerminalTitleItem(item)
			|| isTerminalTitleItem(parent)
			|| conflictsWithNumericHierarchy(parent, item)) {
			continue;
		}
		removeFromCurrentParent(items, item);
		insertByOrder(parent, item);
	}
	clearParentLinks(items);
	return items;
}

function getSinglePartExplicitMarker(item) {
	if (!Array.isArray(item?._numericParts) || item._numericParts.length !== 1) {
		return null;
	}
	const match = /^\s*([A-Za-z]+|\d+)([.)])\s+/u.exec(item.title || '');
	if (!match) {
		return null;
	}
	const value = match[1];
	let kind;
	if (/^\d+$/u.test(value)) {
		kind = 'decimal';
	}
	else if (/^[ivx]+$/u.test(value)) {
		kind = 'roman';
	}
	else if (/^[a-z]$/u.test(value)) {
		kind = 'lower-alpha';
	}
	else if (/^[A-Z]$/u.test(value)) {
		kind = 'upper-alpha';
	}
	else {
		return null;
	}
	return { kind, value: value.toLowerCase() };
}

function getMarkerTransitionKey(parentMarker, childMarker) {
	if (!parentMarker || !childMarker || parentMarker.kind === childMarker.kind) {
		return null;
	}
	return `${parentMarker.kind}\0${childMarker.kind}`;
}

function getRepeatedMarkerTransitions(items) {
	const counts = new Map();
	function visit(siblings) {
		let previous = null;
		for (const item of siblings || []) {
			const marker = getSinglePartExplicitMarker(item);
			const previousMarker = getSinglePartExplicitMarker(previous);
			const key = getMarkerTransitionKey(previousMarker, marker);
			if (key) {
				counts.set(key, (counts.get(key) || 0) + 1);
			}
			visit(item.children);
			previous = item;
		}
	}
	visit(items);
	return new Set([...counts].filter(([, count]) => count >= 2).map(([key]) => key));
}

function findLastMarkerKindIndex(stack, kind) {
	for (let i = stack.length - 1; i >= 0; i--) {
		if (stack[i].marker?.kind === kind) {
			return i;
		}
	}
	return -1;
}

function appendMixedMarkerItem(result, stack, repeatedTransitions, item) {
	const marker = getSinglePartExplicitMarker(item);
	if (!marker) {
		result.push(item);
		stack.length = 0;
		return;
	}

	const sameKindIndex = findLastMarkerKindIndex(stack, marker.kind);
	if (sameKindIndex !== -1) {
		const parentEntry = stack[sameKindIndex - 1] || null;
		if (parentEntry) {
			insertByOrder(parentEntry.item, item);
		}
		else {
			result.push(item);
		}
		stack.length = sameKindIndex;
		stack.push({ item, marker });
		return;
	}

	for (let i = stack.length - 1; i >= 0; i--) {
		const key = getMarkerTransitionKey(stack[i].marker, marker);
		if (repeatedTransitions.has(key)) {
			insertByOrder(stack[i].item, item);
			stack.length = i + 1;
			stack.push({ item, marker });
			return;
		}
	}

	result.push(item);
	stack.length = 0;
	stack.push({ item, marker });
}

function repairMixedMarkerHierarchy(items) {
	const repeatedTransitions = getRepeatedMarkerTransitions(items);
	if (!repeatedTransitions.size) {
		return items;
	}
	function repairSiblings(siblings) {
		const result = [];
		const stack = [];
		for (const item of siblings || []) {
			item.children = repairSiblings(item.children);
			appendMixedMarkerItem(result, stack, repeatedTransitions, item);
		}
		return result;
	}
	return repairSiblings(items);
}

function liftTerminalChildren(items) {
	if (!Array.isArray(items) || !items.length) {
		return items;
	}
	const result = [];
	for (const item of items) {
		item.children = liftTerminalChildren(item.children);
		if (isTerminalTitleItem(item) && item.children?.length) {
			const children = item.children;
			item.children = [];
			result.push(item, ...children);
			continue;
		}
		result.push(item);
	}
	return result;
}

function normalizeLevels(items, depth = 1) {
	for (const item of items) {
		item._level = depth;
		if (Array.isArray(item.children) && item.children.length) {
			normalizeLevels(item.children, depth + 1);
		}
	}
}

function filterOutlineItem(item) {
	if (!item || typeof item !== 'object') return null;
	const refArray = Array.isArray(item.ref) ? item.ref : [];
	const children = Array.isArray(item.children)
		? item.children.map(filterOutlineItem).filter(Boolean)
		: [];
	const url = item._url || null;

	if (refArray.length === 0 && !url && children.length === 0) {
		return null;
	}

	const result = { title: item.title };
	if (refArray.length > 0) result.ref = refArray;
	if (url) result.target = { url };
	if (children.length > 0) result.children = children;
	return result;
}

function buildGeneratedOutline(items, titleRef, nativeMatchedItems, nativeMatches) {
	const combined = items.map(item => ({ ...item, children: [] }));
	for (const item of combined) {
		item._orderKey = getNodeOrderKey(item);
	}
	combined.sort((a, b) => compareOrderKey(a._orderKey, b._orderKey));

	const styleStats = computeStyleStats(combined);
	markForceTop(combined, titleRef);
	const styleDepthMap = buildStyleDepthMap(nativeMatchedItems, combined);
	const numDistinctStyles = styleStats.size || 1;
	const maxDepth = Math.min(6, Math.max(1, numDistinctStyles));
	const outline = buildOutline(combined, styleDepthMap, maxDepth);
	const styleCounts = new Map();
	for (const [key, stat] of styleStats) {
		styleCounts.set(key, stat.count);
	}
	const unwrapped = unwrapUniqueStyleParents(outline, styleCounts);
	markKeywordTitleTerminals(unwrapped);
	repairNativeParentHierarchy(unwrapped, nativeMatches);
	repairNumericHierarchy(unwrapped);
	const markerRepaired = repairMixedMarkerHierarchy(unwrapped);
	const terminalLifted = liftTerminalChildren(markerRepaired);
	normalizeLevels(terminalLifted, 1);
	return terminalLifted.map(filterOutlineItem).filter(Boolean);
}

function getRefKey(item) {
	return Array.isArray(item?.ref) ? item.ref.join('.') : null;
}

function cloneOutlineItems(items, index) {
	return (items || []).map(item => {
		const children = cloneOutlineItems(item.children, index);
		const clone = {
			title: item.title,
			...(Array.isArray(item.ref) && { ref: item.ref.slice() }),
			...(item.target && { target: { ...item.target } }),
			...(children.length && { children }),
		};
		const key = getRefKey(clone);
		if (key) index.set(key, clone);
		return clone;
	});
}

function insertOutlineItem(items, item) {
	const blockIndex = item.ref?.[0] ?? Number.POSITIVE_INFINITY;
	const index = items.findIndex(candidate => (
		(candidate.ref?.[0] ?? Number.POSITIVE_INFINITY) > blockIndex
	));
	items.splice(index === -1 ? items.length : index, 0, item);
}

function mergeOutlineAdditions(baseline, enriched, allowedBlockIndices) {
	const index = new Map();
	const result = cloneOutlineItems(baseline, index);
	function visit(items, ancestors = []) {
		for (const item of items || []) {
			const key = getRefKey(item);
			let target = key ? index.get(key) : null;
			if (key && !target && allowedBlockIndices.has(item.ref?.[0])) {
				target = {
					title: item.title,
					ref: item.ref.slice(),
					...(item.target && { target: { ...item.target } }),
				};
				const parent = ancestors
					.slice()
					.reverse()
					.map(ancestor => index.get(ancestor))
					.find(Boolean);
				const siblings = parent
					? (parent.children ||= [])
					: result;
				insertOutlineItem(siblings, target);
				index.set(key, target);
			}
			visit(item.children, key ? [...ancestors, key] : ancestors);
		}
	}
	visit(enriched);
	return result;
}

export async function getOutline(blocks, titleRef, pdfDocument, nativeOutline = null, options = {}) {
	// Phase 1: Build allBlocksByPage
	const allBlocksByPage = buildAllBlocksByPage(blocks);

	// Phase 2: Native outline -> match to blocks
	nativeOutline ||= await getNativeOutline(pdfDocument);
	const nativeNodes = flattenNativeOutline(nativeOutline);
	const nativeMatches = matchNativeToBlocks(nativeNodes, allBlocksByPage);
	const nativeMatchedItems = buildNativeMatchedItems(nativeMatches);

	// Phase 3: Extract heading items
	const headingItems = extractHeadingItems(blocks);
	if (!headingItems.length) return [];

	// Phase 4: Build combined list
	const combined = headingItems.slice();
	const usedBlockIndices = new Set(combined.map(item => item._blockIndex));
	const navigationRegions = options.navigationRegions || [];
	if (
		!nativeMatches.length
		&& navigationRegions.some(region => region.source === 'heading-concentration')
	) {
		return buildPrintedContentsOutline(
			allBlocksByPage,
			navigationRegions,
			options.pageLabels,
		);
	}

	// Phase 4b: Recover inline headings
	const confirmedStyles = new Set(combined.map(item => item._styleKey).filter(Boolean));
	const recoveredItems = recoverInlineHeadings(allBlocksByPage, confirmedStyles, usedBlockIndices);
	combined.push(...recoveredItems);
	if (!navigationRegions.length) {
		return buildGeneratedOutline(combined, titleRef, nativeMatchedItems, nativeMatches);
	}
	const baselineItems = combined.map(item => ({ ...item }));
	const baselineNativeMatchedItems = nativeMatchedItems.filter(item => (
		!blocks[item._blockIndex]?._contentsNavigationHeading
	));
	const baselineNativeMatches = nativeMatches.filter(match => (
		!blocks[match.block._blockIndex]?._contentsNavigationHeading
	));
	const enrichmentBlockIndices = markAlignedContentsHeadings(
		headingItems,
		navigationRegions,
	);
	const contentsRecoveryItems = recoverContentsHeadings(
		allBlocksByPage,
		headingItems,
		usedBlockIndices,
		navigationRegions,
	);
	combined.push(...contentsRecoveryItems);
	for (const item of contentsRecoveryItems) {
		enrichmentBlockIndices.add(item._blockIndex);
	}

	const baseline = buildGeneratedOutline(
		baselineItems,
		titleRef,
		baselineNativeMatchedItems,
		baselineNativeMatches,
	);
	if (!enrichmentBlockIndices.size) return baseline;
	const enriched = buildGeneratedOutline(combined, titleRef, nativeMatchedItems, nativeMatches);
	return mergeOutlineAdditions(baseline, enriched, enrichmentBlockIndices);
}

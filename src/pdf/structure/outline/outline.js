import { getBlockPlainText } from '../zst/index.js';
import { resolveDestination } from '../util.js';

const FORCE_TOP_TITLES = [
	'acknowledgments',
	'acknowledgements',
	'references',
	'bibliography',
];

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

function normalizeTitle(title) {
	if (!title || typeof title !== 'string') return '';
	return title.replace(/[^\x00-\x7F]/g, '').toLowerCase().trim();
}

function buildAllBlocksByPage(blocks) {
	const allBlocksByPage = new Map();
	for (let i = 0; i < blocks.length; i++) {
		const block = blocks[i];
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
		if (block.type !== 'heading') continue;
		const metrics = block._metrics || {};
		const anchorRect = block?.anchor?.pageRects?.[0];
		const rect = metrics.rect || (anchorRect ? anchorRect.slice(1) : null);
		const pageIndex = anchorRect ? anchorRect[0] : (Number.isFinite(metrics.pageIndex) ? metrics.pageIndex : null);
		const item = {
			title: getBlockPlainText(block),
			ref: [i],
			avgFontSize: metrics.fontSize || 0,
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

async function getNativeOutline(pdfDocument) {
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

function flattenNativeOutline(items, depth = 0, parent = null, out = [], orderRef = { value: 0 }) {
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
			avgFontSize: block._fontSize || 0,
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

	const skipTypes = new Set(['note', 'caption', 'table', 'image', 'equation']);
	for (const pageBlocks of allBlocksByPage.values()) {
		for (const block of pageBlocks) {
			if (usedBlockIndices.has(block._blockIndex)) continue;
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
				avgFontSize: firstCharFontSize,
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

function markForceTop(items, titleRef) {
	const titleRefIndex = Array.isArray(titleRef) && titleRef.length ? titleRef[0] : null;
	for (const item of items) {
		const titleNorm = normalizeTitle(item.title);
		if (FORCE_TOP_TITLES.includes(titleNorm)) {
			item._forceTop = true;
			continue;
		}
		if (Number.isInteger(titleRefIndex) && Array.isArray(item.ref) && item.ref[0] === titleRefIndex) {
			item._forceTop = true;
		}
	}
}

function getNodeOrderKey(node) {
	const pageIndex = Number.isFinite(node._pageIndex) ? node._pageIndex : Number.POSITIVE_INFINITY;
	const rect = node._rect;
	let y = 0;
	if (Array.isArray(rect)) {
		if (Number.isFinite(rect[3])) y = rect[3];
		else if (Number.isFinite(rect[1])) y = rect[1];
	}
	const orderIndex = Number.isFinite(node._orderIndex) ? node._orderIndex : 0;
	return [pageIndex, -y, orderIndex];
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
		if (children.length && isUnique && !item._forceTop) {
			result.push(...children);
		} else {
			result.push(item);
		}
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

	if (refArray.length === 0 && children.length === 0) {
		return null;
	}

	const result = {
		title: item.title,
		ref: refArray,
		avgFontSize: item.avgFontSize,
	};
	if (children.length > 0) {
		result.children = children;
	}
	return result;
}

export async function getOutline(blocks, titleRef, pdfDocument) {
	// Phase 1: Build allBlocksByPage
	const allBlocksByPage = buildAllBlocksByPage(blocks);

	// Phase 2: Native outline -> match to blocks
	const nativeOutline = await getNativeOutline(pdfDocument);
	const nativeNodes = flattenNativeOutline(nativeOutline);
	const nativeMatches = matchNativeToBlocks(nativeNodes, allBlocksByPage);
	const nativeMatchedItems = buildNativeMatchedItems(nativeMatches);

	// Phase 3: Extract heading items
	const headingItems = extractHeadingItems(blocks);
	if (!headingItems.length) return [];

	// Phase 4: Build combined list
	const combined = headingItems.slice();
	const usedBlockIndices = new Set(combined.map(item => item._blockIndex));

	// Phase 4b: Recover inline headings
	const confirmedStyles = new Set(combined.map(item => item._styleKey).filter(Boolean));
	const recoveredItems = recoverInlineHeadings(allBlocksByPage, confirmedStyles, usedBlockIndices);
	combined.push(...recoveredItems);

	// Sort by document order
	for (const item of combined) {
		item._orderKey = getNodeOrderKey(item);
	}
	combined.sort((a, b) => compareOrderKey(a._orderKey, b._orderKey));

	// Phase 5: Compute style stats + _forceTop
	const styleStats = computeStyleStats(combined);
	markForceTop(combined, titleRef);

	// Phase 6: Build style-depth map
	const styleDepthMap = buildStyleDepthMap(nativeMatchedItems, combined);
	const numDistinctStyles = styleStats.size || 1;
	const maxDepth = Math.min(6, Math.max(1, numDistinctStyles));

	// Phase 7: Stack-based depth assignment + tree building
	const outline = buildOutline(combined, styleDepthMap, maxDepth);

	// Phase 8: Post-processing
	const styleCounts = new Map();
	for (const [key, stat] of styleStats) {
		styleCounts.set(key, stat.count);
	}
	const unwrapped = unwrapUniqueStyleParents(outline, styleCounts);
	normalizeLevels(unwrapped, 1);
	return unwrapped.map(filterOutlineItem).filter(Boolean);
}

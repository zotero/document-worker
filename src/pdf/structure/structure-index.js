import { getBlockText } from '../../../structured-document-text/src/pdf/index.js';

const DEFAULT_OPTIONS = {
	textCache: 'none',
	pageCacheSize: 4,
	maxCachedTextBytes: 0,
};

export function createStructureIndex(structure, options = {}) {
	return new StructureIndex(structure, options);
}

export function getBlockRefKey(blockRef) {
	return Array.isArray(blockRef) ? blockRef.join(',') : String(blockRef);
}

export function rectsIntersect(a, b) {
	return Array.isArray(a)
		&& Array.isArray(b)
		&& a[0] <= b[2]
		&& b[0] <= a[2]
		&& a[1] <= b[3]
		&& b[1] <= a[3];
}

class StructureIndex {
	constructor(structure, options = {}) {
		this.structure = structure;
		this.options = { ...DEFAULT_OPTIONS, ...options };

		this._blockEntries = [];
		this._blockEntryByKey = new Map();
		this._entriesByTopLevel = new Map();
		this._pageBlockEntries = new Map();
		this._pageTextEntries = new Map();
		this._cachedTextBytes = 0;
		this._stats = {
			blockCount: 0,
			pageBlockEntriesCreated: 0,
			pageTextEntriesCreated: 0,
			pageTextCacheHits: 0,
			pageTextCacheMisses: 0,
			pageTextCacheEvictions: 0,
			blockTextsMaterialized: 0,
			blockTextCharsMaterialized: 0,
			pageTextCacheMaxPages: 0,
			pageTextCacheMaxBytes: 0,
		};

		this._buildBlockEntries();
	}

	blockRefs() {
		return this._blockEntries.map(entry => entry.ref);
	}

	blockEntries() {
		return this._blockEntries;
	}

	getBlock(blockRef) {
		return this.getBlockEntry(blockRef)?.block || null;
	}

	getBlockEntry(blockRef) {
		if (blockRef && typeof blockRef === 'object' && blockRef.key && blockRef.block) {
			return blockRef;
		}
		return this._blockEntryByKey.get(getBlockRefKey(blockRef)) || null;
	}

	withBlockText(blockRef, fn) {
		let ref = Array.isArray(blockRef) ? blockRef : this.getBlockEntry(blockRef)?.ref;
		let bt = getBlockText(this.structure, ref);
		this._recordBlockText(bt);
		return fn(bt);
	}

	withPageEntries(pageIndex, fn) {
		let cached = this._getCachedPageTextEntries(pageIndex);
		if (cached) {
			return fn(cached.entries);
		}

		let pageEntries = this._materializePageTextEntries(pageIndex);
		this._cachePageTextEntries(pageIndex, pageEntries);
		return fn(pageEntries.entries);
	}

	getPageEntriesIntersecting(pageIndex, rect) {
		return this.withPageEntries(pageIndex, entries => entries.filter(entry => rectsIntersect(entry.pageRect, rect)));
	}

	withPageEntriesIntersecting(pageIndex, rect, fn) {
		return this.withPageEntries(pageIndex, entries => fn(entries.filter(entry => rectsIntersect(entry.pageRect, rect))));
	}

	stats() {
		return {
			...this._stats,
			pageTextCachePages: this._pageTextEntries.size,
			pageTextCacheBytes: this._cachedTextBytes,
		};
	}

	clearPageTextCache() {
		this._pageTextEntries.clear();
		this._cachedTextBytes = 0;
	}

	_buildBlockEntries() {
		let visit = (content, baseRef) => {
			if (!Array.isArray(content)) {
				return;
			}
			for (let i = 0; i < content.length; i++) {
				let block = content[i];
				if (!block || block.text) {
					continue;
				}
				let ref = [...baseRef, i];
				let key = getBlockRefKey(ref);
				let entry = {
					ref,
					blockRef: ref,
					key,
					blockRefKey: key,
					block,
					topLevel: ref[0],
				};
				this._blockEntries.push(entry);
				this._blockEntryByKey.set(key, entry);
				if (!this._entriesByTopLevel.has(ref[0])) {
					this._entriesByTopLevel.set(ref[0], []);
				}
				this._entriesByTopLevel.get(ref[0]).push(entry);
				visit(block.content, ref);
			}
		};

		visit(this.structure?.content, []);
		this._stats.blockCount = this._blockEntries.length;
	}

	_getPageBlockEntries(pageIndex) {
		if (this._pageBlockEntries.has(pageIndex)) {
			return this._pageBlockEntries.get(pageIndex);
		}

		let topLevels = [];
		let seenTopLevels = new Set();
		let page = this.structure?.pages?.[pageIndex];
		for (let range of page?.contentRanges || []) {
			if (!range.start?.ref || !range.end?.ref) {
				continue;
			}

			let startTopLevel = range.start.ref[0];
			let endTopLevel = range.end.ref[0];
			if (Number.isInteger(startTopLevel) && !seenTopLevels.has(startTopLevel)) {
				seenTopLevels.add(startTopLevel);
				topLevels.push(startTopLevel);
			}

			for (let i = startTopLevel; i <= endTopLevel; i++) {
				if (!seenTopLevels.has(i)) {
					seenTopLevels.add(i);
					topLevels.push(i);
				}
			}
		}

		let entries = [];
		for (let topLevel of topLevels) {
			let topLevelEntries = this._entriesByTopLevel.get(topLevel);
			if (topLevelEntries) {
				entries.push(...topLevelEntries);
			}
		}

		this._pageBlockEntries.set(pageIndex, entries);
		this._stats.pageBlockEntriesCreated++;
		return entries;
	}

	_materializePageTextEntries(pageIndex) {
		let entries = [];
		let textBytes = 0;

		for (let entry of this._getPageBlockEntries(pageIndex)) {
			let bt = getBlockText(this.structure, entry.ref);
			this._recordBlockText(bt);
			if (!bt.text) {
				continue;
			}

			let pageRect = getPageRectForBlockText(bt, pageIndex);
			entries.push({
				ref: entry.ref,
				blockRef: entry.ref,
				key: entry.key,
				blockRefKey: entry.key,
				block: entry.block,
				bt,
				pageRect,
			});
			textBytes += estimateBlockTextBytes(bt);
		}

		this._stats.pageTextEntriesCreated++;
		return { entries, textBytes };
	}

	_getCachedPageTextEntries(pageIndex) {
		let cached = this._pageTextEntries.get(pageIndex);
		if (!cached) {
			this._stats.pageTextCacheMisses++;
			return null;
		}

		this._pageTextEntries.delete(pageIndex);
		this._pageTextEntries.set(pageIndex, cached);
		this._stats.pageTextCacheHits++;
		return cached;
	}

	_cachePageTextEntries(pageIndex, pageEntries) {
		if (
			this.options.textCache !== 'page-lru'
			|| this.options.pageCacheSize <= 0
			|| this.options.maxCachedTextBytes <= 0
			|| pageEntries.textBytes > this.options.maxCachedTextBytes
		) {
			return;
		}

		this._pageTextEntries.set(pageIndex, pageEntries);
		this._cachedTextBytes += pageEntries.textBytes;
		while (
			this._pageTextEntries.size > this.options.pageCacheSize
			|| this._cachedTextBytes > this.options.maxCachedTextBytes
		) {
			let [oldestPageIndex, oldestEntries] = this._pageTextEntries.entries().next().value;
			this._pageTextEntries.delete(oldestPageIndex);
			this._cachedTextBytes -= oldestEntries.textBytes;
			this._stats.pageTextCacheEvictions++;
		}

		this._stats.pageTextCacheMaxPages = Math.max(this._stats.pageTextCacheMaxPages, this._pageTextEntries.size);
		this._stats.pageTextCacheMaxBytes = Math.max(this._stats.pageTextCacheMaxBytes, this._cachedTextBytes);
	}

	_recordBlockText(bt) {
		this._stats.blockTextsMaterialized++;
		this._stats.blockTextCharsMaterialized += bt?.text?.length || 0;
	}
}

function getPageRectForBlockText(bt, pageIndex) {
	let rect = null;
	for (let i = 0; i < bt.rects.length; i++) {
		if (bt.pageIndexes[i] !== pageIndex) {
			continue;
		}
		let charRect = bt.rects[i];
		if (!Array.isArray(charRect) || charRect.length !== 4) {
			continue;
		}
		if (!rect) {
			rect = charRect.slice();
			continue;
		}
		rect[0] = Math.min(rect[0], charRect[0]);
		rect[1] = Math.min(rect[1], charRect[1]);
		rect[2] = Math.max(rect[2], charRect[2]);
		rect[3] = Math.max(rect[3], charRect[3]);
	}
	return rect;
}

function estimateBlockTextBytes(bt) {
	return (bt?.text?.length || 0) * 2
		+ (bt?.rects?.length || 0) * 40
		+ (bt?.pageIndexes?.length || 0) * 8
		+ (bt?.attrs?.length || 0) * 16;
}

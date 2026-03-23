/**
 * EPUB page mapping: physical page numbers or synthetic EPUB locations.
 *
 * Priority:
 * 1. Page-list entries from TOC (NCX/XHTML nav)
 * 2. In-content page markers (epub:type="pagebreak" or id containing "page")
 * 3. Synthetic EPUB locations (every 1800 chars at block boundaries)
 */

import type { PageListEntry } from './toc';
import type { PageMarker, PageMarkerSource } from './epub-xhtml-to-blocks';
import type { IdInfo } from './epub-xhtml-to-blocks';
import type { ContentBlockNode, PageInfo } from '../../../zotero-structured-text/schema';
import { getContentRange, getNestedBlockPlainText } from '../../../zotero-structured-text/src/text.js';
import { splitHref } from './cross-references';

const EPUB_LOCATION_BREAK_INTERVAL = 1800;

/**
 * Source groups tried for in-content markers, matching the reference
 * implementation's MATCHERS order.  After scoring each group independently
 * the one with the most valid matches wins (same as the reference sort).
 */
const MARKER_SOURCE_ORDER: PageMarkerSource[] = ['id-empty', 'id', 'type', 'role'];

interface RawPageMapping {
	label: string;
	blockIndex: number;
}

export interface PageMappingResult {
	pages: PageInfo[];
	isPhysical: boolean;
}

/**
 * Build page mappings for an EPUB document.
 *
 * Priority:
 * 1. Page-list entries from the TOC document (NCX/XHTML nav).
 * 2. In-content markers — each source group (id-empty, id, type, role) is
 *    scored independently; the valid group with the most matches is selected,
 *    mirroring the reference implementation's matcher selection.
 * 3. Synthetic EPUB locations (every 1800 chars at block boundaries).
 */
export function buildPageMappings(
	content: ContentBlockNode[],
	pageListEntries: PageListEntry[],
	markersBySection: PageMarker[][],
	sectionOffsets: number[],
	hrefToSpineIndex: Map<string, number>,
	globalIdMap: Map<string, IdInfo>,
): PageMappingResult {
	// 1. Try page-list entries first
	let pageListMappings = resolvePageListEntries(
		pageListEntries, hrefToSpineIndex, globalIdMap, sectionOffsets
	);
	if (pageListMappings.length > 0 && scoreMappings(pageListMappings, sectionOffsets) > 0) {
		return {
			pages: buildPagesArray(pageListMappings, content),
			isPhysical: true,
		};
	}

	// 2. Try in-content markers — score each source group independently,
	//    pick the valid one with the most matches.
	let bestMarkerMappings = selectBestMarkerGroup(markersBySection, sectionOffsets);
	if (bestMarkerMappings) {
		return {
			pages: buildPagesArray(bestMarkerMappings, content),
			isPhysical: true,
		};
	}

	// 3. Fall back to EPUB locations
	let locationMappings = generateEpubLocations(content);
	return {
		pages: buildPagesArray(locationMappings, content),
		isPhysical: false,
	};
}

/**
 * Group markers by source, resolve each group to global block indices,
 * score each independently, and return the valid group with the most matches.
 */
function selectBestMarkerGroup(
	markersBySection: PageMarker[][],
	sectionOffsets: number[],
): RawPageMapping[] | null {
	// Partition markers by source
	let bySource = new Map<PageMarkerSource, PageMarker[][]>();
	for (let source of MARKER_SOURCE_ORDER) {
		bySource.set(source, markersBySection.map(() => []));
	}
	for (let i = 0; i < markersBySection.length; i++) {
		for (let marker of markersBySection[i] || []) {
			bySource.get(marker.source)![i].push(marker);
		}
	}

	// Score each source group and collect valid ones
	let candidates: { mappings: RawPageMapping[]; count: number }[] = [];
	for (let source of MARKER_SOURCE_ORDER) {
		let sectionMarkers = bySource.get(source)!;
		let mappings = resolveMarkers(sectionMarkers, sectionOffsets);
		if (mappings.length > 0) {
			let score = scoreMappings(mappings, sectionOffsets);
			if (score > 0) {
				candidates.push({ mappings, count: mappings.length });
			}
		}
	}

	if (candidates.length === 0) return null;

	// Pick the group with the most matches (same as reference's sort)
	candidates.sort((a, b) => b.count - a.count);
	return candidates[0].mappings;
}

function resolvePageListEntries(
	entries: PageListEntry[],
	hrefToSpineIndex: Map<string, number>,
	globalIdMap: Map<string, IdInfo>,
	sectionOffsets: number[],
): RawPageMapping[] {
	let mappings: RawPageMapping[] = [];

	for (let entry of entries) {
		let [filePart, fragment] = splitHref(entry.href);

		let blockIndex: number | undefined;

		if (fragment) {
			let idInfo = globalIdMap.get(fragment);
			if (!idInfo) {
				try {
					idInfo = globalIdMap.get(decodeURIComponent(fragment));
				}
				catch {
					// ignore
				}
			}
			if (idInfo) {
				blockIndex = sectionOffsets[idInfo.spineIndex] + idInfo.blockIndex;
			}
		}

		if (blockIndex === undefined && filePart) {
			let spineIndex = resolveSpineIndex(filePart, hrefToSpineIndex);
			if (spineIndex !== undefined) {
				blockIndex = sectionOffsets[spineIndex];
			}
		}

		if (blockIndex !== undefined) {
			mappings.push({ label: entry.label, blockIndex });
		}
	}

	return mappings;
}

function resolveSpineIndex(filePart: string, hrefToSpineIndex: Map<string, number>): number | undefined {
	let spineIndex = hrefToSpineIndex.get(filePart);
	if (spineIndex !== undefined) return spineIndex;

	try {
		spineIndex = hrefToSpineIndex.get(decodeURIComponent(filePart));
		if (spineIndex !== undefined) return spineIndex;
	}
	catch {
		// ignore
	}

	for (let [key, idx] of hrefToSpineIndex) {
		if (key.endsWith('/' + filePart) || key === filePart) {
			return idx;
		}
	}

	return undefined;
}

function resolveMarkers(
	markersBySection: PageMarker[][],
	sectionOffsets: number[],
): RawPageMapping[] {
	let mappings: RawPageMapping[] = [];

	for (let i = 0; i < markersBySection.length; i++) {
		let markers = markersBySection[i];
		if (!markers) continue;
		let offset = sectionOffsets[i];
		for (let marker of markers) {
			mappings.push({
				label: marker.label,
				blockIndex: offset + marker.blockIndex,
			});
		}
	}

	return mappings;
}

/**
 * Score a set of page mappings using heuristics from the reference
 * implementation. Returns 0 if the mappings are invalid, otherwise a
 * positive score proportional to the number of matches.
 */
function scoreMappings(mappings: RawPageMapping[], sectionOffsets: number[]): number {
	if (mappings.length === 0) return 0;

	let score = mappings.length;

	// Check section coverage: at least half of sections should have a mapping
	let sectionsWithMappings = new Set<number>();
	for (let mapping of mappings) {
		for (let i = sectionOffsets.length - 1; i >= 0; i--) {
			if (mapping.blockIndex >= sectionOffsets[i]) {
				sectionsWithMappings.add(i);
				break;
			}
		}
	}
	if (sectionsWithMappings.size < sectionOffsets.length / 2) {
		return 0;
	}

	// Check for decreasing page numbers
	let previous: number | null = null;
	for (let mapping of mappings) {
		let num = parseInt(mapping.label);
		if (!Number.isNaN(num)) {
			if (previous !== null) {
				if (num < previous) {
					score /= 4;
					break;
				}
				if (num > previous + 3) {
					score /= 2;
					break;
				}
			}
			previous = num;
		}
	}

	// Check for duplicates
	let seen = new Set<string>();
	for (let mapping of mappings) {
		if (seen.has(mapping.label)) {
			if (/^\D{2,}$/.test(mapping.label)) {
				return 0;
			}
			score /= 2;
			break;
		}
		seen.add(mapping.label);
	}

	return score;
}

/**
 * Generate synthetic EPUB locations every 1800 characters at block boundaries.
 */
function generateEpubLocations(content: ContentBlockNode[]): RawPageMapping[] {
	let mappings: RawPageMapping[] = [];
	let charsSinceBreak = 0;
	let locationNumber = 0;

	for (let i = 0; i < content.length; i++) {
		let blockChars = getNestedBlockPlainText(content[i]).length;
		if (blockChars === 0) continue;

		if (charsSinceBreak === 0 || charsSinceBreak >= EPUB_LOCATION_BREAK_INTERVAL) {
			locationNumber++;
			mappings.push({
				label: locationNumber.toString(),
				blockIndex: i,
			});
			charsSinceBreak = 0;
		}

		charsSinceBreak += blockChars;
	}

	return mappings;
}

/**
 * Build a pages array from raw mappings.
 * Each page spans from its block index to the block before the next mapping.
 */
function buildPagesArray(mappings: RawPageMapping[], content: ContentBlockNode[]): PageInfo[] {
	if (mappings.length === 0 || content.length === 0) return [];

	let pages: PageInfo[] = [];

	for (let i = 0; i < mappings.length; i++) {
		let startBlock = i === 0 ? 0 : mappings[i].blockIndex;
		let endBlock = i < mappings.length - 1
			? mappings[i + 1].blockIndex - 1
			: content.length - 1;

		if (startBlock > endBlock) {
			// Mapping points past the end or two mappings at the same block
			startBlock = endBlock;
		}

		let page: PageInfo = {
			label: mappings[i].label,
			contentRanges: [],
		};

		if (startBlock <= endBlock && startBlock < content.length) {
			let contentRange = getContentRange(
				content,
				startBlock,
				Math.min(endBlock, content.length - 1),
			);
			page.contentRanges = [contentRange];
		}

		pages.push(page);
	}

	return pages;
}

/**
 * Find which page a given global block index falls on.
 */
export function findPageForBlock(pages: PageInfo[], content: ContentBlockNode[], globalBlockIdx: number): number {
	// Binary search: find the last page whose content starts at or before globalBlockIdx
	// We use the contentRanges to determine page boundaries
	for (let i = pages.length - 1; i >= 0; i--) {
		let ranges = pages[i].contentRanges;
		if (ranges && ranges.length > 0) {
			let startRef = ranges[0].start.ref[0];
			if (startRef <= globalBlockIdx) {
				return i;
			}
		}
	}
	return 0;
}

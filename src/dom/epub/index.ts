import { readZipEntries } from './zip';
import { parseXML } from './xml';
import { parseContainer, parseOPF } from './opf';
import { parseTOC, parsePageList, type TocItem, type PageListEntry } from './toc';
import { convertSection } from './epub-xhtml-to-blocks';
import type { IdInfo, LinkRecord, PageMarker } from './epub-xhtml-to-blocks';
import { buildPageMappings, findPageForBlock } from './page-mapping';
import { resolveLinks, computeSectionOffsets, splitHref } from './cross-references';
import { getFulltextFromStructuredText } from '../../../zotero-structured-text/src/fulltext.js';
import { getNestedBlockPlainText } from '../../../zotero-structured-text/src/pdf/text-node.js';
import type { ZoteroStructuredText, OutlineItem, PageInfo, ContentBlockNode } from '../../../zotero-structured-text/schema';

const SCHEMA_VERSION = '1.0.0-draft';
const PROCESSOR_VERSION = '1.0.0-draft';

const XHTML_MEDIA_TYPES = new Set([
	'application/xhtml+xml',
	'text/html',
	'application/html',
]);

interface FulltextOptions {
	structure?: ZoteroStructuredText;
}

/**
 * Extract structured text from an EPUB file.
 */
export function getEpubStructure(arrayBuffer: ArrayBuffer): ZoteroStructuredText {
	let entries = readZipEntries(arrayBuffer);
	let decoder = new TextDecoder('utf-8');

	// 1. Parse container.xml to find OPF
	let containerXml = readEntry(entries, 'META-INF/container.xml', decoder);
	let opfPath = parseContainer(containerXml);

	// 2. Parse OPF
	let opfXml = readEntry(entries, opfPath, decoder);
	let { metadata, manifest, spine, spineStep, tocPath, tocFormat } = parseOPF(opfXml, opfPath);

	// 3. Build href → spine index map
	let hrefToSpineIndex = new Map<string, number>();
	for (let i = 0; i < spine.length; i++) {
		let item = manifest.get(spine[i].idref);
		if (item) {
			hrefToSpineIndex.set(item.href, i);
			let filename = item.href.split('/').pop();
			if (filename) hrefToSpineIndex.set(filename, i);
		}
	}

	// 4. Build structure object
	let structure: any = {
		schemaVersion: SCHEMA_VERSION,
		processor: {
			type: 'epub',
			version: PROCESSOR_VERSION,
		},
		dateCreated: new Date().toISOString(),
		sourceContentType: 'application/epub+zip',
		sourceHash: '',
		metadata,
		pages: [],
		content: [],
	};

	// 5. Parse TOC and page-list (outline built later after content is assembled)
	let tocItems: TocItem[] = [];
	let pageListEntries: PageListEntry[] = [];
	if (tocPath && tocFormat) {
		let tocXml = readEntrySafe(entries, tocPath, decoder);
		if (tocXml) {
			tocItems = parseTOC(tocXml, tocFormat);
			pageListEntries = parsePageList(tocXml, tocFormat);
		}
	}

	// 6. Process each spine item
	let blocksBySection: ContentBlockNode[][] = [];
	let markersBySection: PageMarker[][] = [];
	let allLinks: LinkRecord[] = [];
	let globalIdMap = new Map<string, IdInfo>();

	for (let i = 0; i < spine.length; i++) {
		let { idref } = spine[i];
		let manifestItem = manifest.get(idref);
		if (!manifestItem) {
			blocksBySection.push([]);
			markersBySection.push([]);
			continue;
		}

		if (manifestItem.mediaType && !XHTML_MEDIA_TYPES.has(manifestItem.mediaType)) {
			blocksBySection.push([]);
			markersBySection.push([]);
			continue;
		}

		let xhtml = readEntrySafe(entries, manifestItem.href, decoder);
		if (!xhtml) {
			blocksBySection.push([]);
			markersBySection.push([]);
			continue;
		}

		let doc = parseXML(xhtml);
		let { blocks, idMap, links, pageMarkers } = convertSection(doc, spineStep, i, idref);

		blocksBySection.push(blocks);
		markersBySection.push(pageMarkers);
		for (let j = 0; j < links.length; j++) {
			allLinks.push(links[j]);
		}

		for (let [id, info] of idMap) {
			globalIdMap.set(id, info);
		}
	}

	// 7. Compute section offsets (shared by cross-references and outline)
	let sectionOffsets = computeSectionOffsets(blocksBySection);

	// 8. Resolve cross-references
	resolveLinks(allLinks, globalIdMap, blocksBySection, hrefToSpineIndex, sectionOffsets);

	// 9. Assemble content
	for (let i = 0; i < spine.length; i++) {
		let blocks = blocksBySection[i] || [];
		for (let block of blocks) {
			structure.content.push(block);
		}
	}

	// 10. Build page mappings
	let { pages, isPhysical } = buildPageMappings(
		structure.content,
		pageListEntries,
		markersBySection,
		sectionOffsets,
		hrefToSpineIndex,
		globalIdMap,
	);
	structure.pages = pages;
	structure.pageMappingType = isPhysical ? 'physical' : 'locations';

	// 11. Build outline with block-level refs
	if (tocItems.length > 0) {
		structure.outline = buildOutline(tocItems, hrefToSpineIndex, globalIdMap, sectionOffsets, structure.pages, structure.content);
	}

	// 12. Compute character count
	let charCount = 0;
	for (let block of structure.content) {
		charCount += getNestedBlockPlainText(block).length;
	}
	if (charCount > 0) {
		structure.characterCount = charCount;
	}

	// 13. Compute file size
	structure.fileSize = arrayBuffer.byteLength;

	return structure as ZoteroStructuredText;
}

/**
 * Extract fulltext from an EPUB file.
 */
export function getEpubFulltext(
	arrayBuffer: ArrayBuffer,
	options: FulltextOptions = {},
): { text: string; totalSections: number } {
	let structure = options.structure || getEpubStructure(arrayBuffer);
	let pages = structure.pages!;
	let pageIndexes = Array.from({ length: pages.length }, (_, i) => i);
	let text = getFulltextFromStructuredText(structure, pageIndexes);

	return {
		text,
		totalSections: pages.length,
	};
}

// Helpers:

function readEntry(entries: Map<string, Uint8Array>, path: string, decoder: TextDecoder): string {
	let data = findEntry(entries, path);
	if (!data) {
		throw new Error(`Missing EPUB entry: ${path}`);
	}
	return decoder.decode(data);
}

function readEntrySafe(entries: Map<string, Uint8Array>, path: string, decoder: TextDecoder): string | null {
	let data = findEntry(entries, path);
	if (!data) return null;
	return decoder.decode(data);
}

function findEntry(entries: Map<string, Uint8Array>, path: string): Uint8Array | undefined {
	let data = entries.get(path);
	if (data) return data;

	try {
		let decoded = decodeURIComponent(path);
		if (decoded !== path) {
			data = entries.get(decoded);
			if (data) return data;
		}
	}
	catch {
		// malformed percent encoding
	}

	let lowerPath = path.toLowerCase();
	for (let [key, value] of entries) {
		if (key.toLowerCase() === lowerPath) {
			return value;
		}
	}

	return undefined;
}

function buildOutline(
	tocItems: TocItem[],
	hrefToSpineIndex: Map<string, number>,
	globalIdMap: Map<string, IdInfo>,
	sectionOffsets: number[],
	pages: PageInfo[],
	content: ContentBlockNode[],
): OutlineItem[] {
	return tocItems
		.map(item => convertOutlineItem(item, hrefToSpineIndex, globalIdMap, sectionOffsets, pages, content))
		.filter((x): x is OutlineItem => x !== null);
}

function convertOutlineItem(
	item: TocItem,
	hrefToSpineIndex: Map<string, number>,
	globalIdMap: Map<string, IdInfo>,
	sectionOffsets: number[],
	pages: PageInfo[],
	content: ContentBlockNode[],
): OutlineItem | null {
	let outlineItem: OutlineItem = { title: item.title };

	if (item.href) {
		let [filePart, fragment] = splitHref(item.href);

		let spineIndex = resolveSpineIndex(filePart, hrefToSpineIndex);
		if (spineIndex !== undefined) {
			let globalIdx: number | undefined;

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
					globalIdx = sectionOffsets[idInfo.spineIndex] + idInfo.blockIndex;
				}
			}
			else {
				globalIdx = sectionOffsets[spineIndex];
			}

			if (globalIdx !== undefined) {
				outlineItem.ref = [globalIdx];
				let pageIndex = findPageForBlock(pages, content, globalIdx);
				outlineItem.target = { position: { pageIndex } };
			}
		}
	}

	if (item.children && item.children.length > 0) {
		outlineItem.children = item.children
			.map(child => convertOutlineItem(child, hrefToSpineIndex, globalIdMap, sectionOffsets, pages, content))
			.filter((x): x is OutlineItem => x !== null);
	}

	return outlineItem;
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


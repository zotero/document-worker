import { readZipEntries } from './zip';
import { parseXML } from './xml';
import { parseContainer, parseOPF } from './opf';
import { parseTOC, parsePageList, type TocItem, type PageListEntry } from './toc';
import { convertSection } from './epub-xhtml-to-blocks';
import type { IdInfo, LinkRecord, PageMarker } from './epub-xhtml-to-blocks';
import { buildPageMappings, findPageForBlock } from './page-mapping';
import { resolveLinks, computeSectionOffsets, splitHref } from './cross-references';
import { getFulltextFromStructuredText } from '../../../structured-document-text/src/fulltext.js';
import { getNestedBlockPlainText, mergeNodesWithSelectorMap } from '../../../structured-document-text/src/text.js';
import type { StructuredDocumentText, OutlineItem, PageInfo, ContentBlockNode } from '../../../structured-document-text/schema';
import {
	DOCUMENT_WORKER_PROCESSOR_VERSION,
	SDT_SCHEMA_VERSION,
} from '../../versions.js';

const XHTML_MEDIA_TYPES = new Set([
	'application/xhtml+xml',
	'text/html',
	'application/html',
]);

interface FulltextOptions {
	structure?: StructuredDocumentText;
}

interface StructureOptions {
	sourceHash: string;
}

type InternalStructuredDocumentText = Omit<StructuredDocumentText, 'metadata'> & {
	metadata: Omit<StructuredDocumentText['metadata'], 'source'> & {
		source: Omit<StructuredDocumentText['metadata']['source'], 'hash'> & {
			hash?: string;
		};
	};
};

/**
 * Extract structured text from an EPUB file.
 */
export function getEpubStructure(arrayBuffer: ArrayBuffer, options: StructureOptions): StructuredDocumentText {
	return buildEpubStructure(arrayBuffer, options.sourceHash);
}

function buildEpubStructure(arrayBuffer: ArrayBuffer, sourceHash: string): StructuredDocumentText;
function buildEpubStructure(arrayBuffer: ArrayBuffer): InternalStructuredDocumentText;
function buildEpubStructure(arrayBuffer: ArrayBuffer, sourceHash?: string): InternalStructuredDocumentText {
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
	let structure: InternalStructuredDocumentText = {
		schemaVersion: SDT_SCHEMA_VERSION,
		metadata: {
			processor: {
				type: 'epub',
				version: DOCUMENT_WORKER_PROCESSOR_VERSION,
			},
			dateCreated: new Date().toISOString(),
			source: {
				contentType: 'application/epub+zip',
				...(typeof sourceHash === 'string' ? { hash: sourceHash } : {}),
				properties: metadata,
			},
		},
		catalog: {
			pages: [],
			outline: [],
		},
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
		let { blocks, idMap, links, pageMarkers } = convertSection(doc, spineStep, i);

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

	// 9. Assemble content and merge adjacent text nodes with same style/refs
	for (let i = 0; i < spine.length; i++) {
		let blocks = blocksBySection[i] || [];
		for (let block of blocks) {
			structure.content.push(block);
		}
	}
	for (let block of structure.content) {
		if (Array.isArray(block.content)) {
			mergeNodesWithSelectorMap(block.content);
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
	structure.catalog.pages = pages;
	structure.catalog.pageMappingType = isPhysical ? 'physical' : 'locations';

	// 11. Build outline with block-level refs
	if (tocItems.length > 0) {
		structure.catalog.outline = buildOutline(tocItems, hrefToSpineIndex, globalIdMap, sectionOffsets, structure.catalog.pages, structure.content);
	}

	// 12. Compute character count
	let charCount = 0;
	for (let block of structure.content) {
		charCount += getNestedBlockPlainText(block).length;
	}
	if (charCount > 0) {
		structure.metadata.characterCount = charCount;
	}

	// 13. Compute file size
	structure.metadata.source.fileSize = arrayBuffer.byteLength;

	return structure;
}

/**
 * Extract fulltext from an EPUB file.
 */
export function getEpubFulltext(
	arrayBuffer: ArrayBuffer,
	options: FulltextOptions = {},
): { text: string; totalSections: number } {
	let structure = options.structure
		? options.structure
		: buildEpubStructure(arrayBuffer);
	let pages = structure.catalog.pages;
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

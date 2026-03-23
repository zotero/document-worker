import type { Document, Element } from 'domhandler';
import {
	EPUB_NS,
	queryTag,
	getLocalName,
	getAttribute,
	getAttributeNS,
	getElementChildren,
} from './xml';
import { generateCFIBase, buildBlockCFI, buildTextNodeCFI } from './cfi';
import { convertBody } from '../html-to-blocks';
import type { ConvertHooks, Block } from '../html-to-blocks';
import type { ContentBlockNode, TextNode } from '../../../zotero-structured-text/schema';

const NOTE_EPUB_TYPES = new Set(['footnote', 'rearnote', 'note', 'endnote']);

// Types:

export interface LinkRecord {
	href: string;
	sourceSpineIndex: number;
	sourceBlockIndex: number;
	epubType: string;
	role: string;
	hasSup: boolean;
	elementId: string | null;
	textNodes: TextNode[];
}

export interface IdInfo {
	spineIndex: number;
	blockIndex: number;
}

/**
 * Source of the page marker, matching the reference implementation's matcher
 * priority. Each element can contribute to multiple sources — the best scoring
 * source is selected later in buildPageMappings.
 */
export type PageMarkerSource = 'id-empty' | 'id' | 'type' | 'role';

export interface PageMarker {
	label: string;
	blockIndex: number;
	source: PageMarkerSource;
}

export interface ConvertResult {
	blocks: ContentBlockNode[];
	idMap: Map<string, IdInfo>;
	links: LinkRecord[];
	pageMarkers: PageMarker[];
}

// Entry point:

/**
 * Convert an XHTML document (htmlparser2 tree) into structured text blocks.
 */
export function convertSection(doc: Document, spineStep: number, spineIndex: number, idref: string): ConvertResult {
	let body = queryTag(doc, 'body');
	if (!body) {
		return { blocks: [], idMap: new Map(), links: [], pageMarkers: [] };
	}

	let cfiBase = generateCFIBase(spineStep, spineIndex, idref);
	let idMap = new Map<string, IdInfo>();
	let links: LinkRecord[] = [];
	let pageMarkers: PageMarker[] = [];
	let blocks: Block[] = [];
	// onElement can fire multiple times for the same element (processNode + makeBlock),
	// which is fine for idMap (overwrites same key) but would duplicate page markers.
	let markerSeen = new Set<Element>();

	let hooks: ConvertHooks = {
		blockAnchor(node) {
			return {
				type: 'FragmentSelector',
				conformsTo: 'http://www.idpf.org/epub/linking/cfi/epub-cfi.html',
				value: buildBlockCFI(cfiBase, node),
			};
		},
		textAnchor(node) {
			if (node && node.parent) {
				return {
					type: 'FragmentSelector',
					conformsTo: 'http://www.idpf.org/epub/linking/cfi/epub-cfi.html',
					value: buildTextNodeCFI(cfiBase, node),
				};
			}
			return undefined;
		},
		onElement(el: Element) {
			if (el.attribs?.id) {
				idMap.set(el.attribs.id, {
					spineIndex,
					blockIndex: blocks.length,
				});
			}
			if (!markerSeen.has(el)) {
				markerSeen.add(el);
				detectPageMarker(el, blocks.length, pageMarkers);
			}
		},
		onInternalLink(el: Element, href: string, textNodes: TextNode[]) {
			let epubType = getAttributeNS(el, EPUB_NS, 'type') || '';
			let role = getAttribute(el, 'role') || '';
			let hasSup = hasAncestorOrChild(el, 'sup');
			links.push({
				href,
				sourceSpineIndex: spineIndex,
				sourceBlockIndex: blocks.length,
				epubType,
				role,
				hasSup,
				elementId: getAttribute(el, 'id'),
				textNodes,
			});
		},
		isNote(el: Element) {
			let epubType = getAttributeNS(el, EPUB_NS, 'type') || '';
			if (!epubType) return false;
			return epubType.split(/\s+/).some(t => NOTE_EPUB_TYPES.has(t));
		},
	};

	convertBody(body, hooks, blocks);

	return { blocks: blocks as ContentBlockNode[], idMap, links, pageMarkers };
}

// Utilities:

/**
 * Detect page markers from an element. Each element can match multiple sources
 * — the best scoring source group is selected later in buildPageMappings.
 * Mirrors the reference implementation's three CSS-selector matchers plus
 * role="doc-pagebreak".
 */
function detectPageMarker(el: Element, blockIndex: number, pageMarkers: PageMarker[]): void {
	let isEmpty = !el.children || el.children.length === 0;

	// Matcher 1 & 2 (reference): [id*="page" i]:not(#pagetop):not(#pagebottom)
	// Matcher 1 adds :empty for higher confidence.
	let id = el.attribs?.id;
	if (id && /page/i.test(id) && !/^pagetop$/i.test(id) && !/^pagebottom$/i.test(id)) {
		let label = id.replace(/page[-_]?/i, '').replace(/^(.*_)+/, '');
		if (label) {
			if (isEmpty) {
				pageMarkers.push({ label, blockIndex, source: 'id-empty' });
			}
			pageMarkers.push({ label, blockIndex, source: 'id' });
		}
	}

	// Matcher 3 (reference): [*|type="pagebreak"] with title
	let epubType = getAttributeNS(el, EPUB_NS, 'type') || '';
	if (epubType.split(/\s+/).includes('pagebreak')) {
		let label = getAttribute(el, 'title') || '';
		if (label) {
			pageMarkers.push({ label, blockIndex, source: 'type' });
		}
	}

	// Extra: DPUB-ARIA role="doc-pagebreak" with aria-label or title
	let role = getAttribute(el, 'role') || '';
	if (role === 'doc-pagebreak') {
		let label = getAttribute(el, 'aria-label')
			|| getAttribute(el, 'title')
			|| '';
		if (label) {
			pageMarkers.push({ label, blockIndex, source: 'role' });
		}
	}
}

function hasAncestorOrChild(node: Element, tagName: string): boolean {
	let parent = node.parent;
	for (let i = 0; i < 3 && parent; i++) {
		if (getLocalName(parent as any) === tagName) return true;
		parent = (parent as any).parent;
	}
	let children = getElementChildren(node);
	for (let child of children) {
		if (getLocalName(child) === tagName) return true;
	}
	return false;
}

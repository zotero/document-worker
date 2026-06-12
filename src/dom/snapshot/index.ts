import type { Document, Element, ChildNode } from 'domhandler';
import {
	parseXML,
	queryTag,
	getLocalName,
	getElementChildren,
	getTextContent,
	isElement,
	getAttribute,
} from '../epub/xml';
import { convertBody } from '../html-to-blocks';
import type { ConvertHooks } from '../html-to-blocks';
import type { ContentBlockNode } from '../../../structured-document-text/schema';
import { getFulltextFromStructuredText } from '../../../structured-document-text/src/fulltext.js';
import { getNestedBlockPlainText, getBlockPlainText } from '../../../structured-document-text/src/text.js';
import type { StructuredDocumentText, OutlineItem } from '../../../structured-document-text/schema';
import { cssEscape } from "./cssEscape";
import { buildDomIndex, buildDomMap } from './dom-index';
import { filterForReadability, isInKeptSetIncludingAncestors } from './readability';
import {
	SDT_PROCESSOR_VERSIONS,
	SDT_SCHEMA_VERSION,
} from '../../versions.js';

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

// Entry points:

export function getSnapshotStructure(
	buf: ArrayBuffer,
	contentType: string,
	options: StructureOptions,
): StructuredDocumentText {
	return buildSnapshotStructure(buf, contentType, options.sourceHash);
}

function buildSnapshotStructure(
	buf: ArrayBuffer,
	contentType: string,
	sourceHash: string,
): StructuredDocumentText;
function buildSnapshotStructure(
	buf: ArrayBuffer,
	contentType: string,
): InternalStructuredDocumentText;
function buildSnapshotStructure(
	buf: ArrayBuffer,
	contentType: string,
	sourceHash?: string,
): InternalStructuredDocumentText {
	let sourceContentType = ensureValidContentType(contentType);

	let decoder = new TextDecoder('utf-8');
	let html = decoder.decode(new Uint8Array(buf));
	let doc = parseXML(html, { xmlMode: false });

	let body = queryTag(doc, 'body');
	if (!body) {
		return emptyStructure(sourceContentType, buf.byteLength, sourceHash);
	}

	let kept: Set<Element> | null;
	try {
		kept = filterForReadability(body);
	}
	catch (e) {
		console.warn('Readability filter threw; proceeding without filtering:', e);
		kept = null;
	}

	let domIndex = buildDomIndex(body);
	let anchored = new Set<Element>();

	let hooks: ConvertHooks = {
		blockAnchor(node) {
			if (!('attribs' in node)) return undefined;
			let el = node as Element;
			anchored.add(el);
			let value = getUniqueSelector(el, body);
			if (!value) return undefined;
			return { selectorMap: value };
		},
		textAnchor(node) {
			let offset = domIndex.textOffsets.get(node);
			if (offset === undefined) return undefined;
			let el = node.parent;
			if (el && isElement(el)) {
				anchored.add(el);
			}
			return { stream: offset };
		},
	};
	if (kept) {
		let keptSet = kept;
		hooks.shouldInclude = (el: Element) => isInKeptSetIncludingAncestors(el, body, keptSet);
	}
	let { blocks } = convertBody(body, hooks);

	let domMap = buildDomMap(domIndex, anchored);

	// Build outline from headings
	let outline = buildOutlineFromHeadings(body, blocks, kept);

	// Character count
	let charCount = 0;
	for (let block of blocks) {
		charCount += getNestedBlockPlainText(block).length;
	}

	return {
		schemaVersion: SDT_SCHEMA_VERSION,
		metadata: {
			processor: { type: 'snapshot' as const, version: SDT_PROCESSOR_VERSIONS.snapshot },
			dateCreated: new Date().toISOString(),
			source: {
				contentType: sourceContentType,
				...(typeof sourceHash === 'string' ? { hash: sourceHash } : {}),
				properties: extractMetadata(doc),
				fileSize: buf.byteLength,
			},
			...(charCount > 0 ? { characterCount: charCount } : {}),
		},
		catalog: {
			pages: [{ contentRange: [[0], [blocks.length]] }],
			outline,
			...(domMap.length > 0 ? { domMap } : {}),
		},
		content: blocks,
	};
}

export function getSnapshotFulltext(
	buf: ArrayBuffer,
	contentType: string,
	options: FulltextOptions = {},
): { text: string; totalPages: number } {
	let structure = options.structure
		? options.structure
		: buildSnapshotStructure(buf, contentType);
	let text = getFulltextFromStructuredText(structure, [0]);
	return { text, totalPages: 1 };
}

// Outline from headings:

interface FlatHeading {
	level: number;
	title: string;
	blockIndex: number;
}

function buildOutlineFromHeadings(
	body: Element,
	blocks: ContentBlockNode[],
	kept: Set<Element> | null,
): OutlineItem[] {
	let filteredHeadings = filterHeadingsFromTree(body, blocks, kept);
	if (filteredHeadings.length === 0) return [];

	// Stack-based hierarchy building (from snapshot-view.ts)
	let outline: OutlineItem[] = [];
	let stack: (OutlineItem & { level: number })[] = [];

	for (let h of filteredHeadings) {
		let item: OutlineItem & { level: number } = {
			title: h.title,
			ref: [h.blockIndex],
			level: h.level,
			children: [],
		};

		while (stack.length && stack[stack.length - 1].level >= h.level) {
			stack.pop();
		}

		if (stack.length) {
			stack[stack.length - 1].children!.push(item);
		}
		else {
			outline.push(item);
		}
		stack.push(item);
	}

	cleanOutline(outline);
	return outline;
}

function filterHeadingsFromTree(
	body: Element,
	blocks: ContentBlockNode[],
	kept: Set<Element> | null,
): FlatHeading[] {
	let headings: FlatHeading[] = [];

	let headingElements: { el: Element; level: number }[] = [];
	collectHeadingElements(body, headingElements, kept);

	let headingBlockIndices: number[] = [];
	for (let i = 0; i < blocks.length; i++) {
		if (blocks[i].type === 'heading') {
			headingBlockIndices.push(i);
		}
	}

	for (let i = 0; i < Math.min(headingElements.length, headingBlockIndices.length); i++) {
		let { level } = headingElements[i];
		let idx = headingBlockIndices[i];
		let title = getBlockPlainText(blocks[idx]).trim();
		if (!title) continue;
		headings.push({ level, title, blockIndex: idx });
	}

	return headings;
}

function collectHeadingElements(
	node: Element,
	result: { el: Element; level: number }[],
	kept: Set<Element> | null,
): void {
	for (let child of node.children || []) {
		if (!isElement(child)) continue;
		if (kept && !kept.has(child)) continue;
		let name = getLocalName(child);
		let match = /^h([1-6])$/.exec(name);
		if (match) {
			result.push({ el: child, level: parseInt(match[1]) });
		}
		else {
			collectHeadingElements(child, result, kept);
		}
	}
}

function cleanOutline(items: OutlineItem[]): void {
	for (let item of items) {
		if (item.children && item.children.length === 0) {
			delete item.children;
		}
		else if (item.children) {
			cleanOutline(item.children);
		}
	}
}

// Metadata extraction:

function extractMetadata(doc: Document): Record<string, string> {
	let metadata: Record<string, string> = {};
	let head = queryTag(doc, 'head');
	if (!head) return metadata;

	let titleEl = queryTag(head, 'title');
	if (titleEl) {
		let title = getTextContent(titleEl).trim();
		if (title) metadata.title = title;
	}

	for (let child of getElementChildren(head)) {
		if (getLocalName(child) !== 'meta') continue;
		let name = getAttribute(child, 'name');
		let content = getAttribute(child, 'content');
		if (name && content) {
			let lowerName = name.toLowerCase();
			if (lowerName === 'author') metadata.author = content;
			else if (lowerName === 'description') metadata.description = content;
			else if (lowerName === 'keywords') metadata.keywords = content;
		}
	}

	return metadata;
}

// Utilities:

// Unique selector generation
// Adapted from zotero-client/reader unique-selector.ts for htmlparser2 trees

function getUniqueSelector(el: Element, body: Element): string | null {
	let current: Element | null = el;
	let selector = '';
	while (current && current !== body) {
		let joiner = selector ? ' > ' : '';

		if (current.attribs?.id) {
			return '#' + cssEscape(current.attribs.id) + joiner + selector;
		}

		let tagName = getLocalName(current);
		let parent = current.parent;
		if (!parent || !isElement(parent as ChildNode)) break;

		let siblings = getElementChildren(parent as Element);
		let sameTagSiblings = siblings.filter(s => getLocalName(s) === tagName);
		let childIndex = siblings.indexOf(current);

		let pseudo: string;
		if (sameTagSiblings.length === 1) {
			pseudo = '';
		}
		else if (siblings.length === 1) {
			pseudo = '';
		}
		else if (childIndex === 0) {
			pseudo = ':first-child';
		}
		else if (sameTagSiblings[0] === current) {
			pseudo = ':first-of-type';
		}
		else if (childIndex === siblings.length - 1) {
			pseudo = ':last-child';
		}
		else if (sameTagSiblings[sameTagSiblings.length - 1] === current) {
			pseudo = ':last-of-type';
		}
		else {
			pseudo = ':nth-child(' + (childIndex + 1) + ')';
		}

		selector = tagName + pseudo + joiner + selector;
		current = parent as Element;
	}
	return selector || null;
}

function emptyStructure(
	sourceContentType: 'text/html' | 'application/xhtml+xml',
	fileSize: number,
	sourceHash?: string,
): InternalStructuredDocumentText {
	return {
		schemaVersion: SDT_SCHEMA_VERSION,
		metadata: {
			processor: { type: 'snapshot' as const, version: SDT_PROCESSOR_VERSIONS.snapshot },
			dateCreated: new Date().toISOString(),
			source: {
				contentType: sourceContentType,
				...(typeof sourceHash === 'string' ? { hash: sourceHash } : {}),
				properties: {},
				fileSize,
			},
		},
		catalog: {
			pages: [{ contentRange: [[0], [0]] }],
			outline: [],
		},
		content: [],
	};
}

function ensureValidContentType(contentType: string): 'text/html' | 'application/xhtml+xml' {
	if (contentType !== 'text/html' && contentType !== 'application/xhtml+xml') {
		console.warn(`contentType should be text/html or application/xhtml+xml for snapshot; got ${contentType}`);
		return 'text/html';
	}
	return contentType;
}

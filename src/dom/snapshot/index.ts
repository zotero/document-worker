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
import { getContentRange, getNestedBlockPlainText, getBlockPlainText } from '../../../structured-document-text/src/text.js';
import type { StructuredDocumentText, OutlineItem } from '../../../structured-document-text/schema';

const SCHEMA_VERSION = '1.0.0-draft';
const PROCESSOR_VERSION = '1.0.0-draft';

interface FulltextOptions {
	structure?: StructuredDocumentText;
}

const EXCLUDED_ANCESTORS = new Set(['aside', 'nav', 'footer', 'template']);

// Entry points:

export function getSnapshotStructure(
	buf: ArrayBuffer,
	contentType: string,
): StructuredDocumentText {
	let decoder = new TextDecoder('utf-8');
	let html = decoder.decode(new Uint8Array(buf));
	let doc = parseXML(html, { xmlMode: false });

	let body = queryTag(doc, 'body');
	if (!body) {
		return emptyStructure(contentType, buf.byteLength);
	}

	let currentBlockSelector = '';

	let hooks: ConvertHooks = {
		blockAnchor(node) {
			if (!('attribs' in node)) return undefined;
			let value = getUniqueSelector(node as Element, body);
			if (!value) return undefined;
			currentBlockSelector = value;
			return { selectorMap: value };
		},
		textAnchor(node) {
			let el = node.parent;
			if (!el || !isElement(el as ChildNode)) return undefined;
			let parent = el as Element;
			let value = getUniqueSelector(parent, body);
			if (!value) return undefined;

			// Compute relative textMap — suffix after block's CSS selector.
			// Text parent selector always starts with the block selector
			// (since it walks up through the same ancestors), UNLESS an
			// inline element or intermediate ancestor has an id attribute
			// which short-circuits getUniqueSelector. In that case, fall
			// back to the absolute selector.
			let children = parent.children || [];
			let hasOffset = children.length > 1;
			let offset = hasOffset ? getTextOffset(parent, node) : 0;

			if (value === currentBlockSelector) {
				// Same element as block — just the offset (or empty)
				return { selectorMap: hasOffset ? String(offset) : '' };
			}

			if (value.startsWith(currentBlockSelector + ' > ')) {
				// Child of block — store the ' > ...' suffix
				let suffix = value.substring(currentBlockSelector.length);
				return { selectorMap: hasOffset ? suffix + ' ' + offset : suffix };
			}

			// Absolute fallback (inline element has its own id)
			return { selectorMap: hasOffset ? value + ' ' + offset : value };
		},
	};
	let { blocks } = convertBody(body, hooks);

	// Build page content range
	let contentRanges = blocks.length > 0
		? [getContentRange(blocks, 0, blocks.length - 1)]
		: [];

	// Build outline from headings
	let outline = buildOutlineFromHeadings(body, blocks);

	// Character count
	let charCount = 0;
	for (let block of blocks) {
		charCount += getNestedBlockPlainText(block).length;
	}

	return {
		schemaVersion: SCHEMA_VERSION,
		processor: { type: 'snapshot' as const, version: PROCESSOR_VERSION },
		dateCreated: new Date().toISOString(),
		sourceContentType: contentType,
		sourceHash: '',
		metadata: extractMetadata(doc),
		pages: [{ contentRanges }],
		content: blocks,
		...(outline.length > 0 ? { outline } : {}),
		...(charCount > 0 ? { characterCount: charCount } : {}),
		fileSize: buf.byteLength,
	} as unknown as StructuredDocumentText;
}

export function getSnapshotFulltext(
	buf: ArrayBuffer,
	contentType: string,
	options: FulltextOptions = {},
): { text: string; totalPages: number } {
	let structure = options.structure || getSnapshotStructure(buf, contentType);
	let text = getFulltextFromStructuredText(structure, [0]);
	return { text, totalPages: 1 };
}

// Outline from headings:

interface FlatHeading {
	level: number;
	title: string;
	blockIndex: number;
}

function buildOutlineFromHeadings(body: Element, blocks: ContentBlockNode[]): OutlineItem[] {
	let filteredHeadings = filterHeadingsFromTree(body, blocks);
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

function filterHeadingsFromTree(body: Element, blocks: ContentBlockNode[]): FlatHeading[] {
	let headings: FlatHeading[] = [];

	let headingElements: { el: Element; level: number }[] = [];
	collectHeadingElements(body, headingElements);

	let headingBlockIndices: number[] = [];
	for (let i = 0; i < blocks.length; i++) {
		if (blocks[i].type === 'heading') {
			headingBlockIndices.push(i);
		}
	}

	for (let i = 0; i < Math.min(headingElements.length, headingBlockIndices.length); i++) {
		let { el, level } = headingElements[i];
		let idx = headingBlockIndices[i];
		let title = getBlockPlainText(blocks[idx]).trim();
		if (!title) continue;
		if (hasExcludedAncestor(el)) continue;
		headings.push({ level, title, blockIndex: idx });
	}

	return headings;
}

function collectHeadingElements(node: Element, result: { el: Element; level: number }[]): void {
	for (let child of node.children || []) {
		if (!isElement(child)) continue;
		let name = getLocalName(child);
		let match = /^h([1-6])$/.exec(name);
		if (match) {
			result.push({ el: child, level: parseInt(match[1]) });
		}
		else {
			collectHeadingElements(child, result);
		}
	}
}

function hasExcludedAncestor(node: Element): boolean {
	let current = node.parent;
	while (current) {
		if (isElement(current as ChildNode)) {
			let name = getLocalName(current as Element);
			if (EXCLUDED_ANCESTORS.has(name)) return true;
			if ((current as Element).attribs?.hidden !== undefined) return true;
		}
		current = (current as any).parent;
	}
	return false;
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

/**
 * Compute the character offset of a text node within a parent element's
 * full text content (depth-first text node walk), matching WADM TextPositionSelector.
 */
function getTextOffset(root: Element, target: ChildNode): number {
	let offset = 0;
	function walk(node: ChildNode): boolean {
		if (node === target) return true;
		if (node.type === 'text') {
			offset += ((node as any).data || '').length;
		}
		else if ('children' in node) {
			for (let child of (node as Element).children || []) {
				if (walk(child)) return true;
			}
		}
		return false;
	}
	for (let child of root.children || []) {
		if (walk(child)) break;
	}
	return offset;
}

function cssEscape(str: string): string {
	return str.replace(/([^\w-])/g, '\\$1');
}

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

function emptyStructure(contentType: string, fileSize: number): StructuredDocumentText {
	return {
		schemaVersion: SCHEMA_VERSION,
		processor: { type: 'snapshot' as const, version: PROCESSOR_VERSION },
		dateCreated: new Date().toISOString(),
		sourceContentType: contentType,
		sourceHash: '',
		metadata: {},
		pages: [{ contentRanges: [] }],
		content: [],
		fileSize,
	} as unknown as StructuredDocumentText;
}

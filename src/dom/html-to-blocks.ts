import type { Element, ChildNode } from 'domhandler';
import {
	getLocalName,
	getAttribute,
	getElementChildren,
} from './epub/xml';
import { mergeTextNodes } from '../../zotero-structured-text/src/text.js';
import type {
    TextStyle,
    TextNode,
    ContentBlockNode,
    Anchor,
    RefsArray,
    BackRefsArray,
    ArtifactFlag,
} from '../../zotero-structured-text/schema';

/** Block type for incremental construction. Covers all block variant properties. */
export interface Block {
	type: string;
	content?: (Block | TextNode)[];
	anchor?: Anchor;
	refs?: RefsArray;
	backRefs?: BackRefsArray;
	artifact?: ArtifactFlag;
	reference?: boolean;
	ordered?: boolean;
	startIndex?: number;
	header?: boolean;
	colspan?: number;
	rowspan?: number;
	axis?: 'row' | 'column';
}

// Hooks for format-specific behavior:

export interface ConvertHooks {
	/** Create an anchor for a block-level element. Return undefined to skip. */
	blockAnchor?(node: Element | ChildNode): Anchor | undefined;
	/** Create an anchor for a text node. Return undefined to skip. */
	textAnchor?(node: ChildNode): Anchor | undefined;
	/** Called for every element encountered (for ID tracking, etc.) */
	onElement?(el: Element): void;
	/** Called for internal links. textNodes contains the link's inline content. */
	onInternalLink?(el: Element, href: string, textNodes: TextNode[]): void;
	/** Check if an element is a note (footnote/endnote). If true, it's rendered as a 'note' block. */
	isNote?(el: Element): boolean;
}

// Maps:

const BLOCK_ELEMENT_MAP: Record<string, string> = {
	h1: 'heading',
    h2: 'heading',
    h3: 'heading',
	h4: 'heading',
    h5: 'heading',
    h6: 'heading',
	p: 'paragraph',
	blockquote: 'blockquote',
	pre: 'preformatted',
	table: 'table',
	tr: 'tablerow',
	td: 'tablecell',
	th: 'tablecell',
	ul: 'list',
	ol: 'list',
	li: 'listitem',
	img: 'image',
	figure: 'figure',
	figcaption: 'caption',
};

const INLINE_STYLE_MAP: Record<string, TextStyle> = {
	b: { bold: true },
	strong: { bold: true },
	i: { italic: true },
	em: { italic: true },
	cite: { italic: true },
	sup: { sup: true },
	sub: { sub: true },
	code: { monospace: true },
	tt: { monospace: true },
	kbd: { monospace: true },
	samp: { monospace: true },
};

const TRANSPARENT_ELEMENTS = new Set([
	'div', 'section', 'article', 'main', 'header', 'footer', 'nav',
	'span', 'small', 'u', 'mark', 'abbr', 'dfn', 'var', 'q',
	'ruby', 'rt', 'rp', 'bdi', 'bdo', 'wbr', 'time', 'data',
]);

// Context:

interface ConvertContext {
	hooks: ConvertHooks;
	styleStack: (TextStyle | null)[];
	blocks: Block[];
}

// Entry point:

export interface ConvertResult {
	blocks: ContentBlockNode[];
}

/**
 * Convert an HTML/XHTML element's children into structured text blocks.
 * Pass an existing blocks array if hooks need live access to the block count.
 */
export function convertBody(body: Element, hooks: ConvertHooks = {}, blocks: Block[] = []): ConvertResult {
	let ctx: ConvertContext = {
		hooks,
		styleStack: [],
		blocks,
	};
	processChildren(body, ctx);
	return { blocks: ctx.blocks as ContentBlockNode[] };
}

// Block processing:

function processChildren(parent: Element, ctx: ConvertContext): void {
	for (let child of parent.children || []) {
		processNode(child, ctx);
	}
}

function processNode(node: ChildNode, ctx: ConvertContext): void {
	if (node.type === 'text') {
		let text = (node as any).data || '';
		if (text.trim()) {
			let block = makeBlock('paragraph', node, ctx);
			block.content = [createTextNode(text, node, ctx)];
			ctx.blocks.push(block);
		}
		return;
	}

	if (node.type !== 'tag') return;

	let el = node as Element;
	let localName = getLocalName(el);

	ctx.hooks.onElement?.(el);

	// Check for format-specific note handling (EPUB footnotes/endnotes)
	if (ctx.hooks.isNote?.(el)) {
		let note = createContainerBlock('note', el, ctx);
		if (note) ctx.blocks.push(note);
		return;
	}

	let blockType = BLOCK_ELEMENT_MAP[localName];

	if (blockType === 'heading' || blockType === 'paragraph' || blockType === 'caption') {
		let block = makeBlock(blockType, el, ctx);
		block.content = collectInlineContent(el, ctx);
		ctx.blocks.push(block);
	}
	else if (blockType === 'preformatted') {
		let block = makeBlock('preformatted', el, ctx);
		block.content = collectInlineContent(el, ctx, true);
		ctx.blocks.push(block);
	}
	else if (blockType === 'blockquote') {
		let block = makeBlock('blockquote', el, ctx);
		let savedBlocks = ctx.blocks;
		ctx.blocks = [];
		processChildren(el, ctx);
		block.content = ctx.blocks;
		ctx.blocks = savedBlocks;
		if (block.content!.length > 0) {
			ctx.blocks.push(block);
		}
	}
	else if (blockType === 'list') {
		let block = makeBlock('list', el, ctx);
		if (localName === 'ol') {
			block.ordered = true;
			let start = getAttribute(el, 'start');
			if (start && parseInt(start) > 1) {
				block.startIndex = parseInt(start);
			}
		}
		let children = getElementChildren(el).filter(c => getLocalName(c) === 'li');
		for (let li of children) {
			ctx.hooks.onElement?.(li);
			if (ctx.hooks.isNote?.(li)) {
				// A note must be a sibling block, not a list item — emit the in-progress list first
				if (block.content!.length > 0) {
					ctx.blocks.push(block);
					block = { type: 'list', content: [] };
					if (localName === 'ol') block.ordered = true;
				}
				let note = createContainerBlock('note', li, ctx);
				if (note) ctx.blocks.push(note);
			}
			else {
				let listitem = createContainerBlock('listitem', li, ctx);
				if (listitem) block.content!.push(listitem);
			}
		}
		if (block.content!.length > 0) {
			ctx.blocks.push(block);
		}
	}
	else if (blockType === 'listitem') {
		let listitem = createContainerBlock('listitem', el, ctx);
		if (listitem) {
			let wrapper = makeBlock('list', el, ctx);
			wrapper.content = [listitem];
			ctx.blocks.push(wrapper);
		}
	}
	else if (blockType === 'table') {
		let block = createTable(el, ctx);
		if (block) ctx.blocks.push(block);
	}
	else if (blockType === 'tablerow' || blockType === 'tablecell') {
		processChildren(el, ctx);
	}
	else if (blockType === 'image') {
		let block = createImage(el, ctx);
		ctx.blocks.push(block);
	}
	else if (blockType === 'figure') {
		processFigure(el, ctx);
	}
	else if (TRANSPARENT_ELEMENTS.has(localName) || !blockType) {
		if (hasBlockChildren(el)) {
			processChildren(el, ctx);
		}
		else {
			let block = makeBlock('paragraph', el, ctx);
			let content = collectInlineContent(el, ctx);
			if (content.length > 0) {
				block.content = content;
				ctx.blocks.push(block);
			}
		}
	}
}

// Block creation:

function makeBlock(type: string, node: Element | ChildNode, ctx: ConvertContext): Block {
	if ('attribs' in node) ctx.hooks.onElement?.(node as Element);
	let block: Block = { type, content: [] };
	let anchor = ctx.hooks.blockAnchor?.(node);
	if (anchor) block.anchor = anchor;
	return block;
}

// Container blocks (notes, list items):

function createContainerBlock(type: string, el: Element, ctx: ConvertContext): Block | null {
	if (hasBlockChildren(el)) {
		let savedBlocks = ctx.blocks;
		ctx.blocks = [];
		processChildren(el, ctx);
		let childBlocks = ctx.blocks;
		ctx.blocks = savedBlocks;
		if (childBlocks.length === 0) return null;
		let block = makeBlock(type, el, ctx);
		block.content = childBlocks;
		return block;
	}
	else {
		let block = makeBlock(type, el, ctx);
		let content = collectInlineContent(el, ctx);
		if (content.length === 0) return null;
		block.content = content;
		return block;
	}
}

// Tables:

function createTable(tableNode: Element, ctx: ConvertContext): Block | null {
	ctx.hooks.onElement?.(tableNode);
	let rows: Block[] = [];

	let collectRows = (parent: Element): void => {
		for (let child of getElementChildren(parent)) {
			let name = getLocalName(child);
			if (name === 'tr') {
				ctx.hooks.onElement?.(child);
				let row = createTableRow(child, ctx);
				if (row) rows.push(row);
			}
			else if (name === 'thead' || name === 'tbody' || name === 'tfoot') {
				collectRows(child);
			}
		}
	};
	collectRows(tableNode);

	if (rows.length === 0) {
		let content = collectInlineContent(tableNode, ctx);
		if (content.length === 0) return null;
		let block = makeBlock('table', tableNode, ctx);
		block.content = content;
		return block;
	}

	let block = makeBlock('table', tableNode, ctx);
	block.content = rows;
	return block;
}

function createTableRow(tr: Element, ctx: ConvertContext): Block | null {
	let cells: Block[] = [];
	for (let child of getElementChildren(tr)) {
		let name = getLocalName(child);
		if (name === 'td' || name === 'th') {
			ctx.hooks.onElement?.(child);
			let cell = createTableCell(child, name === 'th', ctx);
			if (cell) cells.push(cell);
		}
	}
	if (cells.length === 0) return null;
	let block = makeBlock('tablerow', tr, ctx);
	block.content = cells;
	return block;
}

function createTableCell(td: Element, isHeader: boolean, ctx: ConvertContext): Block {
	let cell = makeBlock('tablecell', td, ctx);
	if (isHeader) cell.header = true;

	let colspan = parseInt(getAttribute(td, 'colspan') || '');
	if (colspan > 1) cell.colspan = colspan;
	let rowspan = parseInt(getAttribute(td, 'rowspan') || '');
	if (rowspan > 1) cell.rowspan = rowspan;

	if (hasBlockChildren(td)) {
		let savedBlocks = ctx.blocks;
		ctx.blocks = [];
		processChildren(td, ctx);
		cell.content = ctx.blocks;
		ctx.blocks = savedBlocks;
	}
	else {
		let inline = collectInlineContent(td, ctx);
		if (inline.length > 0) {
			let wrapper = makeBlock('paragraph', td, ctx);
			wrapper.content = inline;
			cell.content = [wrapper];
		}
	}

	return cell;
}

// Images & figures:

function createImage(imgNode: Element, ctx: ConvertContext): Block {
	let alt = getAttribute(imgNode, 'alt') || '';
	let block = makeBlock('image', imgNode, ctx);
	if (alt) block.content = [{ text: alt }];
	return block;
}

function processFigure(figureNode: Element, ctx: ConvertContext): void {
	ctx.hooks.onElement?.(figureNode);
	for (let child of getElementChildren(figureNode)) {
		let name = getLocalName(child);
		if (name === 'img') {
			ctx.blocks.push(createImage(child, ctx));
		}
		else if (name === 'figcaption') {
			let block = makeBlock('caption', child, ctx);
			block.content = collectInlineContent(child, ctx);
			ctx.blocks.push(block);
		}
		else {
			processNode(child, ctx);
		}
	}
}

// Inline content:

export function collectInlineContent(node: Element, ctx: ConvertContext, preserveWhitespace = false): TextNode[] {
	let textNodes: TextNode[] = [];
	walkInline(node, ctx, textNodes, preserveWhitespace);
	return mergeTextNodes(textNodes);
}

function walkInline(node: Element, ctx: ConvertContext, textNodes: TextNode[], preserveWhitespace: boolean): void {
	for (let child of node.children || []) {
		if (child.type === 'text') {
			let text = (child as any).data || '';
			if (!preserveWhitespace) {
				text = text.replace(/\s+/g, ' ');
			}
			if (text) {
				textNodes.push(createTextNode(text, child, ctx));
			}
		}
		else if (child.type === 'tag') {
			let el = child as Element;
			let localName = getLocalName(el);
			ctx.hooks.onElement?.(el);

			if (localName === 'br') {
				textNodes.push({ text: '\n' });
				continue;
			}

			if (localName === 'img') {
				let alt = getAttribute(el, 'alt');
				if (alt) textNodes.push({ text: alt });
				continue;
			}

			if (localName === 'a') {
				let href = getAttribute(el, 'href');
				if (href && /^https?:\/\//.test(href)) {
					ctx.styleStack.push(null);
					let linkTextNodes: TextNode[] = [];
					walkInline(el, ctx, linkTextNodes, preserveWhitespace);
					ctx.styleStack.pop();
					for (let tn of linkTextNodes) {
						tn.target = { url: href };
					}
					textNodes.push(...linkTextNodes);
					continue;
				}
				else if (href) {
					let linkTextNodes: TextNode[] = [];
					walkInline(el, ctx, linkTextNodes, preserveWhitespace);
					ctx.hooks.onInternalLink?.(el, href, linkTextNodes);
					textNodes.push(...linkTextNodes);
					continue;
				}
			}

			let style = INLINE_STYLE_MAP[localName];
			if (style) {
				ctx.styleStack.push(style);
				walkInline(el, ctx, textNodes, preserveWhitespace);
				ctx.styleStack.pop();
			}
			else if (!BLOCK_ELEMENT_MAP[localName]) {
                walkInline(el, ctx, textNodes, preserveWhitespace);
			}
		}
	}
}

// Text node helpers:

function createTextNode(text: string, node: ChildNode, ctx: ConvertContext): TextNode {
	let tn: TextNode = { text };
	let merged = mergeStyles(ctx.styleStack);
	if (merged) tn.style = merged;
	let anchor = ctx.hooks.textAnchor?.(node);
	if (anchor) tn.anchor = anchor;
	return tn;
}

function mergeStyles(styleStack: (TextStyle | null)[]): TextStyle | null {
	let merged: TextStyle | null = null;
	for (let style of styleStack) {
		if (style) {
			if (!merged) merged = {};
			Object.assign(merged, style);
		}
	}
	return merged;
}

// Utilities:

export function hasBlockChildren(node: Element): boolean {
	for (let child of node.children || []) {
		if (child.type === 'tag') {
            
			let name = getLocalName(child as Element);
			if (BLOCK_ELEMENT_MAP[name] && name !== 'img') return true;
		}
	}
	return false;
}

import type { ChildNode, Element } from 'domhandler';
import {
	getElementChildren,
	getLocalName,
	isElement,
} from '../epub/xml';
import {
	DOM_MAP_FIRST_OF_TYPE,
	DOM_MAP_LAST_OF_TYPE,
	DOM_MAP_LAST_CHILD,
} from '../../../structured-document-text/src/dom/snapshot/dommap.js';
import type { DomMapNode } from '../../../structured-document-text/schema';

/**
 * Per-element data collected by the body pre-pass: sibling position (for
 * selector generation/matching) and the position of the element's subtree
 * text within the body text stream.
 */
export interface ElementInfo {
	/** 0-based index among the parent's element children. */
	index: number;

	/** DOM_MAP_* bits. */
	flags: number;

	/** id of the previous element sibling, when it has one. */
	prevId?: string;

	/** Body-stream offset at element entry (raw original characters). */
	textStart: number;

	/** Body-stream offset at element exit. */
	textEnd: number;
}

export interface DomIndex {
	body: Element;
	elements: Map<Element, ElementInfo>;
	textOffsets: Map<ChildNode, number>;
}

/**
 * Walk the body subtree in document order, counting raw text characters
 * the same way a browser NodeIterator(SHOW_TEXT) over the live snapshot
 * counts them, since this is what WADM TextPositionSelector offsets
 * created by the reader are measured in. That means:
 *
 * - every text node counts, including whitespace-only nodes between
 *   blocks and raw text inside <script>/<style>/<title>/<textarea>
 * - <template> contents don't count (browsers parse them into a separate
 *   DocumentFragments that tree iteration never reaches)
 *
 */
export function buildDomIndex(body: Element): DomIndex {
	let elements = new Map<Element, ElementInfo>();
	let textOffsets = new Map<ChildNode, number>();
	let offset = 0;

	let visit = (parent: Element) => {
		let elementChildren = getElementChildren(parent);
		let lastOfTag = new Map<string, Element>();
		for (let child of elementChildren) {
			lastOfTag.set(getLocalName(child), child);
		}

		let elementIndex = 0;
		let seenTags = new Set<string>();
		let prevElement: Element | null = null;
		for (let child of parent.children || []) {
			if (child.type === 'text') {
				textOffsets.set(child, offset);
				offset += ((child as { data?: string }).data || '').length;
				continue;
			}
			if (!isElement(child)) {
				continue;
			}
			let tag = getLocalName(child);
			let flags = 0;
			if (!seenTags.has(tag)) {
				flags |= DOM_MAP_FIRST_OF_TYPE;
				seenTags.add(tag);
			}
			if (lastOfTag.get(tag) === child) {
				flags |= DOM_MAP_LAST_OF_TYPE;
			}
			if (elementIndex === elementChildren.length - 1) {
				flags |= DOM_MAP_LAST_CHILD;
			}
			let info: ElementInfo = {
				index: elementIndex,
				flags,
				textStart: offset,
				textEnd: offset,
			};
			let prevId = prevElement?.attribs?.id;
			if (prevId) {
				info.prevId = prevId;
			}
			elements.set(child, info);
			if (tag !== 'template') {
				visit(child);
			}
			info.textEnd = offset;
			elementIndex++;
			prevElement = child;
		}
	};
	visit(body);

	return { body, elements, textOffsets };
}

/**
 * Build the catalog domMap skeleton: the ancestor-closed subset of the
 * pre-pass index covering every anchored element.
 */
export function buildDomMap(index: DomIndex, anchored: Set<Element>): DomMapNode[] {
	let marked = new Set<Element>();
	for (let el of anchored) {
		let current: Element | null = el;
		while (current && current !== index.body && !marked.has(current)) {
			marked.add(current);
			current = current.parent && isElement(current.parent as ChildNode)
				? current.parent as Element
				: null;
		}
	}

	let build = (el: Element): DomMapNode | null => {
		if (!marked.has(el)) {
			return null;
		}
		let info = index.elements.get(el);
		if (!info) {
			return null;
		}
		let node: DomMapNode = {
			tag: getLocalName(el),
			index: info.index,
			textStart: info.textStart,
			textLength: info.textEnd - info.textStart,
		};
		if (el.attribs?.id) {
			node.id = el.attribs.id;
		}
		if (info.flags) {
			node.flags = info.flags;
		}
		if (info.prevId) {
			node.prevId = info.prevId;
		}
		let children = getElementChildren(el)
			.map(build)
			.filter((child): child is DomMapNode => !!child);
		if (children.length) {
			node.children = children;
		}
		return node;
	};

	return getElementChildren(index.body)
		.map(build)
		.filter((child): child is DomMapNode => !!child);
}

/**
 * EPUB CFI (Canonical Fragment Identifier) generation from htmlparser2 trees.
 *
 * CFI format: epubcfi(/<spineStep>/<itemStep>[<idref>]!/<path>)
 *   - /<spineStep> references the <spine> in the OPF (position among <package> children)
 *   - Element steps use even indices: /(2*(position+1))
 *   - Text node steps use odd indices between element siblings
 *   - Character offsets are appended as :offset
 */

import type { ChildNode } from 'domhandler';
import { isElement, getLocalName } from './xml';

type TreeNode = ChildNode;

/**
 * Elements that the reader's sanitizer removes from the DOM.
 * CFI step indices must skip these so paths match the post-sanitization DOM.
 */
const SANITIZER_REMOVED_TAGS = new Set(['style', 'title']);

function isSanitizerRemovedElement(node: TreeNode): boolean {
	if (!isElement(node)) return false;
	let name = getLocalName(node);
	if (SANITIZER_REMOVED_TAGS.has(name)) return true;
	// <link rel="stylesheet"> is removed
	if (name === 'link') {
		let rel = node.attribs?.rel || '';
		if (/\bstylesheet\b/i.test(rel)) return true;
	}
	return false;
}

/**
 * Generate the base CFI path for a spine item.
 * spineStep = CFI step for <spine> within <package> (computed from OPF).
 */
export function generateCFIBase(spineStep: number, spineIndex: number, idref?: string): string {
	let itemStep = 2 * (spineIndex + 1);
	let assertion = idref ? `[${idref}]` : '';
	return `/${spineStep}/${itemStep}${assertion}`;
}

/**
 * Compute the CFI step index for a node among its parent's children.
 * Skips elements that the reader's sanitizer removes, so CFI paths
 * match the post-sanitization DOM.
 */
function getNodeStepIndex(node: TreeNode): number {
	if (!node.parent) return 0;
	let siblings = ('children' in node.parent ? node.parent.children : []) as ChildNode[];

	if (isElement(node)) {
		let elementIndex = 0;
		for (let sibling of siblings) {
			if (sibling === node) break;
			if (isElement(sibling) && !isSanitizerRemovedElement(sibling)) {
				elementIndex++;
			}
		}
		return 2 * (elementIndex + 1);
	}

	// Text node step = 1 + 2 * elementsBefore
	let elementsBefore = 0;
	for (let sibling of siblings) {
		if (sibling === node) break;
		if (isElement(sibling) && !isSanitizerRemovedElement(sibling)) {
			elementsBefore++;
		}
	}
	return 1 + 2 * elementsBefore;
}

/**
 * Generate the element path portion of a CFI from a node up to (but
 * not including) the document element.
 */
export function elementPath(node: TreeNode): string {
	let steps: string[] = [];
	let current: TreeNode = node;
	while (current && current.parent) {
		let stepIndex = getNodeStepIndex(current);
		let id = (isElement(current) && current.attribs?.id)
			? `[${current.attribs.id}]`
			: '';
		steps.unshift(`/${stepIndex}${id}`);

		// Stop after including this node's step if its parent is <html>
		// (the document element).
		let parentName = isElement(current.parent as any) ? getLocalName(current.parent as any) : '';
		if (parentName === 'html') {
			break;
		}
		current = current.parent as TreeNode;
	}
	return steps.join('');
}

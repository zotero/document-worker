/**
 * EPUB CFI (Canonical Fragment Identifier) generation from htmlparser2 trees.
 *
 * CFI format: epubcfi(/<spineStep>/<itemStep>[<idref>]!/<path>)
 *   - /<spineStep> references the <spine> in the OPF (position among <package> children)
 *   - Element steps use even indices: /(2*(position+1))
 *   - Text node steps use odd indices between element siblings
 *   - Character offsets are appended as :offset
 */

import type { ChildNode, Element } from 'domhandler';
import { isElement } from './xml';

type TreeNode = ChildNode;

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
 */
function getNodeStepIndex(node: TreeNode): number {
	if (!node.parent) return 0;
	let siblings = ('children' in node.parent ? node.parent.children : []) as ChildNode[];

	if (isElement(node)) {
		let elementIndex = 0;
		for (let sibling of siblings) {
			if (sibling === node) break;
			if (isElement(sibling)) {
				elementIndex++;
			}
		}
		return 2 * (elementIndex + 1);
	}

	// Text node step = 1 + 2 * elementsBefore
	let elementsBefore = 0;
	for (let sibling of siblings) {
		if (sibling === node) break;
		if (isElement(sibling)) {
			elementsBefore++;
		}
	}
	return 1 + 2 * elementsBefore;
}

/**
 * Generate the element path portion of a CFI from a node up to body/html.
 */
export function elementPath(node: TreeNode): string {
	let steps: string[] = [];
	let current: TreeNode = node;
	while (current && current.parent) {
		let parentName = ('name' in current.parent) ? (current.parent as Element).name : '';
		let stepIndex = getNodeStepIndex(current);
		let id = (isElement(current) && current.attribs?.id)
			? `[${current.attribs.id}]`
			: '';
		steps.unshift(`/${stepIndex}${id}`);

		if (parentName === 'body' || parentName === 'html') {
			break;
		}
		current = current.parent as TreeNode;
	}
	return steps.join('');
}

/**
 * Build a full CFI for a block-level element.
 */
export function buildBlockCFI(cfiBase: string, elementNode: TreeNode): string {
	let path = elementPath(elementNode);
	return `epubcfi(${cfiBase}!${path})`;
}

/**
 * Build a full CFI pointing to a text node (no character offset).
 * The odd-numbered step identifies the text node itself, so a reader
 * can highlight the whole node without needing a range.
 */
export function buildTextNodeCFI(cfiBase: string, textNode: TreeNode): string {
	let path = elementPath(textNode);
	return `epubcfi(${cfiBase}!${path})`;
}

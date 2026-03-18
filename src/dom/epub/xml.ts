import { parseDocument } from 'htmlparser2';
import type { Document, ChildNode, Element, DataNode } from 'domhandler';

export type { Document, ChildNode, Element };

export type AnyNode = Document | ChildNode;

export const EPUB_NS = 'http://www.idpf.org/2007/ops';

export function isElement(node: ChildNode): node is Element {
	return node.type === 'tag' || node.type === 'script' || node.type === 'style';
}

function getChildren(node: AnyNode): ChildNode[] {
	if ('children' in node && Array.isArray(node.children)) {
        return node.children;
    }
	if ('childNodes' in node && Array.isArray(node.childNodes)) {
        return node.childNodes;
    }
	return [];
}

/**
 * Parse an XML/XHTML string into an htmlparser2 document tree.
 */
export function parseXML(str: string, { xmlMode = true } = {}): Document {
	try {
		return parseDocument(str, {
			xmlMode,
			recognizeSelfClosing: true,
		});
	}
	catch {
		// Fall back to HTML mode if XML parsing fails
		return parseDocument(str, {
			xmlMode: false,
			recognizeSelfClosing: true,
		});
	}
}

/**
 * Get the local name of an element, stripping any namespace prefix.
 * e.g. "dc:title" -> "title", "opf:itemref" -> "itemref"
 */
export function getLocalName(node: AnyNode): string {
	if (!('name' in node) || !node.name) {
        return '';
    }
	let name = node.name;
	let idx = name.indexOf(':');
	return idx >= 0 ? name.slice(idx + 1) : name;
}

/**
 * Find the first descendant element matching a local name.
 */
export function queryTag(node: AnyNode, localName: string): Element | null {
	let children = getChildren(node);
	for (let child of children) {
		if (isElement(child)) {
			if (getLocalName(child) === localName) {
				return child;
			}
			let found = queryTag(child, localName);
			if (found) return found;
		}
	}
	return null;
}

/**
 * Find all descendant elements matching a local name.
 */
export function queryTagAll(node: AnyNode, localName: string): Element[] {
	let results: Element[] = [];
	_queryTagAll(node, localName, results);
	return results;
}

function _queryTagAll(node: AnyNode, localName: string, results: Element[]): void {
	let children = getChildren(node);
	for (let child of children) {
		if (isElement(child)) {
			if (getLocalName(child) === localName) {
				results.push(child);
			}
			_queryTagAll(child, localName, results);
		}
	}
}

/**
 * Get concatenated text content of all descendant text nodes.
 */
export function getTextContent(node: AnyNode): string {
	if (node.type === 'text') {
        return (node as DataNode).data || '';
    }
    if (node.type === 'tag' && getLocalName(node) === 'br') {
        return '\n';
    }
	let parts: string[] = [];
	let children = getChildren(node);
	if (children.length) {
		for (let child of children) {
			parts.push(getTextContent(child));
		}
	}
	return parts.join('');
}

/**
 * Get an attribute value, trying both the bare name and common prefixed forms.
 */
export function getAttribute(node: AnyNode, name: string): string | null {
	if (!('attribs' in node) || !node.attribs) return null;
	if (name in node.attribs) return node.attribs[name];
	for (let key in node.attribs) {
		let idx = key.indexOf(':');
		if (idx >= 0 && key.slice(idx + 1) === name) {
			return node.attribs[key];
		}
	}
	return null;
}

const NS_PREFIX_MAP: Record<string, string[]> = {
	'http://www.idpf.org/2007/ops': ['epub'],
	'http://purl.org/dc/elements/1.1/': ['dc'],
	'http://www.idpf.org/2007/opf': ['opf'],
};

/**
 * Get an attribute by namespace URI and local name.
 */
export function getAttributeNS(node: AnyNode, ns: string, localName: string): string | null {
	if (!('attribs' in node) || !node.attribs) return null;
	let prefixes = NS_PREFIX_MAP[ns] || [];
	for (let prefix of prefixes) {
		let key = prefix + ':' + localName;
		if (key in node.attribs) return node.attribs[key];
	}
	if (localName in node.attribs) return node.attribs[localName];
	return null;
}

/**
 * Get direct element children of a node.
 */
export function getElementChildren(node: AnyNode): Element[] {
	let children = getChildren(node);
	return children.filter(isElement);
}

/**
 * Find the first direct child element with a given local name.
 */
export function findChildElement(node: AnyNode, localName: string): Element | null {
	let children = getChildren(node);
	for (let child of children) {
		if (isElement(child) && getLocalName(child) === localName) {
			return child;
		}
	}
	return null;
}

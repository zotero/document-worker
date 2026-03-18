import {
	parseXML,
	queryTag,
	queryTagAll,
	getTextContent,
	getAttribute,
	getLocalName,
	getElementChildren,
} from './xml';

export interface ManifestItem {
	href: string;
	mediaType: string;
	properties: string;
}

export interface SpineItem {
	idref: string;
	linear: boolean;
}

export type TocFormat = 'ncx' | 'xhtml';

export interface OPFResult {
	metadata: Record<string, string>;
	manifest: Map<string, ManifestItem>;
	spine: SpineItem[];
	spineStep: number;
	tocPath: string | null;
	tocFormat: TocFormat | null;
}

/**
 * Parse META-INF/container.xml to find the OPF file path.
 */
export function parseContainer(xml: string): string {
	let doc = parseXML(xml);
	let rootfile = queryTag(doc, 'rootfile');
	if (!rootfile) {
		throw new Error('No <rootfile> found in container.xml');
	}
	let fullPath = getAttribute(rootfile, 'full-path');
	if (!fullPath) {
		throw new Error('No full-path attribute on <rootfile>');
	}
	return fullPath;
}

/**
 * Resolve a relative href against a base directory path.
 */
export function resolveHref(href: string, basePath: string): string {
	if (!basePath) return href;
	try {
		href = decodeURIComponent(href);
	}
	catch {
		// keep as-is if malformed
	}
	let parts = basePath.split('/').concat(href.split('/'));
	let resolved: string[] = [];
	for (let part of parts) {
		if (part === '..') {
			resolved.pop();
		}
		else if (part !== '.' && part !== '') {
			resolved.push(part);
		}
	}
	return resolved.join('/');
}

/**
 * Parse an OPF package document.
 */
export function parseOPF(xml: string, opfPath: string): OPFResult {
	let doc = parseXML(xml);
	let basePath = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')) : '';

	// Parse metadata
	let metadata: Record<string, string> = {};
	let metadataEl = queryTag(doc, 'metadata');
	if (metadataEl) {
		let dcMap: Record<string, string> = {
			title: 'title',
			creator: 'creator',
			language: 'language',
			identifier: 'identifier',
			publisher: 'publisher',
			date: 'date',
			description: 'description',
			subject: 'subject',
			rights: 'rights',
		};
		for (let [localName, key] of Object.entries(dcMap)) {
			let el = queryTag(metadataEl, localName);
			if (el) {
				let text = getTextContent(el).trim();
				if (text) metadata[key] = text;
			}
		}
	}

	// Parse manifest
	let manifest = new Map<string, ManifestItem>();
	let manifestEl = queryTag(doc, 'manifest');
	if (manifestEl) {
		let items = queryTagAll(manifestEl, 'item');
		for (let item of items) {
			let id = getAttribute(item, 'id');
			let href = getAttribute(item, 'href');
			let mediaType = getAttribute(item, 'media-type');
			let properties = getAttribute(item, 'properties') || '';
			if (id && href) {
				manifest.set(id, {
					href: resolveHref(href, basePath),
					mediaType: mediaType || '',
					properties,
				});
			}
		}
	}

	// Parse spine
	let spine: SpineItem[] = [];
	let spineEl = queryTag(doc, 'spine');
	let spineStep = 6; // default per spec (metadata, manifest, spine)
	let tocId: string | null = null;
	let tocPath: string | null = null;
	let tocFormat: TocFormat | null = null;

	if (spineEl) {
		// Compute CFI step for <spine> within <package>
		let packageEl = queryTag(doc, 'package');
		if (packageEl) {
			let elementIndex = 0;
			for (let child of getElementChildren(packageEl)) {
				if (child === spineEl) break;
				elementIndex++;
			}
			spineStep = 2 * (elementIndex + 1);
		}
		tocId = getAttribute(spineEl, 'toc');
		let itemrefs = getElementChildren(spineEl).filter(
			c => getLocalName(c) === 'itemref'
		);
		for (let itemref of itemrefs) {
			let idref = getAttribute(itemref, 'idref');
			let linear = getAttribute(itemref, 'linear');
			if (idref) {
				spine.push({ idref, linear: linear !== 'no' });
			}
		}
	}

	// Find TOC
	// EPUB 3: look for nav document in manifest (properties="nav")
	for (let [, item] of manifest) {
		if (item.properties && item.properties.split(/\s+/).includes('nav')) {
			tocPath = item.href;
			tocFormat = 'xhtml';
			break;
		}
	}

	// EPUB 2 fallback: NCX from spine toc attribute
	if (!tocPath && tocId && manifest.has(tocId)) {
		tocPath = manifest.get(tocId)!.href;
		tocFormat = 'ncx';
	}

	return { metadata, manifest, spine, spineStep, tocPath, tocFormat };
}

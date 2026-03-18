import type { Document, Element } from 'domhandler';
import {
	EPUB_NS,
	parseXML,
	queryTag,
	queryTagAll,
	getTextContent,
	getAttribute,
	getLocalName,
	getAttributeNS,
	getElementChildren,
	findChildElement,
} from './xml';
import type { TocFormat } from './opf';

export interface TocItem {
	title: string;
	href: string;
	children?: TocItem[];
}

export interface PageListEntry {
	label: string;
	href: string;
}

/**
 * Parse a TOC document (NCX or XHTML nav) into an outline tree.
 */
export function parseTOC(xml: string, format: TocFormat): TocItem[] {
	let doc = parseXML(xml);
	if (format === 'ncx') {
		return parseNCX(doc);
	}
	return parseXHTMLNav(doc);
}

function parseNCX(doc: Document): TocItem[] {
	let navMap = queryTag(doc, 'navMap');
	if (!navMap) return [];
	let navPoints = getElementChildren(navMap).filter(
		c => getLocalName(c) === 'navPoint'
	);
	return navPoints.map(parseNavPoint);
}

function parseNavPoint(navPoint: Element): TocItem {
	let navLabel = queryTag(navPoint, 'navLabel');
	let title = navLabel ? getTextContent(navLabel).trim() : '';
	let content = findChildElement(navPoint, 'content');
	let href = content ? getAttribute(content, 'src') || '' : '';

	let childNavPoints = getElementChildren(navPoint).filter(
		c => getLocalName(c) === 'navPoint'
	);
	let children = childNavPoints.map(parseNavPoint);

	let item: TocItem = { title, href };
	if (children.length) {
		item.children = children;
	}
	return item;
}

function parseXHTMLNav(doc: Document): TocItem[] {
	let navs = queryTagAll(doc, 'nav');
	let tocNav: Element | null = null;
	for (let nav of navs) {
		let epubType = getAttributeNS(nav, EPUB_NS, 'type') || '';
		if (epubType.split(/\s+/).includes('toc')) {
			tocNav = nav;
			break;
		}
	}
	if (!tocNav) {
		tocNav = navs[0] || null;
	}
	if (!tocNav) return [];

	let ol = findChildElement(tocNav, 'ol');
	if (!ol) return [];

	return parseOlItems(ol);
}

function parseOlItems(ol: Element): TocItem[] {
	let items: TocItem[] = [];
	let children = getElementChildren(ol).filter(c => getLocalName(c) === 'li');
	for (let li of children) {
		let item = parseLiItem(li);
		if (item) items.push(item);
	}
	return items;
}

function parseLiItem(li: Element): TocItem | null {
	let a = findChildElement(li, 'a');
	let span = !a ? findChildElement(li, 'span') : null;

	let title = '';
	let href = '';

	if (a) {
		title = getTextContent(a).trim();
		href = getAttribute(a, 'href') || '';
	}
	else if (span) {
		title = getTextContent(span).trim();
	}

	let ol = findChildElement(li, 'ol');
	let children = ol ? parseOlItems(ol) : [];

	let item: TocItem = { title, href };
	if (children.length) {
		item.children = children;
	}
	return item;
}

/**
 * Parse a page-list from an NCX or XHTML nav document.
 */
export function parsePageList(xml: string, format: TocFormat): PageListEntry[] {
	let doc = parseXML(xml);
	if (format === 'ncx') {
		return parseNCXPageList(doc);
	}
	return parseXHTMLPageList(doc);
}

function parseNCXPageList(doc: Document): PageListEntry[] {
	let pageList = queryTag(doc, 'pageList');
	if (!pageList) return [];
	let targets = getElementChildren(pageList).filter(
		c => getLocalName(c) === 'pageTarget'
	);
	let entries: PageListEntry[] = [];
	for (let target of targets) {
		let navLabel = queryTag(target, 'navLabel');
		let label = navLabel ? getTextContent(navLabel).trim() : '';
		let content = findChildElement(target, 'content');
		let href = content ? getAttribute(content, 'src') || '' : '';
		if (label && href) {
			entries.push({ label, href });
		}
	}
	return entries;
}

function parseXHTMLPageList(doc: Document): PageListEntry[] {
	let navs = queryTagAll(doc, 'nav');
	let pageListNav: Element | null = null;
	for (let nav of navs) {
		let epubType = getAttributeNS(nav, EPUB_NS, 'type') || '';
		if (epubType.split(/\s+/).includes('page-list')) {
			pageListNav = nav;
			break;
		}
	}
	if (!pageListNav) return [];

	let ol = findChildElement(pageListNav, 'ol');
	if (!ol) return [];

	let entries: PageListEntry[] = [];
	let lis = getElementChildren(ol).filter(c => getLocalName(c) === 'li');
	for (let li of lis) {
		let a = findChildElement(li, 'a');
		if (!a) continue;
		let label = getTextContent(a).trim();
		let href = getAttribute(a, 'href') || '';
		if (label && href) {
			entries.push({ label, href });
		}
	}
	return entries;
}

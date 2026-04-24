/*
 * Readability-style content filtering for snapshot SDT generation.
 *
 * Ported (filtering parts only) from Mozilla's Readability
 * (https://github.com/mozilla/readability).
 *
 * Original Readability is licensed under the Apache License, Version 2.0,
 * Copyright (c) 2010 Arc90 Inc.
 *
 * Unlike the upstream library, this port operates on htmlparser2/domhandler
 * trees and does not mutate the input. It returns a Set of Elements from the
 * original tree that should be kept; callers use that set to skip non-article
 * content when generating the SDT, and selectors continue to resolve against
 * the original unfiltered document.
 *
 * Parts of Readability not needed for filtering (title/metadata/JSON-LD
 * extraction, URI normalization, class stripping, tag rewriting, lazy-image
 * fixups, script removal) are omitted; the subset preserved is:
 *   - REGEXPS and scoring constants
 *   - `_grabArticle` (unlikely-candidate pruning, scoring, top-candidate
 *     selection, sibling inclusion)
 *   - `_prepArticle` pruning passes (clean, cleanConditionally, cleanHeaders,
 *     cleanMatchedNodes, markDataTables)
 *   - three-flag demotion retry loop
 */

import type {ChildNode, DataNode, Element} from 'domhandler';
import {getElementChildren, getLocalName, isElement} from '../epub/xml';

// Flags & constants:

const FLAG_STRIP_UNLIKELYS = 0x1;
const FLAG_WEIGHT_CLASSES = 0x2;
const FLAG_CLEAN_CONDITIONALLY = 0x4;

const DEFAULT_N_TOP_CANDIDATES = 5;
const DEFAULT_CHAR_THRESHOLD = 500;

const REGEXPS = {
	unlikelyCandidates:
		/-ad-|ai2html|banner|breadcrumbs|combx|comment|community|cover-wrap|disqus|extra|footer|gdpr|header|legends|menu|related|remark|replies|rss|shoutbox|sidebar|skyscraper|social|sponsor|supplemental|ad-break|agegate|pagination|pager|popup|yom-remote/i,
	okMaybeItsACandidate: /and|article|body|column|content|main|mathjax|shadow/i,
	positive:
		/article|body|content|entry|hentry|h-entry|main|page|pagination|post|text|blog|story/i,
	negative:
		/-ad-|hidden|^hid$| hid$| hid |^hid |banner|combx|comment|com-|contact|footer|gdpr|masthead|media|meta|outbrain|promo|related|scroll|share|shoutbox|sidebar|skyscraper|sponsor|shopping|tags|widget/i,
	byline: /byline|author|dateline|writtenby|p-author/i,
	normalize: /\s{2,}/g,
	videos:
		/\/\/(www\.)?((dailymotion|youtube|youtube-nocookie|player\.vimeo|v\.qq|bilibili|live.bilibili)\.com|(archive|upload\.wikimedia)\.org|player\.twitch\.tv)/i,
	shareElements: /(\b|_)(share|sharedaddy)(\b|_)/i,
	hashUrl: /^#.+/,
	commas: /[,،﹐︐︑⹁⸴⸲，]/g,
	adWords: /^(ad(vertising|vertisement)?|pub(licité)?|werb(ung)?|广告|Реклама|Anuncio)$/iu,
	loadingWords: /^((loading|正在加载|Загрузка|chargement|cargando)(…|\.\.\.)?)$/iu,
};

// Local names (lowercase) to score by default.
const DEFAULT_TAGS_TO_SCORE = new Set([
	'section', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'td', 'pre',
]);

const DIV_TO_P_ELEMS = new Set([
	'blockquote', 'dl', 'div', 'img', 'ol', 'p', 'pre', 'table', 'ul',
]);

const UNLIKELY_ROLES = new Set([
	'menu', 'menubar', 'complementary', 'navigation', 'alert', 'alertdialog', 'dialog',
]);

// Context:

interface NodeMeta {
	contentScore: number;
}

interface GrabContext {
	body: Element;
	flags: number;
	// Scoring metadata per element.
	meta: Map<Element, NodeMeta>;
	// Elements pruned during phase 1 or later cleanup. They and their
	// descendants are treated as absent from the tree.
	excluded: Set<Element>;
	// DIVs that should be scored as if they were P (mirrors upstream's
	// div-to-p conversion).
	effectiveAsP: Set<Element>;
	// Tables classified as 'data' tables (preserved during conditional cleanup).
	dataTable: Map<Element, boolean>;
}

// Public entrypoint:

/**
 * Compute the Readability "article" subset of `body`. Returns a Set of elements
 * from the original tree that should be kept. Text nodes are considered kept
 * iff their immediate Element parent is in the returned Set.
 *
 * Returns null when no meaningful article content could be identified after
 * all retry demotions. Callers should fall back to an alternative (or no-op)
 * filtering method in that case.
 */
export function filterForReadability(body: Element): Set<Element> | null {
	let flags = FLAG_STRIP_UNLIKELYS | FLAG_WEIGHT_CLASSES | FLAG_CLEAN_CONDITIONALLY;
	let attempts: Array<{ kept: Set<Element>; textLength: number }> = [];

	while (true) {
		let kept = grabArticle(body, flags);
		let textLength = kept ? measureKeptText(kept) : 0;

		if (kept && textLength >= DEFAULT_CHAR_THRESHOLD) {
			return kept;
		}

		attempts.push({ kept: kept || new Set(), textLength });

		if (flags & FLAG_STRIP_UNLIKELYS) {
			flags &= ~FLAG_STRIP_UNLIKELYS;
		}
		else if (flags & FLAG_WEIGHT_CLASSES) {
			flags &= ~FLAG_WEIGHT_CLASSES;
		}
		else if (flags & FLAG_CLEAN_CONDITIONALLY) {
			flags &= ~FLAG_CLEAN_CONDITIONALLY;
		}
		else {
			attempts.sort((a, b) => b.textLength - a.textLength);
			if (!attempts[0].textLength) return null;
			return attempts[0].kept;
		}
	}
}

/**
 * Check whether `el` and all its ancestors up to `body` are in the kept set.
 * Callers use this to determine which elements to keep during SDT traversal.
 */
export function isInKeptSetIncludingAncestors(
	el: Element,
	body: Element,
	kept: Set<Element>,
): boolean {
	let current: Element | null = el;
	while (current && current !== body) {
		if (!kept.has(current)) return false;
		let parent = current.parent;
		if (!parent || !isElement(parent as ChildNode)) return true;
		current = parent as Element;
	}
	return true;
}

// Top-level algorithm:

function grabArticle(body: Element, flags: number): Set<Element> | null {
	let ctx: GrabContext = {
		body,
		flags,
		meta: new Map(),
		excluded: new Set(),
		effectiveAsP: new Set(),
		dataTable: new Map(),
	};

	let stripUnlikelys = (flags & FLAG_STRIP_UNLIKELYS) !== 0;
	let elementsToScore: Element[] = [];

	// Phase 1: walk the tree, prune cruft, collect scorable elements.
	walkPhase1(ctx, body, stripUnlikelys, elementsToScore);

	// Phase 2: score elementsToScore, propagating to ancestors.
	let candidates = scoreElements(ctx, elementsToScore);

	// Phase 3: pick top candidate, apply parent promotion and sibling inclusion.
	let result = selectAndGatherArticle(ctx, candidates);
	if (!result) return null;

	let { kept } = result;

	// Phase 4: prepArticle cleanup passes over kept.
	prepArticle(ctx, kept);

	return kept;
}

// Phase 1: prune + collect elementsToScore:

function walkPhase1(
	ctx: GrabContext,
	body: Element,
	stripUnlikelys: boolean,
	elementsToScore: Element[],
): void {
	// Depth-first, but skip subtrees of pruned elements.
	let stack: Element[] = [body];
	while (stack.length) {
		let el = stack.pop()!;
		if (ctx.excluded.has(el)) continue;

		let lname = localName(el);
		let matchString = (getAttr(el, 'class') || '') + ' ' + (getAttr(el, 'id') || '');

		if (el !== body) {
			if (!isProbablyVisible(el)) {
				markExcluded(ctx, el);
				continue;
			}

			if (getAttr(el, 'aria-modal') === 'true' && getAttr(el, 'role') === 'dialog') {
				markExcluded(ctx, el);
				continue;
			}

			if (stripUnlikelys) {
				if (REGEXPS.unlikelyCandidates.test(matchString)
						&& !REGEXPS.okMaybeItsACandidate.test(matchString)
						&& !hasAncestorTag(el, 'table', Infinity, ctx)
						&& !hasAncestorTag(el, 'code', Infinity, ctx)
						&& lname !== 'a') {
					markExcluded(ctx, el);
					continue;
				}

				let role = getAttr(el, 'role');
				if (role && UNLIKELY_ROLES.has(role)) {
					markExcluded(ctx, el);
					continue;
				}
			}

			if ((lname === 'div' || lname === 'section' || lname === 'header'
					|| lname === 'h1' || lname === 'h2' || lname === 'h3'
					|| lname === 'h4' || lname === 'h5' || lname === 'h6')
					&& isElementWithoutContent(el)) {
				markExcluded(ctx, el);
				continue;
			}

			if (DEFAULT_TAGS_TO_SCORE.has(lname)) {
				elementsToScore.push(el);
			}

			if (lname === 'div') {
				// Mirror upstream's DIV-to-P logic for scoring purposes (without
				// actually mutating the tree). A DIV with no block children is
				// treated as a P; a DIV whose sole child is a P uses that child.
				if (hasSingleTagInsideElement(el, 'p', ctx) && getLinkDensity(ctx, el) < 0.25) {
					let child = firstElementChild(el, ctx);
					if (child) elementsToScore.push(child);
				}
				else if (!hasChildBlockElement(el, ctx)) {
					ctx.effectiveAsP.add(el);
					elementsToScore.push(el);
				}
			}
		}

		// Push children in reverse so we pop in document order.
		let children = getElementChildren(el);
		for (let i = children.length - 1; i >= 0; i--) {
			stack.push(children[i]);
		}
	}
}

// Phase 2: scoring:

function scoreElements(
	ctx: GrabContext,
	elementsToScore: Element[],
): Element[] {
	let candidates: Element[] = [];

	for (let el of elementsToScore) {
		if (ctx.excluded.has(el)) continue;
		let parent = el.parent;
		if (!parent || !isElement(parent as ChildNode)) continue;

		let innerText = getInnerText(ctx, el, true);
		if (innerText.length < 25) continue;

		let ancestors = getNodeAncestors(el, 5);
		if (ancestors.length === 0) continue;

		let contentScore = 1
			+ innerText.split(REGEXPS.commas).length
			+ Math.min(Math.floor(innerText.length / 100), 3);

		for (let level = 0; level < ancestors.length; level++) {
			let ancestor = ancestors[level];
			if (ctx.excluded.has(ancestor)) continue;
			if (!ancestor.parent || !isElement(ancestor.parent as ChildNode)) continue;

			if (!ctx.meta.has(ancestor)) {
				initializeNode(ctx, ancestor);
				candidates.push(ancestor);
			}

			let divisor = level === 0 ? 1 : level === 1 ? 2 : level * 3;
			ctx.meta.get(ancestor)!.contentScore += contentScore / divisor;
		}
	}

	return candidates;
}

// Phase 3: candidate selection + sibling inclusion:

function selectAndGatherArticle(
	ctx: GrabContext,
	candidates: Element[],
): { kept: Set<Element> } | null {
	// Scale each candidate's score by (1 - linkDensity); maintain the top N.
	let topCandidates: Element[] = [];
	for (let candidate of candidates) {
		let meta = ctx.meta.get(candidate)!;
		meta.contentScore = meta.contentScore * (1 - getLinkDensity(ctx, candidate));

		for (let t = 0; t < DEFAULT_N_TOP_CANDIDATES; t++) {
			let existing = topCandidates[t];
			let existingScore = existing ? ctx.meta.get(existing)!.contentScore : -Infinity;
			if (!existing || meta.contentScore > existingScore) {
				topCandidates.splice(t, 0, candidate);
				if (topCandidates.length > DEFAULT_N_TOP_CANDIDATES) topCandidates.pop();
				break;
			}
		}
	}

	let topCandidate: Element | null = topCandidates[0] || null;

	if (!topCandidate || topCandidate === ctx.body) {
		// Fall back to the whole body.
		let kept = new Set<Element>();
		kept.add(ctx.body);
		addSubtreeToKept(ctx, ctx.body, kept);
		return { kept };
	}

	// Parent promotion if ≥3 alternate candidates share an ancestor.
	let altAncestors: Element[][] = [];
	for (let i = 1; i < topCandidates.length; i++) {
		let tcScore = ctx.meta.get(topCandidate)!.contentScore;
		let altScore = ctx.meta.get(topCandidates[i])!.contentScore;
		if (tcScore > 0 && altScore / tcScore >= 0.75) {
			altAncestors.push(getNodeAncestors(topCandidates[i], 0));
		}
	}
	let MIN = 3;
	let parentOfTopCandidate: Element | null = parentElement(topCandidate);
	if (altAncestors.length >= MIN) {
		while (parentOfTopCandidate && parentOfTopCandidate !== ctx.body) {
			let hits = 0;
			for (let i = 0; i < altAncestors.length && hits < MIN; i++) {
				if (altAncestors[i].includes(parentOfTopCandidate)) hits++;
			}
			if (hits >= MIN) {
				topCandidate = parentOfTopCandidate;
				break;
			}
			parentOfTopCandidate = parentElement(parentOfTopCandidate);
		}
	}

	if (!ctx.meta.has(topCandidate)) initializeNode(ctx, topCandidate);

	// Walk upward while the parent's score keeps improving.
	parentOfTopCandidate = parentElement(topCandidate);
	let lastScore = ctx.meta.get(topCandidate)!.contentScore;
	let scoreThreshold = lastScore / 3;
	while (parentOfTopCandidate && parentOfTopCandidate !== ctx.body) {
		let parentMeta = ctx.meta.get(parentOfTopCandidate);
		if (!parentMeta) {
			parentOfTopCandidate = parentElement(parentOfTopCandidate);
			continue;
		}
		let parentScore = parentMeta.contentScore;
		if (parentScore < scoreThreshold) break;
		if (parentScore > lastScore) {
			topCandidate = parentOfTopCandidate;
			break;
		}
		lastScore = parentScore;
		parentOfTopCandidate = parentElement(parentOfTopCandidate);
	}

	// If top candidate is the only child of its parent, promote the parent.
	parentOfTopCandidate = parentElement(topCandidate);
	while (parentOfTopCandidate && parentOfTopCandidate !== ctx.body
			&& getElementChildren(parentOfTopCandidate).filter(c => !ctx.excluded.has(c)).length === 1) {
		topCandidate = parentOfTopCandidate;
		parentOfTopCandidate = parentElement(topCandidate);
	}

	if (!ctx.meta.has(topCandidate)) initializeNode(ctx, topCandidate);

	// Sibling inclusion.
	let kept = new Set<Element>();
	let tcMeta = ctx.meta.get(topCandidate)!;
	let siblingScoreThreshold = Math.max(10, tcMeta.contentScore * 0.2);
	let parent = parentElement(topCandidate);
	if (!parent) {
		addSubtreeToKept(ctx, topCandidate, kept);
		return { kept };
	}

	let siblings = getElementChildren(parent);
	for (let sibling of siblings) {
		if (ctx.excluded.has(sibling)) continue;
		let append = false;
		if (sibling === topCandidate) {
			append = true;
		}
		else {
			let contentBonus = 0;
			let tcClass = getAttr(topCandidate, 'class') || '';
			let sibClass = getAttr(sibling, 'class') || '';
			if (sibClass === tcClass && tcClass !== '') {
				contentBonus += tcMeta.contentScore * 0.2;
			}
			let sibMeta = ctx.meta.get(sibling);
			if (sibMeta && sibMeta.contentScore + contentBonus >= siblingScoreThreshold) {
				append = true;
			}
			else if (localName(sibling) === 'p') {
				let linkDensity = getLinkDensity(ctx, sibling);
				let nodeContent = getInnerText(ctx, sibling, true);
				let nodeLength = nodeContent.length;
				if (nodeLength > 80 && linkDensity < 0.25) {
					append = true;
				}
				else if (nodeLength < 80 && nodeLength > 0 && linkDensity === 0
						&& /\.( |$)/.test(nodeContent)) {
					append = true;
				}
			}
		}
		if (append) {
			// Siblings that aren't in ALTER_TO_DIV_EXCEPTIONS are "altered to
			// div" upstream so later conditional cleanup doesn't target them.
			// We approximate that by giving them a forgiving class that
			// cleanConditionally's tag targeting can't reach. (They're added to
			// kept but their tag-name-matched removal still applies. Mirroring
			// upstream's behavior minus the tag rewrite is closer to the
			// no-op end of behavior here since we only clean specific tags).
			addSubtreeToKept(ctx, sibling, kept);
		}
	}

	return { kept };
}

function addSubtreeToKept(ctx: GrabContext, root: Element, kept: Set<Element>): void {
	if (ctx.excluded.has(root)) return;
	kept.add(root);
	for (let child of getElementChildren(root)) {
		addSubtreeToKept(ctx, child, kept);
	}
}

// Phase 4: prepArticle:

function prepArticle(ctx: GrabContext, kept: Set<Element>): void {
	markDataTables(ctx, kept);

	cleanConditionally(ctx, kept, 'form');
	cleanConditionally(ctx, kept, 'fieldset');
	cleanTag(ctx, kept, 'object');
	cleanTag(ctx, kept, 'embed');
	cleanTag(ctx, kept, 'footer');
	cleanTag(ctx, kept, 'link');
	cleanTag(ctx, kept, 'aside');

	// Share-widget cleanup: iterate top-level children of the article and prune
	// descendants whose class/id smells sharey and whose text is short.
    for (let el of Array.from(kept)) {
		if (!kept.has(el)) continue;
		// Only apply this on descendants of kept roots. We don't have an
		// explicit "articleContent wrapper" so run it over everything in kept.
		// (Upstream iterates articleContent.children; we approximate by running
		// once over the full kept set which gives the same net pruning.)
		let matchString = (getAttr(el, 'class') || '') + ' ' + (getAttr(el, 'id') || '');
		if (REGEXPS.shareElements.test(matchString)
				&& textContent(ctx, el).length < DEFAULT_CHAR_THRESHOLD) {
			removeFromKept(ctx, el, kept);
		}
	}

	cleanTag(ctx, kept, 'iframe');
	cleanTag(ctx, kept, 'input');
	cleanTag(ctx, kept, 'textarea');
	cleanTag(ctx, kept, 'select');
	cleanTag(ctx, kept, 'button');

	cleanHeaders(ctx, kept);

	cleanConditionally(ctx, kept, 'table');
	cleanConditionally(ctx, kept, 'ul');
	cleanConditionally(ctx, kept, 'div');
}

function cleanTag(ctx: GrabContext, kept: Set<Element>, tag: string): void {
	let isEmbed = tag === 'object' || tag === 'embed' || tag === 'iframe';
	for (let el of Array.from(kept)) {
		if (!kept.has(el)) continue;
		if (localName(el) !== tag) continue;
		if (isEmbed) {
			let hasVideo = false;
			let attribs = el.attribs || {};
			for (let name of Object.keys(attribs)) {
				if (REGEXPS.videos.test(attribs[name])) { hasVideo = true; break; }
			}
			if (!hasVideo && tag === 'object') {
				// Approximate upstream's innerHTML check by inspecting descendant
				// attribute values too.
				for (let descendant of descendants(el)) {
					let ds = descendant.attribs || {};
					for (let name of Object.keys(ds)) {
						if (REGEXPS.videos.test(ds[name])) { hasVideo = true; break; }
					}
					if (hasVideo) break;
				}
			}
			if (hasVideo) continue;
		}
		removeFromKept(ctx, el, kept);
	}
}

function cleanHeaders(ctx: GrabContext, kept: Set<Element>): void {
	for (let el of Array.from(kept)) {
		if (!kept.has(el)) continue;
		let lname = localName(el);
		if (lname !== 'h1' && lname !== 'h2') continue;
		if (getClassWeight(ctx, el) < 0) {
			removeFromKept(ctx, el, kept);
		}
	}
}

function cleanConditionally(
	ctx: GrabContext,
	kept: Set<Element>,
	tag: string,
): void {
	if (!(ctx.flags & FLAG_CLEAN_CONDITIONALLY)) return;

	// Iterate a snapshot; cleaning may remove elements from kept.
	for (let el of Array.from(kept)) {
		if (!kept.has(el)) continue;
		if (localName(el) !== tag) continue;

		let isList = tag === 'ul' || tag === 'ol';
		if (!isList) {
			let listTextLen = 0;
			for (let list of descendantsByTag(el, ['ul', 'ol'])) {
				listTextLen += textContent(ctx, list).length;
			}
			let total = textContent(ctx, el).length;
			isList = total > 0 && listTextLen / total > 0.9;
		}

		if (tag === 'table' && ctx.dataTable.get(el)) continue;

		// Inside a data table? Don't remove.
		if (hasAncestorTag(el, 'table', Infinity, ctx, a => !!ctx.dataTable.get(a))) continue;
		if (hasAncestorTag(el, 'code', Infinity, ctx)) continue;

		// Contains a data table? Don't remove.
		let containsDataTable = false;
		for (let tbl of descendantsByTag(el, ['table'])) {
			if (ctx.dataTable.get(tbl)) { containsDataTable = true; break; }
		}
		if (containsDataTable) continue;

		let weight = getClassWeight(ctx, el);
		if (weight < 0) {
			removeFromKept(ctx, el, kept);
			continue;
		}

		if (getCharCount(ctx, el, ',') >= 10) continue;

		let p = descendantsByTag(el, ['p']).length;
		let img = descendantsByTag(el, ['img']).length;
		let li = descendantsByTag(el, ['li']).length - 100;
		let input = descendantsByTag(el, ['input']).length;
		let headingDensity = getTextDensity(ctx, el, ['h1','h2','h3','h4','h5','h6']);

		let embedCount = 0;
		let embedKeepsIt = false;
		for (let em of descendantsByTag(el, ['object', 'embed', 'iframe'])) {
			let attribs = em.attribs || {};
			let matched = false;
			for (let name of Object.keys(attribs)) {
				if (REGEXPS.videos.test(attribs[name])) { matched = true; break; }
			}
			if (matched) { embedKeepsIt = true; break; }
			embedCount++;
		}
		if (embedKeepsIt) continue;

		let innerText = getInnerText(ctx, el, true);
		if (REGEXPS.adWords.test(innerText) || REGEXPS.loadingWords.test(innerText)) {
			removeFromKept(ctx, el, kept);
			continue;
		}

		let contentLength = innerText.length;
		let linkDensity = getLinkDensity(ctx, el);
		let textishTags = ['span', 'li', 'td', ...DIV_TO_P_ELEMS];
		let textDensity = getTextDensity(ctx, el, textishTags);
		let isFigureChild = hasAncestorTag(el, 'figure', Infinity, ctx);

		let errs: string[] = [];
		if (!isFigureChild && img > 1 && p / img < 0.5) {
			errs.push('bad p/img');
		}
		if (!isList && li > p) {
			errs.push('too many li');
		}
		if (input > Math.floor(p / 3)) {
			errs.push('too many inputs');
		}
		if (!isList && !isFigureChild && headingDensity < 0.9 && contentLength < 25
				&& (img === 0 || img > 2) && linkDensity > 0) {
			errs.push('suspiciously short');
		}
		if (!isList && weight < 25 && linkDensity > 0.2) {
			errs.push('low-weight linky');
		}
		if (weight >= 25 && linkDensity > 0.5) {
			errs.push('high-weight linky');
		}
		if ((embedCount === 1 && contentLength < 75) || embedCount > 1) {
			errs.push('suspicious embed');
		}
		if (img === 0 && textDensity === 0) {
			errs.push('no useful content');
		}

		let haveToRemove = errs.length > 0;

		if (isList && haveToRemove) {
			let simple = true;
			for (let child of getElementChildren(el)) {
				if (ctx.excluded.has(child)) continue;
				let cc = getElementChildren(child).filter(c => !ctx.excluded.has(c));
				if (cc.length > 1) { simple = false; break; }
			}
			if (simple) {
				let liCount = descendantsByTag(el, ['li']).length;
				if (img === liCount) haveToRemove = false;
			}
		}

		if (haveToRemove) removeFromKept(ctx, el, kept);
	}
}

function markDataTables(ctx: GrabContext, kept: Set<Element>): void {
	for (let el of kept) {
		if (localName(el) !== 'table') continue;
		let role = getAttr(el, 'role');
		if (role === 'presentation') { ctx.dataTable.set(el, false); continue; }
		let datatable = getAttr(el, 'datatable');
		if (datatable === '0') { ctx.dataTable.set(el, false); continue; }
		if (getAttr(el, 'summary')) { ctx.dataTable.set(el, true); continue; }
		let captions = descendantsByTag(el, ['caption']);
		if (captions.length && (captions[0].children || []).length) {
			ctx.dataTable.set(el, true);
			continue;
		}
		let dataDescendants = ['col', 'colgroup', 'tfoot', 'thead', 'th'];
		let hasDataDescendant = false;
		for (let tag of dataDescendants) {
			if (descendantsByTag(el, [tag]).length) { hasDataDescendant = true; break; }
		}
		if (hasDataDescendant) { ctx.dataTable.set(el, true); continue; }
		// Nested tables → layout.
		if (descendantsByTag(el, ['table']).length) { ctx.dataTable.set(el, false); continue; }

		let { rows, columns } = getRowAndColumnCount(el);
		if (rows === 1 || columns === 1) { ctx.dataTable.set(el, false); continue; }
		if (rows >= 10 || columns > 4) { ctx.dataTable.set(el, true); continue; }
		ctx.dataTable.set(el, rows * columns > 10);
	}
}

function getRowAndColumnCount(table: Element): { rows: number; columns: number } {
	let rows = 0;
	let columns = 0;
	for (let tr of descendantsByTag(table, ['tr'])) {
		let rowspan = parseInt(getAttr(tr, 'rowspan') || '', 10);
		rows += isFinite(rowspan) && rowspan > 0 ? rowspan : 1;
		let columnsInRow = 0;
		for (let cell of descendantsByTag(tr, ['td'])) {
			let colspan = parseInt(getAttr(cell, 'colspan') || '', 10);
			columnsInRow += isFinite(colspan) && colspan > 0 ? colspan : 1;
		}
		columns = Math.max(columns, columnsInRow);
	}
	return { rows, columns };
}

// Removal helpers:

function markExcluded(ctx: GrabContext, el: Element): void {
	ctx.excluded.add(el);
	for (let child of getElementChildren(el)) {
		markExcluded(ctx, child);
	}
}

function removeFromKept(ctx: GrabContext, el: Element, kept: Set<Element>): void {
	kept.delete(el);
	ctx.excluded.add(el);
	for (let child of getElementChildren(el)) {
		removeFromKept(ctx, child, kept);
	}
}

// Predicates & metrics:

function initializeNode(ctx: GrabContext, el: Element): NodeMeta {
	let meta: NodeMeta = { contentScore: 0 };
	ctx.meta.set(el, meta);

	let lname = ctx.effectiveAsP.has(el) ? 'p' : localName(el);
	switch (lname) {
		case 'div':
			meta.contentScore += 5;
			break;
		case 'pre':
		case 'td':
		case 'blockquote':
			meta.contentScore += 3;
			break;
		case 'address':
		case 'ol':
		case 'ul':
		case 'dl':
		case 'dd':
		case 'dt':
		case 'li':
		case 'form':
			meta.contentScore -= 3;
			break;
		case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
		case 'th':
			meta.contentScore -= 5;
			break;
	}
	meta.contentScore += getClassWeight(ctx, el);
	return meta;
}

function getClassWeight(ctx: GrabContext, el: Element): number {
	if (!(ctx.flags & FLAG_WEIGHT_CLASSES)) return 0;
	let weight = 0;
	let className = getAttr(el, 'class') || '';
	if (className) {
		if (REGEXPS.negative.test(className)) weight -= 25;
		if (REGEXPS.positive.test(className)) weight += 25;
	}
	let id = getAttr(el, 'id') || '';
	if (id) {
		if (REGEXPS.negative.test(id)) weight -= 25;
		if (REGEXPS.positive.test(id)) weight += 25;
	}
	return weight;
}

function getLinkDensity(ctx: GrabContext, el: Element): number {
	let textLen = getInnerText(ctx, el, true).length;
	if (textLen === 0) return 0;
	let linkLen = 0;
	for (let a of descendantsByTag(el, ['a'])) {
		let href = getAttr(a, 'href');
		let coef = href && REGEXPS.hashUrl.test(href) ? 0.3 : 1;
		linkLen += getInnerText(ctx, a, true).length * coef;
	}
	return linkLen / textLen;
}

function getTextDensity(ctx: GrabContext, el: Element, tags: string[]): number {
	let total = getInnerText(ctx, el, true).length;
	if (total === 0) return 0;
	let childLen = 0;
	for (let child of descendantsByTag(el, tags)) {
		childLen += getInnerText(ctx, child, true).length;
	}
	return childLen / total;
}

function getCharCount(ctx: GrabContext, el: Element, s: string): number {
	return getInnerText(ctx, el, true).split(s).length - 1;
}

function getInnerText(ctx: GrabContext, el: Element, normalize: boolean): string {
	let text = textContent(ctx, el).trim();
	if (normalize) text = text.replace(REGEXPS.normalize, ' ');
	return text;
}

function textContent(ctx: GrabContext, el: Element): string {
	if (ctx.excluded.has(el)) return '';
	let parts: string[] = [];
	for (let child of el.children || []) {
		if (child.type === 'text') {
			parts.push((child as DataNode).data || '');
		}
		else if (isElement(child)) {
			parts.push(textContent(ctx, child));
		}
	}
	return parts.join('');
}

function isElementWithoutContent(el: Element): boolean {
	let textish = ((el.children || []) as ChildNode[])
		.filter(c => c.type === 'text')
		.map(c => (c as DataNode).data || '')
		.join('');
	if (textish.trim().length > 0) return false;
	let elementChildren = getElementChildren(el);
	if (elementChildren.length === 0) return true;
	let brOrHr = elementChildren.filter(c => {
		let n = localName(c);
		return n === 'br' || n === 'hr';
	});
	return elementChildren.length === brOrHr.length;
}

function hasChildBlockElement(el: Element, ctx: GrabContext): boolean {
	for (let child of el.children || []) {
		if (!isElement(child)) continue;
		let e = child as Element;
		if (ctx.excluded.has(e)) continue;
		if (DIV_TO_P_ELEMS.has(localName(e))) return true;
		if (hasChildBlockElement(e, ctx)) return true;
	}
	return false;
}

function hasSingleTagInsideElement(el: Element, tag: string, ctx: GrabContext): boolean {
	let elementChildren = getElementChildren(el).filter(c => !ctx.excluded.has(c));
	if (elementChildren.length !== 1 || localName(elementChildren[0]) !== tag) return false;
	// No meaningful text among direct children.
	for (let child of el.children || []) {
		if (child.type === 'text' && /\S$/.test((child as DataNode).data || '')) return false;
	}
	return true;
}

function isProbablyVisible(el: Element): boolean {
	// We don't have computed style; approximate using the style attribute and hidden attributes.
	let style = getAttr(el, 'style') || '';
	if (/display\s*:\s*none/i.test(style)) return false;
	if (/visibility\s*:\s*hidden/i.test(style)) return false;
	if (el.attribs && 'hidden' in el.attribs) return false;
	if (getAttr(el, 'aria-hidden') === 'true') {
		let className = getAttr(el, 'class') || '';
		if (!className.includes('fallback-image')) return false;
	}
	return true;
}

function hasAncestorTag(
	el: Element,
	tag: string,
	maxDepth: number,
	ctx: GrabContext,
	filter?: (a: Element) => boolean,
): boolean {
	let depth = 0;
	let current: Element | null = parentElement(el);
	while (current) {
		if (maxDepth > 0 && depth >= maxDepth) return false;
		if (ctx.excluded.has(current)) return false;
		if (localName(current) === tag && (!filter || filter(current))) return true;
		current = parentElement(current);
		depth++;
	}
	return false;
}

function getNodeAncestors(el: Element, maxDepth: number): Element[] {
	let ancestors: Element[] = [];
	let current: Element | null = parentElement(el);
	let i = 0;
	while (current) {
		ancestors.push(current);
		if (maxDepth && ++i === maxDepth) break;
		current = parentElement(current);
	}
	return ancestors;
}

function parentElement(el: Element): Element | null {
	let parent = el.parent;
	if (parent && isElement(parent as ChildNode)) return parent as Element;
	return null;
}

function firstElementChild(el: Element, ctx: GrabContext): Element | null {
	for (let child of el.children || []) {
		if (isElement(child) && !ctx.excluded.has(child)) return child as Element;
	}
	return null;
}

function descendants(root: Element): Element[] {
	let out: Element[] = [];
	function walk(el: Element) {
		for (let child of el.children || []) {
			if (!isElement(child)) continue;
			out.push(child);
			walk(child);
		}
	}
	walk(root);
	return out;
}

function descendantsByTag(root: Element, tags: string[]): Element[] {
	let lowerTags = tags.map(t => t.toLowerCase());
	let out: Element[] = [];
	function walk(el: Element) {
		for (let child of el.children || []) {
			if (!isElement(child)) continue;
			let c = child as Element;
			if (lowerTags.includes(localName(c))) out.push(c);
			walk(c);
		}
	}
	walk(root);
	return out;
}

function localName(el: Element): string {
	return getLocalName(el).toLowerCase();
}

function getAttr(el: Element, name: string): string | null {
	return name in el.attribs ? el.attribs[name] : null;
}

// Final text measurement:

function measureKeptText(kept: Set<Element>): number {
	let out = 0;
	for (let el of kept) {
		for (let child of el.children || []) {
			if (child.type === 'text') {
				out += ((child as DataNode).data || '').length;
			}
		}
	}
	return out;
}

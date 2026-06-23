import { canCrossPagePartLink, resolveFlowClass } from './flow-policy.js';

const SENTENCE_END_MARKS = new Set(['.', '!', '?', '。', '！', '？']);

function getNodeText(node) {
	if (!node || typeof node !== 'object') {
		return '';
	}
	if (typeof node.text === 'string') {
		return node.text;
	}
	if (!Array.isArray(node.content)) {
		return '';
	}
	return node.content.map(getNodeText).join('');
}

function getListMarker(text) {
	const normalized = text.trimStart();
	if (!normalized) {
		return { family: 'none', kind: 'none', value: null };
	}

	if (/^[•‣◦▪▫●○◆◇■□*+\-–—]\s+/u.test(normalized)) {
		return { family: 'bullet', kind: 'bullet', value: null };
	}

	let match = normalized.match(/^\[\s*(\d{1,4})\s*\](?:[.:])?\s+/u);
	if (match) {
		return { family: 'ordered', kind: 'bracket-number', value: Number(match[1]) };
	}

	match = normalized.match(/^\[\s*([A-Za-z])\s*\](?:[.:])?\s+/u);
	if (match) {
		return { family: 'ordered', kind: 'bracket-letter', value: match[1].toLowerCase() };
	}

	match = normalized.match(/^\(\s*(\d{1,4})\s*\)\s+/u);
	if (match) {
		return { family: 'ordered', kind: 'paren-number', value: Number(match[1]) };
	}

	match = normalized.match(/^\(\s*([A-Za-z])\s*\)\s+/u);
	if (match) {
		return { family: 'ordered', kind: 'paren-letter', value: match[1].toLowerCase() };
	}

	match = normalized.match(/^(\d+(?:\.\d+)*)(?:[.)\]:：])\s+/u);
	if (match) {
		return { family: 'ordered', kind: 'delimited-number', value: Number(match[1].split('.')[0]) };
	}

	match = normalized.match(/^(\d{1,3})\s+/u);
	if (match) {
		return { family: 'ordered', kind: 'bare-number', value: Number(match[1]) };
	}

	return { family: 'none', kind: 'none', value: null };
}

function isValidRect(rect) {
	return Array.isArray(rect)
		&& rect.length >= 4
		&& rect.every(Number.isFinite)
		&& rect[2] >= rect[0]
		&& rect[3] >= rect[1];
}

function getProfileEm(profile) {
	const fontSize = Math.max(
		profile.firstCharFontSize || 0,
		profile.lastCharFontSize || 0
	);
	return fontSize > 0 ? fontSize : 10;
}

function getRailTolerance(first, second) {
	return Math.max(2, Math.max(getProfileEm(first), getProfileEm(second)) * 0.75);
}

function getLeft(profile) {
	return isValidRect(profile.rect) ? profile.rect[0] : null;
}

function getRight(profile) {
	return isValidRect(profile.rect) ? profile.rect[2] : null;
}

function sameRail(first, second) {
	const firstLeft = getLeft(first);
	const secondLeft = getLeft(second);
	if (firstLeft === null || secondLeft === null) {
		return true;
	}
	return Math.abs(firstLeft - secondLeft) <= getRailTolerance(first, second);
}

function isIndentedAfter(first, second) {
	const firstLeft = getLeft(first);
	const secondLeft = getLeft(second);
	if (firstLeft === null || secondLeft === null) {
		return false;
	}
	return secondLeft > firstLeft + getRailTolerance(first, second);
}

function startsLikeContinuation(profile) {
	const firstChar = profile.firstChar || '';
	return /^[\p{Ll}\p{Nd},;:)\]}]/u.test(firstChar);
}

function endsInFilledUnfinishedLine(profile, otherProfile) {
	const lastChar = profile.lastChar || '';
	if (!lastChar || SENTENCE_END_MARKS.has(lastChar)) {
		return false;
	}
	if (lastChar === '-') {
		return true;
	}
	return Number.isFinite(profile.lastLineRag)
		&& profile.lastLineRag <= getRailTolerance(profile, otherProfile);
}

function isSameOrNextValidPage(structure, first, second) {
	if (!first.metrics || !second.metrics) {
		return true;
	}
	if (structure) {
		return canCrossPagePartLink(structure, first.metrics, second.metrics);
	}
	return first.pageIndex === second.pageIndex;
}

function isSamePage(first, second) {
	return first.pageIndex == null
		|| second.pageIndex == null
		|| first.pageIndex === second.pageIndex;
}

function isClearlyToTheLeft(first, second) {
	const firstLeft = getLeft(first);
	const secondRight = getRight(second);
	return firstLeft !== null && secondRight !== null && secondRight <= firstLeft;
}

function hasCompatibleFlow(first, second) {
	return first.flowClass === second.flowClass;
}

function hasCompatibleSiblingMarker(first, second) {
	if (first.marker.family === 'none' || second.marker.family === 'none') {
		return first.marker.family === 'none'
			&& second.marker.family === 'none';
	}
	if (first.marker.family !== second.marker.family) {
		return false;
	}
	if (first.marker.family === 'bullet') {
		return true;
	}
	return true;
}

export function getListItemProfile(block) {
	const metrics = block?._metrics || null;
	const text = getNodeText(block);
	return {
		block,
		text,
		marker: getListMarker(text),
		flowClass: resolveFlowClass(block),
		metrics,
		pageIndex: metrics?.pageIndex,
		rect: metrics?.rect || metrics?.bbox || null,
		firstChar: metrics?.firstChar || '',
		lastChar: metrics?.lastChar || '',
		firstCharFontSize: metrics?.firstCharFontSize || 0,
		lastCharFontSize: metrics?.lastCharFontSize || 0,
		lastLineRag: metrics?.lastLineRag,
	};
}

export function hasListItemMarker(block) {
	return getListItemProfile(block).marker.family !== 'none';
}

export function getListItemSiblingRelation(firstBlock, secondBlock) {
	const first = getListItemProfile(firstBlock);
	const second = getListItemProfile(secondBlock);

	if (!hasCompatibleFlow(first, second)) {
		return null;
	}
	if (!hasCompatibleSiblingMarker(first, second)) {
		return null;
	}
	return { type: 'sibling', first, second };
}

export function getListItemContinuationRelation(firstBlock, secondBlock, options = {}) {
	const first = getListItemProfile(firstBlock);
	const second = getListItemProfile(secondBlock);

	if (!hasCompatibleFlow(first, second)) {
		return null;
	}
	if (second.marker.family !== 'none') {
		return null;
	}
	if (!isSameOrNextValidPage(options.structure, first, second)) {
		return null;
	}
	if (isSamePage(first, second) && isClearlyToTheLeft(first, second)) {
		return null;
	}

	const indented = isIndentedAfter(first, second);
	const unfinished = endsInFilledUnfinishedLine(first, second);
	const pageContinues = first.pageIndex != null
		&& second.pageIndex != null
		&& second.pageIndex !== first.pageIndex;

	if (first.marker.family !== 'none') {
		if (indented || pageContinues) {
			return { type: 'continuation', first, second };
		}
		return null;
	}

	if (first.lastChar === '-' && startsLikeContinuation(second) && (sameRail(first, second) || indented)) {
		return { type: 'continuation', first, second };
	}

	if (unfinished && indented) {
		return { type: 'continuation', first, second };
	}

	return null;
}

export function getListItemLeadingContinuationRelation(firstBlock, secondBlock) {
	const first = getListItemProfile(firstBlock);
	const second = getListItemProfile(secondBlock);

	if (!hasCompatibleFlow(first, second)) {
		return null;
	}
	if (first.marker.family !== 'none' || second.marker.family === 'none') {
		return null;
	}
	if (isIndentedAfter(second, first) || startsLikeContinuation(first)) {
		return { type: 'leading-continuation', first, second };
	}
	return null;
}

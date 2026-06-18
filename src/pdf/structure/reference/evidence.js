import { tokenizeReferenceText } from './utils.js';
import {
	findSourceIdentifierEvidence,
	hasSourceIdentifierEvidence,
} from './source-identifiers.js';

const LEADING_LABEL_RE = /^\s*[\[\(\{]*\s*\d+\s*[\]\)\}\.:,-]*/;
const YEAR_RE = /(^|[^\d])(\d{4}[a-z]?)(?=$|[^\d])/ig;
const SOURCE_LOCATOR_RE = /(?:\b\d{1,4}\s*\(\s*\d{1,4}\s*\)|[;:]\s*[A-Za-z]?\d{1,8}(?:\s*[-–]\s*[A-Za-z]?\d{1,8})?|\b[A-Za-z]?\d{1,8}\s*[-–]\s*[A-Za-z]?\d{1,8}\b|\be\d{3,}\b)/i;

function countWords(text) {
	return tokenizeReferenceText(text).filter(token => /[\p{L}\p{N}]/u.test(token.text)).length;
}

function countBibliographicPunctuation(text) {
	return (text.match(/[.,;:]/g) || []).length;
}

function getLeadingLabel(text) {
	const match = text.match(LEADING_LABEL_RE);
	if (!match) {
		return null;
	}
	return /\d/.test(match[0]) ? match[0] : null;
}

function getYearMatches(text) {
	const years = [];
	let match;
	YEAR_RE.lastIndex = 0;
	while ((match = YEAR_RE.exec(text)) !== null) {
		const yearText = match[2];
		const year = parseInt(yearText.slice(0, 4), 10);
		if (year < 1800 || year > new Date().getFullYear()) {
			continue;
		}
		const start = match.index + match[1].length;
		years.push({
			text: yearText,
			start,
			end: start + yearText.length,
		});
	}
	return years;
}

function hasTitleTailAfterYear(text, yearEnd) {
	const rawTail = text.slice(yearEnd);
	const tail = rawTail.replace(/^[\s)\]}]+/, '');
	if (!/^[.;:]/.test(tail)) {
		return false;
	}
	const wordsAfterSeparator = tail.replace(/^[.;:\s]+/, '');
	return countWords(wordsAfterSeparator) >= 2;
}

function hasSourceLocatorAfterYear(text, yearEnd) {
	return SOURCE_LOCATOR_RE.test(text.slice(yearEnd));
}

function isInsideDelimitedGroup(text, offset) {
	const before = text.slice(0, offset);
	return before.lastIndexOf('(') > before.lastIndexOf(')')
		|| before.lastIndexOf('[') > before.lastIndexOf(']');
}

function hasTerminalYearSourceShape(text, yearStart) {
	if (isInsideDelimitedGroup(text, yearStart)) {
		return false;
	}
	const beforeYear = text.slice(0, yearStart);
	return countWords(beforeYear) >= 4 && countBibliographicPunctuation(beforeYear) >= 2;
}

function hasBibliographicIdentifierContext(text) {
	const identifier = findSourceIdentifierEvidence(text);
	if (!identifier) {
		return false;
	}
	const beforeIdentifier = text.slice(0, identifier.start);
	return countWords(beforeIdentifier) >= 3
		&& countBibliographicPunctuation(beforeIdentifier) >= 2;
}

export function getReferenceSourceEvidence(text, { leadMaxWords = 12 } = {}) {
	const normalized = (text || '').trim();
	const years = getYearMatches(normalized);
	const hasIdentifier = hasSourceIdentifierEvidence(normalized);
	const hasBibliographicIdentifier = hasBibliographicIdentifierContext(normalized);
	const hasLabel = !!getLeadingLabel(normalized);
	let hasLeadYear = false;
	let hasSourceLocator = SOURCE_LOCATOR_RE.test(normalized);
	let hasTitleTail = false;
	let hasTerminalYearShape = false;

	for (const year of years) {
		if (hasLabel || countWords(normalized.slice(0, year.start)) <= leadMaxWords) {
			hasLeadYear = true;
		}
		hasSourceLocator ||= hasSourceLocatorAfterYear(normalized, year.end);
		hasTitleTail ||= hasTitleTailAfterYear(normalized, year.end);
		hasTerminalYearShape ||= year.end >= normalized.length - 2
			&& hasTerminalYearSourceShape(normalized, year.start);
	}

	const hasYear = years.length > 0;
	const hasSourceDetail = hasSourceLocator || hasTitleTail || hasTerminalYearShape;
	const isSourceLike = hasBibliographicIdentifier || (hasYear && hasSourceDetail);

	return {
		hasBibliographicIdentifier,
		hasIdentifier,
		hasLabel,
		hasLeadYear,
		hasSourceDetail,
		hasSourceLocator,
		hasTerminalYearShape,
		hasTitleTail,
		hasYear,
		isSourceLike,
	};
}

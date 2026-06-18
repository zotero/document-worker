import { tokenizeReferenceText } from './utils.js';
import { extractMatchableSourceIdentifiers } from './source-identifiers.js';

function isYearToken(text) {
	const match = text.match(/^(\d{4})([a-z])?$/i);
	if (!match) {
		return null;
	}
	const year = parseInt(match[1], 10);
	if (year < 1800 || year > new Date().getFullYear()) {
		return null;
	}
	return {
		year: match[1],
		suffix: match[2]?.toLowerCase() || null,
	};
}

function normalizeAuthorToken(text) {
	let normalized = text
		.normalize('NFKD')
		.replace(/^[^\p{L}\p{M}]+|[^\p{L}\p{M}]+$/gu, '')
		.toLowerCase();
	if (normalized.length < 2) {
		return null;
	}
	return normalized;
}

function stripLeadingLabel(text) {
	return text.replace(/^\s*[\[\(\{]*\s*\d+\s*[\]\)\}\.:,-]*/, '');
}

function findYear(tokens) {
	let years = [];
	for (let i = 0; i < tokens.length; i++) {
		const parsed = isYearToken(tokens[i].text);
		if (parsed) {
			years.push({ ...parsed, index: i });
		}
	}
	if (!years.length) {
		return null;
	}
	const modernYears = years.filter(year => parseInt(year.year, 10) >= 1900);
	return parseInt(years[0].year, 10) < 1900 && modernYears.length ? modernYears.at(-1) : years[0];
}

function getAuthorPrefix(text, tokens, yearIndex) {
	const yearOffset = Number.isInteger(yearIndex) ? tokens[yearIndex].offset : text.length;
	const beforeYear = text.slice(0, yearOffset).trim();
	for (const match of beforeYear.matchAll(/\.\s+/g)) {
		const authorTokens = tokenizeReferenceText(beforeYear.slice(0, match.index));
		const lastToken = authorTokens.at(-1)?.text || '';
		if (authorTokens.length > 1 || lastToken.length > 1) {
			return beforeYear.slice(0, match.index);
		}
	}
	return beforeYear;
}

const AUTHOR_TOKEN_CONNECTORS = new Set([
	'a', 'al', 'an', 'and', 'at', 'by', 'de', 'del', 'den', 'der', 'di', 'du',
	'et', 'for', 'from', 'in', 'la', 'le', 'of', 'on', 'or', 'the', 'to',
	'van', 'von', 'with',
]);

function startsLowercase(text) {
	for (const char of text) {
		if (/\p{L}/u.test(char)) {
			return char === char.toLowerCase();
		}
	}
	return false;
}

function isConnectorAuthorToken(prefix, token, value) {
	if (!AUTHOR_TOKEN_CONNECTORS.has(value)) {
		return false;
	}
	if (startsLowercase(token.text)) {
		return false;
	}
	const after = prefix.slice(token.offset + token.text.length).trimStart();
	return after.startsWith(',');
}

function getAuthorTokens(text, tokens, yearIndex, regularWordsSet) {
	const prefix = getAuthorPrefix(text, tokens, yearIndex);
	const values = [];
	const positions = new Map();
	const seen = new Set();
	for (const token of tokenizeReferenceText(prefix)) {
		const value = normalizeAuthorToken(token.text);
		if (
			!value
			|| (AUTHOR_TOKEN_CONNECTORS.has(value) && !isConnectorAuthorToken(prefix, token, value))
			|| (regularWordsSet?.has(value) && token.text[0] === token.text[0].toLowerCase())
		) {
			continue;
		}
		if (!seen.has(value)) {
			seen.add(value);
			positions.set(value, values.length);
			values.push(value);
		}
	}
	return { values, positions };
}

function getIdentifiers(text) {
	return extractMatchableSourceIdentifiers(text).map(({ type, value }) => ({ type, value }));
}

function authorYearValue(authorToken, year, suffix = null) {
	return suffix ? `${authorToken}|${year}${suffix}` : `${authorToken}|${year}`;
}

function addToMap(map, key, value) {
	if (!key) {
		return;
	}
	let values = map.get(key);
	if (!values) {
		values = [];
		map.set(key, values);
	}
	values.push(value);
}

function addKey(reference, key) {
	if (!key?.value) {
		return;
	}
	reference.keys.push(key);
}

function getBlockRefKey(blockRef) {
	return Array.isArray(blockRef) ? blockRef.join(',') : '';
}

export function parseReference(reference, regularWordsSet = new Set()) {
	const text = reference.text || '';
	const textWithoutLabel = stripLeadingLabel(text);
	const tokens = tokenizeReferenceText(textWithoutLabel);
	const year = findYear(tokens);
	const authorTokens = getAuthorTokens(textWithoutLabel, tokens, year?.index, regularWordsSet);

	reference.label = reference.id || null;
	reference.year = year?.year || null;
	reference.suffix = year?.suffix || null;
	reference.authorTokens = authorTokens.values;
	reference.authorTokenPositions = authorTokens.positions;
	reference.keys = [];

	if (reference.label) {
		addKey(reference, { type: 'number', value: reference.label });
	}
	if (reference.year) {
		for (const authorToken of reference.authorTokens) {
			addKey(reference, {
				type: 'authorYear',
				value: authorYearValue(authorToken, reference.year, reference.suffix),
				authorToken,
			});
		}
	}
	for (const key of getIdentifiers(text)) {
		addKey(reference, key);
	}

	return reference;
}

export function getReferenceIndex(referenceLists, regularWordsSet = new Set()) {
	const index = {
		runs: referenceLists,
		entries: [],
		number: new Map(),
		authorYear: new Map(),
		identity: new Map(),
		identifier: new Map(),
		authorTokens: new Set(),
		referenceBlocks: new Set(),
		entryByBlock: new Map(),
	};

	for (const referenceList of referenceLists) {
		index.referenceBlocks.add(getBlockRefKey(referenceList.ref));
		for (const blockRef of referenceList.blockRefs || []) {
			index.referenceBlocks.add(getBlockRefKey(blockRef));
		}
		for (const reference of referenceList.references) {
			parseReference(reference, regularWordsSet);
			reference.run = referenceList;
			index.entries.push(reference);
			index.referenceBlocks.add(getBlockRefKey(reference.src.blockRef));
			index.entryByBlock.set(getBlockRefKey(reference.src.blockRef), reference);
			for (const blockRef of reference.continuationBlockRefs || []) {
				index.referenceBlocks.add(getBlockRefKey(blockRef));
				index.entryByBlock.set(getBlockRefKey(blockRef), reference);
			}
			for (const authorToken of reference.authorTokens) {
				index.authorTokens.add(authorToken);
				addToMap(index.identity, authorToken, reference);
			}
			for (const key of reference.keys) {
				addToMap(index[key.type], key.value, reference);
			}
		}
	}

	return index;
}

export function isReferenceBlock(referenceIndex, blockRef) {
	if (!Array.isArray(blockRef)) {
		return false;
	}
	for (const run of referenceIndex.runs) {
		if (blockRef[0] === run.ref[0]) {
			return true;
		}
	}
	return referenceIndex.referenceBlocks.has(getBlockRefKey(blockRef));
}

export function getReferenceForBlock(referenceIndex, blockRef) {
	if (!Array.isArray(blockRef)) {
		return null;
	}
	for (let length = blockRef.length; length >= 1; length--) {
		const reference = referenceIndex.entryByBlock.get(getBlockRefKey(blockRef.slice(0, length)));
		if (reference) {
			return reference;
		}
	}
	return null;
}

export function getAuthorYearValue(authorToken, year, suffix = null) {
	return authorYearValue(authorToken, year, suffix);
}

export function normalizeReferenceAuthorToken(text) {
	return normalizeAuthorToken(text);
}

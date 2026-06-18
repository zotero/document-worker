const DOI_RE = /\b(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)?(10\.\d{4,9}\/[-._;()/:A-Z0-9]+)/ig;
const ARXIV_RE = /\barxiv:\s*([a-z-]+\/\d{7}|\d{4}\.\d{4,5})(?:v\d+)?\b/ig;
const URL_RE = /\bhttps?:\/\/[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,12}\b[-a-zA-Z0-9()@:%_+.~#?&//=]*/g;
const SOURCE_IDENTIFIER_RE = /\b(?:doi:\s*10\.|10\.\d{4,9}\/|arxiv:\s*|https?:\/\/|www\.|pmid:\s*\d+|isbn(?:-1[03])?:|issn:)/i;

function normalizeDOI(value) {
	let doi = value
		.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
		.replace(/^doi:\s*/i, '');
	while (/[.,;:)\]}]$/.test(doi)) {
		doi = doi.slice(0, -1);
	}
	return doi.toLowerCase();
}

function normalizeURL(value) {
	let url = value.trim();
	while (/[.,;:)\]}]$/.test(url)) {
		url = url.slice(0, -1);
	}
	return url.toLowerCase();
}

export function hasSourceIdentifierEvidence(text) {
	return SOURCE_IDENTIFIER_RE.test(text || '');
}

export function findSourceIdentifierEvidence(text) {
	const match = (text || '').match(SOURCE_IDENTIFIER_RE);
	if (!match) {
		return null;
	}
	return {
		text: match[0],
		start: match.index,
		end: match.index + match[0].length - 1,
	};
}

export function extractMatchableSourceIdentifiers(text) {
	const normalized = text || '';
	const identifiers = [];
	let match;

	DOI_RE.lastIndex = 0;
	while ((match = DOI_RE.exec(normalized)) !== null) {
		identifiers.push({
			type: 'identifier',
			value: `doi:${normalizeDOI(match[1])}`,
			text: match[0],
			start: match.index,
			end: match.index + match[0].length - 1,
		});
	}

	ARXIV_RE.lastIndex = 0;
	while ((match = ARXIV_RE.exec(normalized)) !== null) {
		identifiers.push({
			type: 'identifier',
			value: `arxiv:${match[1].toLowerCase()}`,
			text: match[0],
			start: match.index,
			end: match.index + match[0].length - 1,
		});
	}

	URL_RE.lastIndex = 0;
	while ((match = URL_RE.exec(normalized)) !== null) {
		if (/doi\.org\//i.test(match[0])) {
			continue;
		}
		const url = normalizeURL(match[0]);
		identifiers.push({
			type: 'identifier',
			value: `url:${url}`,
			text: match[0],
			start: match.index,
			end: match.index + match[0].length - 1,
		});
	}

	return identifiers;
}

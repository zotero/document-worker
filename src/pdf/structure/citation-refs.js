import { createStructureIndex } from './structure-index.js';
import {
	getAuthorYearValue,
	getReferenceForBlock,
	isReferenceBlock,
	normalizeReferenceAuthorToken,
} from './reference/index.js';
import { extractMatchableSourceIdentifiers } from './reference/source-identifiers.js';

const NUMBER_DELIMITED_RE = /([\[(])\s*([0-9][0-9,\s\-–]*)\s*([\])])/g;
const WORD_RE = /[\p{L}\p{M}\p{N}]+(?:['’-][\p{L}\p{M}\p{N}]+)*/gu;
const IDENTITY_GROUP_MAX_CHARS = 180;
const IDENTITY_GROUP_RE = new RegExp(`([\\[(])([^()[\\]\\n]{1,${IDENTITY_GROUP_MAX_CHARS}})([\\])])`, 'g');
const IDENTITY_CONTEXT_WORDS = new Set(['cf', 'compare', 'eg', 'fig', 'figure', 'see', 'table']);
const IDENTITY_CONNECTORS = new Set([
	'and', 'de', 'del', 'den', 'der', 'di', 'du', 'la', 'le', 'of', 'the',
	'van', 'von',
]);
const LOCATOR_WORDS = new Set([
	'article', 'chapter', 'ch', 'line', 'lines', 'no', 'p', 'page', 'pages',
	'para', 'paragraph', 'pp', 'sec', 'section', 'sections', 'vol', 'volume',
]);
const NUMERIC_CHANNELS = new Set(['numeric-delimited', 'numeric-superscript']);
const AMBIGUOUS_NUMERIC_STYLE = 'ambiguous';
const NUMERIC_METADATA_MARKERS = new Set([',', '*', '†', '‡', '§', '+']);
const NUMERIC_CONTEXT = {
	CITATION: 'citation',
	WEAK: 'weak',
	BLOCKED: 'blocked',
};
const NUMERIC_RANGE_MAX_SPAN = 100;
const NUMERIC_METADATA_LINE_MAX_LENGTH = 500;
const NUMERIC_METADATA_LINE_MIN_COMMAS = 4;
const STRUCTURAL_NUMERIC_CONTEXT_WORDS = new Set([
	'alg', 'algorithm', 'appendix', 'chapter', 'definition', 'eq', 'equation',
	'ex', 'example', 'fig', 'figure', 'lemma', 'prop', 'proposition', 'scheme',
	'sec', 'section', 'table', 'theorem',
]);

function blockKey(blockRef) {
	return Array.isArray(blockRef) ? blockRef.join(',') : '';
}

function sameBlock(srcA, srcB) {
	return srcA?.blockRef?.[0] !== undefined && srcA.blockRef[0] === srcB?.blockRef?.[0];
}

function rangesOverlap(a, b) {
	return a.offsetStart <= b.offsetEnd && b.offsetStart <= a.offsetEnd;
}

function sameRange(a, b) {
	return a?.offsetStart === b?.offsetStart && a?.offsetEnd === b?.offsetEnd;
}

function sourceContains(outer, inner) {
	return outer?.offsetStart <= inner?.offsetStart && inner?.offsetEnd <= outer?.offsetEnd;
}

function parseYear(text) {
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

function numbersFromText(text) {
	const numbers = [];
	for (const rawPart of text.split(',')) {
		const part = rawPart.trim();
		if (!part) {
			continue;
		}
		const range = part.split(/[-–]/).map(x => parseInt(x.trim(), 10));
		if (range.length === 1 && Number.isInteger(range[0])) {
			numbers.push(range[0]);
		}
		else if (range.length === 2 && range.every(Number.isInteger)) {
			const start = Math.min(range[0], range[1]);
			const end = Math.max(range[0], range[1]);
			if (end - start <= NUMERIC_RANGE_MAX_SPAN) {
				for (let value = start; value <= end; value++) {
					numbers.push(value);
				}
			}
		}
	}
	return numbers;
}

function getMentionChannel(mention) {
	if (mention.keys.some(key => key.type === 'number')) {
		if (mention.kind === 'superscript') {
			return 'numeric-superscript';
		}
		if (mention.kind === 'brackets' || mention.kind === 'parentheses') {
			return 'numeric-delimited';
		}
	}
	if (mention.keys.some(key => key.type === 'identifier')) {
		return 'identifier';
	}
	if (mention.keys.some(key => key.type === 'authorYear')) {
		return 'author-year';
	}
	if (mention.keys.some(key => key.type === 'identity')) {
		return 'identity';
	}
	return null;
}

function isNumericChannel(channel) {
	return NUMERIC_CHANNELS.has(channel);
}

function getBlockSourceStrength(block) {
	return block.type === 'paragraph' || block.type === 'caption' ? 'strong' : 'weak';
}

function previousNonSpace(text, index) {
	for (let i = index - 1; i >= 0; i--) {
		if (!/\s/.test(text[i])) {
			return text[i];
		}
	}
	return null;
}

function nonSpaceIndex(text, index, step) {
	for (let i = index + step; i >= 0 && i < text.length; i += step) {
		if (!/\s/.test(text[i])) {
			return i;
		}
	}
	return -1;
}

function rectCenter(rect, axis) {
	return (rect[axis] + rect[axis + 2]) / 2;
}

function visuallyAttachedPrecedingDigit(bt, start) {
	const adjacentIndex = nonSpaceIndex(bt.text, start, -1);
	if (adjacentIndex < 0) {
		return false;
	}
	const referenceIndex = nonSpaceIndex(bt.text, adjacentIndex, -1);
	if (referenceIndex < 0) {
		return false;
	}

	const runRect = bt.rects[start];
	const adjacentRect = bt.rects[adjacentIndex];
	const referenceRect = bt.rects[referenceIndex];
	const pageIndex = bt.pageIndexes[start];
	if (
		!runRect || !adjacentRect || !referenceRect
		|| pageIndex === null
		|| bt.pageIndexes[adjacentIndex] !== pageIndex
		|| bt.pageIndexes[referenceIndex] !== pageIndex
	) {
		return false;
	}

	const dx = rectCenter(adjacentRect, 0) - rectCenter(referenceRect, 0);
	const dy = rectCenter(adjacentRect, 1) - rectCenter(referenceRect, 1);
	if (!Number.isFinite(dx) || !Number.isFinite(dy) || Math.abs(dx) === Math.abs(dy)) {
		return false;
	}
	const axis = Math.abs(dx) > Math.abs(dy) ? 0 : 1;
	const direction = axis === 0 ? Math.sign(dx) : Math.sign(dy);
	if (!direction) {
		return false;
	}

	const crossAxis = axis === 0 ? 1 : 0;
	const crossGap = Math.max(
		runRect[crossAxis] - adjacentRect[crossAxis + 2],
		adjacentRect[crossAxis] - runRect[crossAxis + 2],
		0
	);
	const maximumCrossGap = Math.min(
		runRect[crossAxis + 2] - runRect[crossAxis],
		adjacentRect[crossAxis + 2] - adjacentRect[crossAxis]
	);
	if (!Number.isFinite(crossGap) || !Number.isFinite(maximumCrossGap) || crossGap > maximumCrossGap) {
		return false;
	}

	const beforeRect = adjacentRect;
	const afterRect = runRect;
	const gap = direction > 0
		? afterRect[axis] - beforeRect[axis + 2]
		: beforeRect[axis] - afterRect[axis + 2];
	return Number.isFinite(gap) && gap <= 0;
}

function nextNonSpace(text, index) {
	for (let i = index + 1; i < text.length; i++) {
		if (!/\s/.test(text[i])) {
			return text[i];
		}
	}
	return null;
}

function isDenseNumericMetadataLine(text) {
	return text.length < NUMERIC_METADATA_LINE_MAX_LENGTH
		&& (text.match(/,/g) || []).length >= NUMERIC_METADATA_LINE_MIN_COMMAS
		&& /,\s*\d+\s*[,*)]/.test(text);
}

function getPreviousWord(text, index) {
	const before = text.slice(0, index).trimEnd();
	const match = before.match(/[\p{L}\p{M}]+\.?$/u);
	return match ? match[0].replace(/\.$/, '').toLowerCase() : null;
}

function hasStructuralNumericMarker(text, start) {
	const previousWord = getPreviousWord(text, start);
	return previousWord ? STRUCTURAL_NUMERIC_CONTEXT_WORDS.has(previousWord) : false;
}

function getNumericMentionContext(bt, start, end, kind, baseStrength) {
	const { text } = bt;
	if (baseStrength !== 'strong') {
		return NUMERIC_CONTEXT.WEAK;
	}
	if (kind === 'parentheses' && hasStructuralNumericMarker(text, start)) {
		return NUMERIC_CONTEXT.BLOCKED;
	}
	if (kind !== 'superscript') {
		return NUMERIC_CONTEXT.CITATION;
	}
	if (start === 0 || isDenseNumericMetadataLine(text)) {
		return NUMERIC_CONTEXT.WEAK;
	}
	const immediatePrev = text[start - 1];
	const immediateNext = text[end + 1];
	if (/\p{L}/u.test(immediateNext || '')) {
		return NUMERIC_CONTEXT.WEAK;
	}
	if (/\d/.test(immediatePrev || '')) {
		return visuallyAttachedPrecedingDigit(bt, start)
			? NUMERIC_CONTEXT.BLOCKED
			: NUMERIC_CONTEXT.WEAK;
	}
	const previousIndex = nonSpaceIndex(text, start, -1);
	if (
		/\d/.test(text[previousIndex] || '')
		&& visuallyAttachedPrecedingDigit(bt, start)
	) {
		return NUMERIC_CONTEXT.BLOCKED;
	}
	const prev = previousNonSpace(text, start);
	const next = nextNonSpace(text, end);
	if (NUMERIC_METADATA_MARKERS.has(next) || (next === null && /\p{L}/u.test(prev || ''))) {
		return NUMERIC_CONTEXT.WEAK;
	}
	return NUMERIC_CONTEXT.CITATION;
}

function sourceStrengthFromNumericContext(context) {
	return context === NUMERIC_CONTEXT.CITATION ? 'strong' : 'weak';
}

function addWindow(windows, src, kind, text, keys, meta = {}) {
	if (!keys.length) {
		return null;
	}
	const window = { src, kind, text, keys, ...meta };
	window.channel = getMentionChannel(window);
	windows.push(window);
	return window;
}

function addDelimitedNumberWindows(windows, bt, blockRef, sourceStrength) {
	let match;
	NUMBER_DELIMITED_RE.lastIndex = 0;
	while ((match = NUMBER_DELIMITED_RE.exec(bt.text)) !== null) {
		const open = match[1];
		const close = match[3];
		if ((open === '[' && close !== ']') || (open === '(' && close !== ')')) {
			continue;
		}
		if (bt.attrs[match.index]?.style?.monospace) {
			continue;
		}
		const numbers = numbersFromText(match[2]);
		if (open === '(' && numbers.length === 1 && String(numbers[0]).length === 4) {
			continue;
		}
		const numericContext = getNumericMentionContext(
			bt,
			match.index,
			match.index + match[0].length - 1,
			open === '[' ? 'brackets' : 'parentheses',
			sourceStrength
		);
		if (numericContext === NUMERIC_CONTEXT.BLOCKED) {
			continue;
		}
		addWindow(
			windows,
			{
				blockRef,
				offsetStart: match.index,
				offsetEnd: match.index + match[0].length - 1,
			},
			open === '[' ? 'brackets' : 'parentheses',
			match[0],
			numbers.map(number => ({ type: 'number', value: String(number) })),
			{ numericContext, sourceStrength: sourceStrengthFromNumericContext(numericContext) },
		);
	}
}

function addSuperscriptNumberWindows(windows, bt, blockRef, sourceStrength) {
	const allowed = new Set(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', ',', '-', '–']);
	for (let i = 0; i < bt.text.length; i++) {
		if (!bt.attrs[i]?.style?.sup || !/[0-9]/.test(bt.text[i])) {
			continue;
		}
		const start = i;
		let text = '';
		while (i < bt.text.length && bt.attrs[i]?.style?.sup && allowed.has(bt.text[i])) {
			text += bt.text[i];
			i++;
		}
		i--;
		const numbers = numbersFromText(text);
		const numericContext = getNumericMentionContext(
			bt,
			start,
			i,
			'superscript',
			sourceStrength
		);
		if (numericContext === NUMERIC_CONTEXT.BLOCKED) {
			continue;
		}
		addWindow(
			windows,
			{ blockRef, offsetStart: start, offsetEnd: i },
			'superscript',
			text,
			numbers.map(number => ({ type: 'number', value: String(number) })),
			{ numericContext, sourceStrength: sourceStrengthFromNumericContext(numericContext) },
		);
	}
}

function addIdentifierWindows(windows, bt, blockRef, sourceStrength) {
	for (const identifier of extractMatchableSourceIdentifiers(bt.text)) {
		if (bt.attrs[identifier.start]?.style?.monospace) {
			continue;
		}
		addWindow(
			windows,
			{ blockRef, offsetStart: identifier.start, offsetEnd: identifier.end },
			'identifier',
			identifier.text,
			[{ type: 'identifier', value: identifier.value }],
			{ sourceStrength },
		);
	}
}

function getWords(text) {
	const words = [];
	let match;
	WORD_RE.lastIndex = 0;
	while ((match = WORD_RE.exec(text)) !== null) {
		words.push({
			text: match[0],
			start: match.index,
			end: match.index + match[0].length - 1,
		});
	}
	return words;
}

function isUppercaseWord(text) {
	for (const char of text) {
		if (/\p{L}/u.test(char)) {
			return /\p{Lu}/u.test(char);
		}
	}
	return false;
}

function isLocatorToken(text) {
	const value = text.toLowerCase().replace(/\.$/, '');
	return LOCATOR_WORDS.has(value)
		|| /^\d+[a-z]?$/.test(value)
		|| /^\d+[-–]\d+$/.test(value)
		|| (/^[IVXLCDM]+$/.test(text.replace(/\.$/, '')) && text.length > 1);
}

function identityTokenFromWord(word, referenceIndex) {
	const value = normalizeReferenceAuthorToken(word.text);
	if (
		!value
		|| IDENTITY_CONTEXT_WORDS.has(value)
		|| isLocatorToken(word.text)
		|| !referenceIndex.authorTokens.has(value)
	) {
		return null;
	}
	return {
		value,
		start: word.start,
		end: word.end,
	};
}

function getIdentityTokens(words, referenceIndex, { requireUppercase = false } = {}) {
	const tokens = [];
	const seen = new Set();
	for (const word of words) {
		if (parseYear(word.text)) {
			continue;
		}
		if (requireUppercase && !isUppercaseWord(word.text)) {
			continue;
		}
		const token = identityTokenFromWord(word, referenceIndex);
		if (!token || seen.has(token.value)) {
			continue;
		}
		seen.add(token.value);
		tokens.push(token);
	}
	return tokens;
}

function hasExplicitIdentityCitationShape(words, tokens) {
	return tokens.length > 1 || words.some(word => isLocatorToken(word.text));
}

function hasWindowOverlap(windows, blockRef, start, end) {
	const source = { blockRef, offsetStart: start, offsetEnd: end };
	return windows.some(window =>
		blockKey(window.src?.blockRef) === blockKey(blockRef)
		&& rangesOverlap(window.src, source)
	);
}

function isSentencePeriod(text, index) {
	const before = text.slice(Math.max(0, index - 8), index + 1).toLowerCase();
	if (/\bet\s+al\.$/.test(before) || /\b[a-z]\.$/.test(before)) {
		return false;
	}
	return true;
}

function getContextStart(text, offset) {
	for (let i = offset - 1; i >= 0; i--) {
		const char = text[i];
		if (char === ';' || char === '?' || char === '!' || char === '\n') {
			return i + 1;
		}
		if (char === '.' && isSentencePeriod(text, i)) {
			return i + 1;
		}
	}
	return 0;
}

function getCitationSegmentStart(text, contextStart, yearStart) {
	const groupStart = Math.max(
		text.lastIndexOf('(', yearStart),
		text.lastIndexOf('[', yearStart)
	);
	let segmentStart = groupStart >= contextStart ? groupStart + 1 : contextStart;
	const semicolon = text.lastIndexOf(';', yearStart);
	if (semicolon >= segmentStart) {
		segmentStart = semicolon + 1;
	}
	return { groupStart, segmentStart };
}

function getMatchingAuthorTokens(words, start, end, referenceIndex) {
	const tokens = [];
	const seen = new Set();
	for (const word of words) {
		if (word.start < start || word.end >= end) {
			continue;
		}
		const value = normalizeReferenceAuthorToken(word.text);
		if (!value || !referenceIndex.authorTokens.has(value) || seen.has(value)) {
			continue;
		}
		seen.add(value);
		tokens.push({
			text: word.text,
			value,
			start: word.start,
			end: word.end,
		});
	}
	return tokens;
}

function isConjunctiveAuthorToken(token) {
	return token?.value && !/\p{N}/u.test(token.text || '');
}

function startsWithUppercaseLetter(text) {
	for (const char of text || '') {
		if (/\p{L}/u.test(char)) {
			return /\p{Lu}/u.test(char);
		}
	}
	return false;
}

function isAuthorGroupBridge(text, { allowStructuralConnector = false, leftToken = null } = {}) {
	if (/^[\s,;&()[\]]*$/u.test(text)) {
		return true;
	}
	if (/^[\s,;&()[\]]*(?:\b(?:and|et|und|y|e)\b[\s,;&()[\]]*)*$/iu.test(text)) {
		return true;
	}
	return allowStructuralConnector
		&& startsWithUppercaseLetter(leftToken?.text)
		&& /^[\s,;&()[\]]*[\p{Ll}\p{M}]{1,3}[\s,;&()[\]]*$/u.test(text);
}

function getTerminalAuthorTokens(text, authorTokens, yearStart) {
	const tokens = [];
	let end = yearStart;
	for (let i = authorTokens.length - 1; i >= 0; i--) {
		const token = authorTokens[i];
		const bridge = text.slice(token.end + 1, end);
		if (!isConjunctiveAuthorToken(token) || !isAuthorGroupBridge(bridge, {
			allowStructuralConnector: tokens.length > 0,
			leftToken: token,
		})) {
			break;
		}
		tokens.unshift(token);
		end = token.start;
	}
	return tokens;
}

function getAuthorYearMention(text, words, yearWord, referenceIndex) {
	const contextStart = getContextStart(text, yearWord.start);
	const { groupStart, segmentStart } = getCitationSegmentStart(text, contextStart, yearWord.start);
	let authorTokens = getMatchingAuthorTokens(words, segmentStart, yearWord.start, referenceIndex);
	if (!authorTokens.length && groupStart >= contextStart) {
		const fallbackStart = Math.max(
			contextStart,
			text.lastIndexOf(';', groupStart) + 1,
			text.lastIndexOf(')', groupStart) + 1,
			text.lastIndexOf(']', groupStart) + 1
		);
		authorTokens = getMatchingAuthorTokens(words, fallbackStart, groupStart, referenceIndex);
	}
	if (!authorTokens.length) {
		return null;
	}
	const terminalAuthorTokens = getTerminalAuthorTokens(text, authorTokens, yearWord.start);
	return {
		offsetStart: (terminalAuthorTokens[0] || authorTokens[0]).start,
		offsetEnd: yearWord.end,
		tokens: authorTokens.map(token => token.value),
		terminalTokens: terminalAuthorTokens.map(token => token.value),
	};
}

function addAuthorYearWindows(windows, bt, blockRef, referenceIndex, sourceStrength) {
	if (!referenceIndex.authorTokens.size) {
		return;
	}
	const words = getWords(bt.text);
	for (const word of words) {
		const parsedYear = parseYear(word.text);
		if (!parsedYear || bt.attrs[word.start]?.style?.monospace) {
			continue;
		}
		const mention = getAuthorYearMention(bt.text, words, word, referenceIndex);
		if (!mention) {
			continue;
		}
		addWindow(
			windows,
			{
				blockRef,
				offsetStart: mention.offsetStart,
				offsetEnd: mention.offsetEnd,
			},
			'author-year',
			bt.text.slice(mention.offsetStart, mention.offsetEnd + 1),
			mention.tokens.map(authorToken => ({
				type: 'authorYear',
				value: getAuthorYearValue(authorToken, parsedYear.year, parsedYear.suffix),
				authorToken,
			})),
			{ sourceStrength, terminalAuthorTokens: mention.terminalTokens },
		);
	}
}

function addIdentityWindow(windows, bt, blockRef, start, end, kind, tokens, sourceStrength) {
	if (!tokens.length || hasWindowOverlap(windows, blockRef, start, end)) {
		return;
	}
	addWindow(
		windows,
		{ blockRef, offsetStart: start, offsetEnd: end },
		kind,
		bt.text.slice(start, end + 1),
		tokens.map(token => ({
			type: 'identity',
			value: token.value,
			authorToken: token.value,
		})),
		{ sourceStrength },
	);
}

function addExplicitIdentityWindows(windows, bt, blockRef, referenceIndex, sourceStrength) {
	if (!referenceIndex.authorTokens.size) {
		return;
	}
	let match;
	IDENTITY_GROUP_RE.lastIndex = 0;
	while ((match = IDENTITY_GROUP_RE.exec(bt.text)) !== null) {
		const open = match[1];
		const close = match[3];
		if ((open === '[' && close !== ']') || (open === '(' && close !== ')')) {
			continue;
		}
		if (bt.attrs[match.index]?.style?.monospace) {
			continue;
		}

		const inner = match[2];
		let segmentStart = 0;
		for (let i = 0; i <= inner.length; i++) {
			if (i < inner.length && inner[i] !== ';') {
				continue;
			}
			const raw = inner.slice(segmentStart, i);
			const leading = raw.match(/^\s*/)?.[0].length || 0;
			const trailing = raw.match(/\s*$/)?.[0].length || 0;
			const text = raw.slice(leading, raw.length - trailing);
			if (text) {
				const offsetStart = match.index + 1 + segmentStart + leading;
				const words = getWords(text).map(word => ({
					...word,
					start: word.start + offsetStart,
					end: word.end + offsetStart,
				}));
				if (!words.some(word => parseYear(word.text))) {
					const tokens = getIdentityTokens(words, referenceIndex);
					if (!hasExplicitIdentityCitationShape(words, tokens)) {
						segmentStart = i + 1;
						continue;
					}
					addIdentityWindow(
						windows,
						bt,
						blockRef,
						offsetStart,
						offsetStart + text.length - 1,
						'identity',
						tokens,
						sourceStrength,
					);
				}
			}
			segmentStart = i + 1;
		}
	}
}

function isProseIdentityWord(word, referenceIndex) {
	return isUppercaseWord(word.text) && !!identityTokenFromWord(word, referenceIndex);
}

function addProseIdentityWindows(windows, bt, blockRef, block, referenceIndex, sourceStrength) {
	if (block.type !== 'paragraph' || !referenceIndex.authorTokens.size) {
		return;
	}
	const words = getWords(bt.text);
	for (let i = 0; i < words.length; i++) {
		if (!isProseIdentityWord(words[i], referenceIndex)) {
			continue;
		}

		const startIndex = i;
		let endIndex = i;
		let lastIdentityIndex = i;
		for (let j = i + 1; j < words.length; j++) {
			const gap = words[j].start - words[j - 1].end;
			if (gap > 4) {
				break;
			}
			const value = normalizeReferenceAuthorToken(words[j].text);
			if (isProseIdentityWord(words[j], referenceIndex)) {
				lastIdentityIndex = j;
				endIndex = j;
				continue;
			}
			if (IDENTITY_CONNECTORS.has(value) && j + 1 < words.length
				&& isProseIdentityWord(words[j + 1], referenceIndex)) {
				endIndex = j;
				continue;
			}
			break;
		}

		const spanWords = words.slice(startIndex, lastIdentityIndex + 1);
		const tokens = getIdentityTokens(spanWords, referenceIndex, { requireUppercase: true });
		addIdentityWindow(
			windows,
			bt,
			blockRef,
			words[startIndex].start,
			words[lastIdentityIndex].end,
			'prose-identity',
			tokens,
			sourceStrength,
		);
		i = Math.max(endIndex, lastIdentityIndex);
	}
}

export function getMentionWindows(
	structure,
	referenceIndex,
	structureIndex = createStructureIndex(structure),
	{ includeProseIdentity = true } = {}
) {
	const windows = [];

	for (const entry of structureIndex.blockEntries()) {
		const blockRef = entry.ref;
		const block = entry.block;
		if (
			block.type === 'preformatted'
			|| block.type === 'list'
			|| block.flowClass === 'excluded'
			|| isReferenceBlock(referenceIndex, blockRef)
		) {
			continue;
		}

		const sourceStrength = getBlockSourceStrength(block);
		structureIndex.withBlockText(blockRef, (bt) => {
			addIdentifierWindows(windows, bt, blockRef, sourceStrength);
			addDelimitedNumberWindows(windows, bt, blockRef, sourceStrength);
			addSuperscriptNumberWindows(windows, bt, blockRef, sourceStrength);
			addAuthorYearWindows(windows, bt, blockRef, referenceIndex, sourceStrength);
			addExplicitIdentityWindows(windows, bt, blockRef, referenceIndex, sourceStrength);
			if (includeProseIdentity) {
				addProseIdentityWindows(windows, bt, blockRef, block, referenceIndex, sourceStrength);
			}
		});
	}

	return windows;
}

function getEntriesForKey(referenceIndex, key) {
	return referenceIndex[key.type]?.get(key.value) || [];
}

function chooseReference(entries, mention) {
	const compatible = entries.filter(entry =>
		entry?.src?.blockRef
		&& !sameBlock(mention.src, entry.src)
	);
	if (!compatible.length) {
		return null;
	}

	const sourceIndex = mention.src.blockRef[0];
	const after = compatible.filter(entry => entry.run.ref[0] > sourceIndex);
	const pool = after.length ? after : compatible;
	pool.sort((a, b) => {
		const aDistance = after.length ? a.run.ref[0] - sourceIndex : Math.abs(a.run.ref[0] - sourceIndex);
		const bDistance = after.length ? b.run.ref[0] - sourceIndex : Math.abs(b.run.ref[0] - sourceIndex);
		return aDistance - bDistance || a.src.blockRef[0] - b.src.blockRef[0];
	});

	const run = pool[0].run;
	const inRun = pool.filter(entry => entry.run === run);
	return inRun.length === 1 ? inRun[0] : null;
}

function getNearestCandidateRun(candidates, mention) {
	if (!candidates.length) {
		return [];
	}

	const sourceIndex = mention.src.blockRef[0];
	const after = candidates.filter(candidate => candidate.reference.run.ref[0] > sourceIndex);
	const pool = after.length ? after : candidates;
	pool.sort((a, b) => {
		const aDistance = after.length
			? a.reference.run.ref[0] - sourceIndex
			: Math.abs(a.reference.run.ref[0] - sourceIndex);
		const bDistance = after.length
			? b.reference.run.ref[0] - sourceIndex
			: Math.abs(b.reference.run.ref[0] - sourceIndex);
		return aDistance - bDistance || a.reference.src.blockRef[0] - b.reference.src.blockRef[0];
	});

	const run = pool[0].reference.run;
	return pool.filter(candidate => candidate.reference.run === run);
}

function chooseCandidate(candidates, mention) {
	const inRun = getNearestCandidateRun(candidates, mention);
	return inRun.length === 1 ? inRun[0] : null;
}

function isCompatibleWithLearnedIdentity(
	candidate,
	authorIdentity,
	{ requireLeadWhenUnlearned = false, requireIdentityOverlap = false } = {}
) {
	const identity = authorIdentity?.get(candidate.reference);
	if (!identity) {
		return !requireLeadWhenUnlearned || candidate.minPosition <= 1 || candidate.positions.has(0);
	}
	if (requireIdentityOverlap) {
		for (const position of candidate.positions) {
			if (identity.positions.has(position)) {
				return true;
			}
		}
		return false;
	}
	if (candidate.minPosition <= identity.minPosition) {
		return true;
	}
	for (const position of candidate.positions) {
		if (identity.positions.has(position)) {
			return true;
		}
	}
	return false;
}

function getAuthorCandidates(mention, referenceIndex, authorIdentity = null) {
	const byReference = new Map();
	for (const key of mention.keys.filter(key => key.type === 'authorYear')) {
		const authorToken = key.authorToken || key.value?.split('|')[0];
		if (!authorToken) {
			continue;
		}
		for (const reference of getEntriesForKey(referenceIndex, key)) {
			if (
				!reference?.src?.blockRef
				|| sameBlock(mention.src, reference.src)
			) {
				continue;
			}
			const position = reference.authorTokenPositions?.get(authorToken);
			if (!Number.isInteger(position)) {
				continue;
			}
			let candidate = byReference.get(reference);
			if (!candidate) {
				candidate = {
					reference,
					tokens: new Set(),
					tokenPositions: new Map(),
					positions: new Set(),
					minPosition: Number.MAX_SAFE_INTEGER,
					maxPosition: -1,
				};
				byReference.set(reference, candidate);
			}
			candidate.tokens.add(authorToken);
			candidate.tokenPositions.set(authorToken, position);
			candidate.positions.add(position);
			candidate.minPosition = Math.min(candidate.minPosition, position);
			candidate.maxPosition = Math.max(candidate.maxPosition, position);
		}
	}

	return [...byReference.values()].filter((candidate) => {
		return isCompatibleWithLearnedIdentity(candidate, authorIdentity);
	});
}

function getMentionAuthorTokens(mention) {
	const tokens = [];
	const seen = new Set();
	const authorTokens = Array.isArray(mention.terminalAuthorTokens)
		? mention.terminalAuthorTokens
		: mention.keys
			.filter(key => key.type === 'authorYear')
			.map(key => key.authorToken || key.value?.split('|')[0]);
	for (const token of authorTokens) {
		if (!token || seen.has(token)) {
			continue;
		}
		seen.add(token);
		tokens.push(token);
	}
	return tokens;
}

function hasCompatibleMentionAuthorOrder(candidate, authorTokens) {
	let previousPosition = -1;
	for (const token of authorTokens) {
		const position = candidate.tokenPositions?.get(token);
		if (!Number.isInteger(position) || position <= previousPosition) {
			return false;
		}
		previousPosition = position;
	}
	return true;
}

function getCandidateAuthorPosition(candidate, authorTokens) {
	let position = Number.MAX_SAFE_INTEGER;
	for (const token of authorTokens) {
		const tokenPosition = candidate.tokenPositions?.get(token);
		if (Number.isInteger(tokenPosition)) {
			position = Math.min(position, tokenPosition);
		}
	}
	return position;
}

function getIdentityCandidates(
	mention,
	referenceIndex,
	authorIdentity = null,
	{ requireKnownIdentity = false } = {}
) {
	const keys = mention.keys.filter(key => key.type === 'identity');
	const requiredTokens = [...new Set(keys.map(key => key.authorToken || key.value).filter(Boolean))];
	const byReference = new Map();

	for (const token of requiredTokens) {
		for (const reference of referenceIndex.identity.get(token) || []) {
			if (
				!reference?.src?.blockRef
				|| sameBlock(mention.src, reference.src)
			) {
				continue;
			}
			const position = reference.authorTokenPositions?.get(token);
			if (!Number.isInteger(position)) {
				continue;
			}
			let candidate = byReference.get(reference);
			if (!candidate) {
				candidate = {
					reference,
					tokens: new Set(),
					positions: new Set(),
					minPosition: Number.MAX_SAFE_INTEGER,
					maxPosition: -1,
				};
				byReference.set(reference, candidate);
			}
			candidate.tokens.add(token);
			candidate.positions.add(position);
			candidate.minPosition = Math.min(candidate.minPosition, position);
			candidate.maxPosition = Math.max(candidate.maxPosition, position);
		}
	}

	return [...byReference.values()].filter(candidate =>
		candidate.tokens.size === requiredTokens.length
		&& (!requireKnownIdentity || authorIdentity?.has(candidate.reference))
		&& isCompatibleWithLearnedIdentity(candidate, authorIdentity, {
			requireLeadWhenUnlearned: true,
			requireIdentityOverlap: true,
		})
	);
}

function chooseAuthorCandidate(mention, referenceIndex, authorIdentity = null) {
	const candidates = getAuthorCandidates(mention, referenceIndex, authorIdentity);
	if (!candidates.length) {
		return null;
	}
	const authorTokens = getMentionAuthorTokens(mention);
	if (authorTokens.length >= 2) {
		const sharedCandidates = candidates.filter(candidate =>
			authorTokens.every(token => candidate.tokens?.has(token))
			&& hasCompatibleMentionAuthorOrder(candidate, authorTokens)
		);
		if (sharedCandidates.length > 0) {
			const bestPosition = Math.min(
				...sharedCandidates.map(candidate => getCandidateAuthorPosition(candidate, authorTokens))
			);
			return chooseCandidate(
				sharedCandidates.filter(candidate =>
					getCandidateAuthorPosition(candidate, authorTokens) === bestPosition
				),
				mention
			);
		}
	}
	const bestPosition = Math.min(...candidates.map(candidate => candidate.minPosition));
	return chooseCandidate(candidates.filter(candidate => candidate.minPosition === bestPosition), mention);
}

function chooseIdentityCandidate(mention, referenceIndex, authorIdentity = null, options = {}) {
	const candidates = getIdentityCandidates(mention, referenceIndex, authorIdentity, options);
	const inRun = getNearestCandidateRun(candidates, mention);
	return inRun.length === 1 ? inRun[0] : null;
}

function learnAuthorIdentity(authorIdentity, candidate) {
	if (!candidate) {
		return;
	}
	const existing = authorIdentity.get(candidate.reference);
	if (!existing || candidate.minPosition < existing.minPosition) {
		authorIdentity.set(candidate.reference, {
			minPosition: candidate.minPosition,
			positions: new Set(candidate.positions),
		});
		return;
	}
	if (candidate.minPosition === existing.minPosition) {
		for (const position of candidate.positions) {
			existing.positions.add(position);
		}
	}
}

function createRunChannelStats(referenceIndex) {
	const stats = new Map();
	for (const run of referenceIndex.runs) {
		stats.set(run, new Map());
	}
	return stats;
}

function addNumericChannelEvidence(channelStats, mention, references) {
	if (mention.sourceStrength !== 'strong' || !isNumericChannel(mention.channel)) {
		return;
	}
	const countedRuns = new Set();
	for (const reference of references) {
		if (!reference?.run || countedRuns.has(reference.run)) {
			continue;
		}
		countedRuns.add(reference.run);
		const stats = channelStats.get(reference.run);
		if (stats) {
			stats.set(mention.channel, (stats.get(mention.channel) || 0) + 1);
		}
	}
}

function selectRunNumericStyles(referenceIndex, channelStats) {
	const runNumericStyles = new Map();
	for (const run of referenceIndex.runs) {
		const stats = channelStats.get(run);
		const numericCounts = [...NUMERIC_CHANNELS]
			.map(channel => [channel, stats?.get(channel) || 0])
			.filter(([, count]) => count > 0);
		if (!numericCounts.length) {
			runNumericStyles.set(run, null);
			continue;
		}
		const maxCount = Math.max(...numericCounts.map(([, count]) => count));
		const bestChannels = numericCounts
			.filter(([, count]) => count === maxCount)
			.map(([channel]) => channel);
		runNumericStyles.set(
			run,
			bestChannels.length === 1 ? bestChannels[0] : AMBIGUOUS_NUMERIC_STYLE
		);
	}
	return runNumericStyles;
}

export function createCitationResolutionContext(mentionWindows, referenceIndex) {
	const authorIdentity = new Map();
	for (const mention of mentionWindows) {
		if (!mention.keys.some(key => key.type === 'authorYear')) {
			continue;
		}
		learnAuthorIdentity(
			authorIdentity,
			chooseAuthorCandidate(mention, referenceIndex)
		);
	}
	const context = {
		authorIdentity,
		runNumericStyles: new Map(),
	};
	for (const mention of mentionWindows) {
		if (mention.kind !== 'identity') {
			continue;
		}
		learnAuthorIdentity(
			authorIdentity,
			chooseIdentityCandidate(mention, referenceIndex, context.authorIdentity)
		);
	}
	const channelStats = createRunChannelStats(referenceIndex);
	for (const mention of mentionWindows) {
		addNumericChannelEvidence(
			channelStats,
			mention,
			resolveMention(mention, referenceIndex, context)
		);
	}
	context.runNumericStyles = selectRunNumericStyles(referenceIndex, channelStats);
	return context;
}

export function resolveMention(mention, referenceIndex, context = null) {
	const resolved = [];
	for (const type of ['identifier', 'number', 'authorYear', 'identity']) {
		const keys = mention.keys.filter(key => key.type === type);
		if (!keys.length) {
			continue;
		}
		if (type === 'authorYear') {
			const candidate = chooseAuthorCandidate(mention, referenceIndex, context?.authorIdentity);
			if (candidate) {
				resolved.push(candidate.reference);
			}
			if (resolved.length) {
				return resolved;
			}
			continue;
		}
		if (type === 'identity') {
			const candidate = chooseIdentityCandidate(
				mention,
				referenceIndex,
				context?.authorIdentity,
				{ requireKnownIdentity: mention.kind === 'prose-identity' }
			);
			if (candidate) {
				resolved.push(candidate.reference);
			}
			if (resolved.length) {
				return resolved;
			}
			continue;
		}
		for (const key of keys) {
			const entries = getEntriesForKey(referenceIndex, key);
			const reference = chooseReference(entries, mention);
			if (reference && !resolved.includes(reference)) {
				resolved.push(reference);
			}
		}
		if (resolved.length) {
			return resolved;
		}
	}
	return resolved;
}

export function isMentionReferenceAllowed(mention, reference, context = null) {
	const runNumericStyle = context?.runNumericStyles?.get(reference.run);
	if (!isNumericChannel(mention.channel)) {
		return !isNumericChannel(runNumericStyle);
	}
	if (mention.sourceStrength !== 'strong') {
		return false;
	}
	return context?.runNumericStyles?.get(reference.run) === mention.channel;
}

export function resolveAllowedMention(mention, referenceIndex, context = null) {
	return resolveMention(mention, referenceIndex, context)
		.filter(reference => isMentionReferenceAllowed(mention, reference, context));
}

function getOverlappingRefs(refsList, source) {
	const group = refsList.get(blockKey(source.blockRef)) || [];
	return group.filter(ref => ref.src?.blockRef && rangesOverlap(ref.src, source));
}

function matchesReferenceDest(ref, reference) {
	return blockKey(ref.dest?.blockRef) === blockKey(reference.src?.blockRef);
}

function matchesAnyReferenceDest(ref, references) {
	return references.some(reference => matchesReferenceDest(ref, reference));
}

function isContainedSameDestinationOverlap(ref, source, references) {
	return matchesAnyReferenceDest(ref, references)
		&& sourceContains(source, ref.src)
		&& !sameRange(source, ref.src);
}

function isContainedDestinationGuess(ref, source) {
	let guessedSource = ref.src;
	if (typeof guessedSource?.text === 'string') {
		let leading = guessedSource.text.match(/^[^\p{L}\p{N}]*/u)?.[0].length || 0;
		let trailing = guessedSource.text.match(/[^\p{L}\p{N}]*$/u)?.[0].length || 0;
		guessedSource = {
			...guessedSource,
			offsetStart: guessedSource.offsetStart + leading,
			offsetEnd: guessedSource.offsetEnd - trailing,
		};
	}
	return ref.destinationResolution === 'source-text'
		&& sourceContains(source, guessedSource);
}

function hasBlockingSourceOverlap(refsList, source, references) {
	return getOverlappingRefs(refsList, source).some(ref => {
		if (isContainedDestinationGuess(ref, source)) {
			return false;
		}
		if (sameRange(source, ref.src) && matchesAnyReferenceDest(ref, references)) {
			return false;
		}
		return !isContainedSameDestinationOverlap(ref, source, references);
	});
}

function replaceContainedSameDestinationOverlaps(refsList, source, references) {
	const key = blockKey(source.blockRef);
	const group = refsList.get(key);
	if (!group) {
		return;
	}
	const filtered = group.filter(ref =>
		!isContainedSameDestinationOverlap(ref, source, references)
		&& !isContainedDestinationGuess(ref, source));
	if (filtered.length) {
		refsList.set(key, filtered);
	}
	else {
		refsList.delete(key);
	}
}

function addLocalReferenceEvidence(localRefsByBlock, mention, references) {
	if (mention.kind === 'prose-identity' || !references.length) {
		return;
	}
	const key = blockKey(mention.src.blockRef);
	let refs = localRefsByBlock.get(key);
	if (!refs) {
		refs = new Map();
		localRefsByBlock.set(key, refs);
	}
	for (const reference of references) {
		let sources = refs.get(reference);
		if (!sources) {
			sources = [];
			refs.set(reference, sources);
		}
		sources.push(mention.src);
	}
}

function hasLocalProseEvidence(reference, mention, localRefsByBlock) {
	const key = blockKey(mention.src.blockRef);
	const sources = localRefsByBlock.get(key)?.get(reference) || [];
	return sources.some(source => source.offsetEnd < mention.src.offsetStart);
}

function addRef(refsList, source, reference, metadata = null) {
	if (!source?.blockRef || !reference?.src?.blockRef || sameBlock(source, reference.src)) {
		return;
	}
	const key = blockKey(source.blockRef);
	let group = refsList.get(key);
	if (!group) {
		group = [];
		refsList.set(key, group);
	}
	if (group.some(ref =>
		ref.type === 'citation'
		&& blockKey(ref.dest?.blockRef) === blockKey(reference.src.blockRef)
		&& ref.src.offsetStart === source.offsetStart
		&& ref.src.offsetEnd === source.offsetEnd
	)) {
		return;
	}
	group.push({ src: source, dest: reference.src, type: 'citation', ...metadata });
}

function numberFromText(text) {
	const match = text?.match(/\d+/);
	return match ? match[0] : null;
}

function addEmbeddedLinkRefs(refsList, annotLinkRefs, referenceIndex) {
	if (!annotLinkRefs) {
		return;
	}
	for (const links of annotLinkRefs.values()) {
		for (const link of links) {
			if (!link?.src?.blockRef || !link?.dest?.blockRef) {
				continue;
			}
			let reference = getReferenceForBlock(referenceIndex, link.dest.blockRef);
			if (!reference) {
				const number = numberFromText(link.src.text);
				const entries = number ? referenceIndex.number.get(number) || [] : [];
				reference = entries.find(entry => entry.run.ref[0] === link.dest.blockRef[0]) || null;
			}
			if (reference) {
				let metadata = link.destinationResolution
					? { destinationResolution: link.destinationResolution }
					: null;
				addRef(refsList, link.src, reference, metadata);
			}
		}
	}
}

export function getCitationRefs(
	structure,
	referenceIndex,
	annotLinkRefs = null,
	structureIndex = createStructureIndex(structure)
) {
	const refsList = new Map();
	addEmbeddedLinkRefs(refsList, annotLinkRefs, referenceIndex);
	const mentionWindows = getMentionWindows(structure, referenceIndex, structureIndex);
	const context = createCitationResolutionContext(mentionWindows, referenceIndex);
	const resolvedMentions = new Map();
	const localRefsByBlock = new Map();
	const proseRefsByBlock = new Map();

	for (const mention of mentionWindows) {
		const references = resolveAllowedMention(mention, referenceIndex, context);
		resolvedMentions.set(mention, references);
		addLocalReferenceEvidence(localRefsByBlock, mention, references);
	}

	for (const mention of mentionWindows) {
		const references = [];
		for (const reference of resolvedMentions.get(mention) || []) {
			if (mention.kind === 'prose-identity') {
				if (!hasLocalProseEvidence(
					reference,
					mention,
					localRefsByBlock
				)) {
					continue;
				}
			}
			references.push(reference);
		}
		if (!references.length || hasBlockingSourceOverlap(refsList, mention.src, references)) {
			continue;
		}
		replaceContainedSameDestinationOverlaps(refsList, mention.src, references);
		for (const reference of references) {
			if (mention.kind === 'prose-identity') {
				const sourceKey = blockKey(mention.src.blockRef);
				const destKey = blockKey(reference.src.blockRef);
				let proseRefs = proseRefsByBlock.get(sourceKey);
				if (!proseRefs) {
					proseRefs = new Set();
					proseRefsByBlock.set(sourceKey, proseRefs);
				}
				if (proseRefs.has(destKey)) {
					continue;
				}
				proseRefs.add(destKey);
			}
			addRef(refsList, mention.src, reference);
		}
	}

	return refsList;
}

import { getReferenceSourceEvidence } from './evidence.js';
import { getLogicalBlockText } from '../../../../structured-document-text/src/parts.js';
import { isTransparentBetweenParts } from '../flow-policy.js';
import { getCrossPageListItemSiblingRelation } from '../list-relations.js';


const REFERENCE_LIST_DETECTION = {
	MIN_YEAR_RATIO: 0.7,
	MIN_SOURCE_LIKE_RATIO: 0.7,
	PARAGRAPH_LEAD_MAX_WORDS: 12,
};


function getReferenceListDecision(list) {
	let yearEntries = 0;
	let sourceLikeEntries = 0;
	for (const ref of list.references) {
		const evidence = getReferenceSourceEvidence(ref.text || '');
		if (evidence.hasYear) {
			yearEntries++;
		}
		if (evidence.isSourceLike) {
			sourceLikeEntries++;
		}
	}
	const entryCount = list.references.length;
	const yearRatio = entryCount ? yearEntries / entryCount : 0;
	const sourceLikeRatio = entryCount ? sourceLikeEntries / entryCount : 0;
	if (sourceLikeRatio >= REFERENCE_LIST_DETECTION.MIN_SOURCE_LIKE_RATIO) {
		return { accepted: true, reason: 'source-like-ratio' };
	}
	if (yearRatio >= REFERENCE_LIST_DETECTION.MIN_YEAR_RATIO) {
		return { accepted: true, reason: 'year-ratio' };
	}
	return { accepted: false, reason: 'insufficient-source-evidence' };
}

function isListValid(list) {
	return getReferenceListDecision(list).accepted;
}

function startsAsProse(text) {
	const normalized = text.trim();
	return /^[•*-]\s*["“]/.test(normalized)
		|| /^["“]/.test(normalized)
		|| /^\d+\.\s*["“]/.test(normalized);
}

function getParagraphReferenceStartDecision(text) {
	const normalized = text.trim();
	if (normalized.length < 20) {
		return { accepted: false, reason: 'too-short' };
	}
	if (startsAsProse(normalized)) {
		return { accepted: false, reason: 'prose-start' };
	}
	const evidence = getReferenceSourceEvidence(normalized, {
		leadMaxWords: REFERENCE_LIST_DETECTION.PARAGRAPH_LEAD_MAX_WORDS,
	});
	if (getItemId(normalized) && (evidence.hasYear || evidence.hasBibliographicIdentifier)) {
		return { accepted: true, reason: 'label-source' };
	}
	if (evidence.hasLeadYear && (evidence.hasBibliographicIdentifier || evidence.hasSourceDetail)) {
		return { accepted: true, reason: 'lead-year-source' };
	}
	if (evidence.hasTerminalYearShape) {
		return { accepted: true, reason: 'terminal-year-source' };
	}
	return { accepted: false, reason: 'insufficient-source-evidence' };
}

function isParagraphReferenceStart(text) {
	return getParagraphReferenceStartDecision(text).accepted;
}

function addParagraphReferenceList(candidates, current) {
	if (!current || current.references.length < 2) {
		return;
	}
	if (isListValid(current)) {
		candidates.push(current);
	}
}

function getItemId(text) {
	// Collect a small prefix of the reference to detect leading numbers even if tokenized oddly,
	// e.g., "[", "12", "]" in separate tokens.
	let prefix = '';
	for (let i = 0; i < text.length && i < 24; i++) {
		const ch = text[i];
		prefix += ch;
		// Stop early once we hit the first obvious letter, likely beyond the numeric label.
		if (/[A-Za-z]/.test(ch)) break;
	}

	// Match optional wrappers then digits at the very start:
	// Examples matched: "12", "12.", "[12]", "[12]:", "(12)", "{12}", "  [12]  "
	const match = prefix.match(/^\s*[\[\(\{]*\s*(\d+)\s*[\]\)\}\.:,-]*/);
	if (match) {
		return match[1];
	}

	return null;
}

function getNodeByRef(structure, ref) {
	let node = { content: structure?.content };
	for (const index of ref || []) {
		if (!Number.isInteger(index) || !Array.isArray(node?.content)) {
			return null;
		}
		node = node.content[index];
		if (!node || typeof node !== 'object') {
			return null;
		}
	}
	return node;
}

function hasOnlyTransparentBlocksBetween(structure, firstIndex, secondIndex) {
	for (let i = firstIndex + 1; i < secondIndex; i++) {
		if (!isTransparentBetweenParts(structure.content[i])) {
			return false;
		}
	}
	return true;
}

function canJoinReferenceListRuns(structure, first, second, firstListRef = first?.ref) {
	const firstIndex = firstListRef?.[0];
	const secondIndex = second?.ref?.[0];
	if (
		firstListRef?.length !== 1
		|| second?.ref?.length !== 1
		|| !Number.isInteger(firstIndex)
		|| !Number.isInteger(secondIndex)
		|| secondIndex <= firstIndex
		|| !hasOnlyTransparentBlocksBetween(structure, firstIndex, secondIndex)
	) {
		return false;
	}

	const firstList = getNodeByRef(structure, firstListRef);
	const secondList = getNodeByRef(structure, second.ref);
	if (
		firstList?.type !== 'list'
		|| secondList?.type !== 'list'
		|| !Array.isArray(firstList.content)
		|| !Array.isArray(secondList.content)
		|| firstList.content.length === 0
		|| secondList.content.length === 0
	) {
		return false;
	}

	return !!getCrossPageListItemSiblingRelation(
		firstList.content.at(-1),
		secondList.content[0],
		{ structure }
	);
}

function joinContinuedReferenceListRuns(structure, candidates) {
	const joined = [];
	const lastListRefs = new Map();
	for (const candidate of candidates) {
		const previous = joined.at(-1);
		if (!previous || !canJoinReferenceListRuns(
			structure,
			previous,
			candidate,
			lastListRefs.get(previous)
		)) {
			joined.push(candidate);
			lastListRefs.set(candidate, candidate.ref);
			continue;
		}
		previous.blockRefs.push(...candidate.blockRefs);
		previous.references.push(...candidate.references);
		lastListRefs.set(previous, candidate.ref);
	}
	return joined;
}

export function getReferenceLists(structure, regularWordsSet) {
	const candidates = [];
	let prevBlock = null;
	let prevBlockRef = null;
	let paragraphCandidate = null;

	for (let i = 0; i < structure.content.length; i++) {
		const block = structure.content[i];
		if (block.flowClass === 'excluded') {
			continue;
		}
		if (block.type === 'list') {
			addParagraphReferenceList(candidates, paragraphCandidate);
			paragraphCandidate = null;
			let candidate = {
				ref: [i],
				blockRefs: [],
				references: [],
			};

			if (prevBlock?.type === 'heading') {
				candidate.titleRef = prevBlockRef;
			}

			for (let j = 0; j < block.content.length; j++) {
				if (Array.isArray(block.content[j]?.previousPart)) {
					const previousReference = candidate.references.at(-1);
					if (previousReference) {
						previousReference.continuationBlockRefs ||= [];
						previousReference.continuationBlockRefs.push([i, j]);
						candidate.blockRefs.push([i, j]);
					}
					continue;
				}
				let text = getLogicalBlockText(structure, [i, j]);
				let id = getItemId(text);
				candidate.references.push({ id, text, src: { blockRef: [i, j] } });
			}

			if (candidate.references.length > 0 && isListValid(candidate)) {
				candidates.push(candidate);
			}

			prevBlock = block;
			prevBlockRef = [i];
			continue;
		}

		if (block.type === 'paragraph') {
			let text = getLogicalBlockText(structure, [i]);
			if (isParagraphReferenceStart(text)) {
				if (!paragraphCandidate) {
					paragraphCandidate = {
						ref: [i],
						blockRefs: [],
						references: [],
					};
					if (prevBlock?.type === 'heading') {
						paragraphCandidate.titleRef = prevBlockRef;
					}
				}
				paragraphCandidate.blockRefs.push([i]);
				paragraphCandidate.references.push({
					id: getItemId(text),
					text,
					src: { blockRef: [i] },
				});
			}
			else {
				addParagraphReferenceList(candidates, paragraphCandidate);
				paragraphCandidate = null;
			}
			prevBlock = block;
			prevBlockRef = [i];
			continue;
		}

		addParagraphReferenceList(candidates, paragraphCandidate);
		paragraphCandidate = null;

		prevBlock = block;
		prevBlockRef = [i];
	}

	addParagraphReferenceList(candidates, paragraphCandidate);

	return joinContinuedReferenceListRuns(structure, candidates);
}

import {
	createCitationResolutionContext,
	getMentionWindows,
	resolveAllowedMention,
} from '../citation-refs.js';
import { getReferenceSourceEvidence } from './evidence.js';

const REFERENCE_RUN_SUPPORT = {
	SOURCE_SHAPE_ACCEPTANCE_RATIO: 0.7,
	MIN_SOURCE_LIKE_ENTRIES_WITH_SUPPORT: 2,
	MIN_SPECIFIC_MATCHED_ENTRIES: 2,
	MIN_MATCHED_ENTRIES: 3,
	MIN_MENTION_COUNT: 3,
	MIN_SOURCE_SHAPE_ENTRIES: 3,
	SMALL_RUN_MAX_ENTRIES: 2,
};

function isSourceLike(reference) {
	return getReferenceSourceEvidence(reference.text || '').isSourceLike;
}

function sameTopLevelBlock(a, b) {
	return a?.[0] !== undefined && a[0] === b?.[0];
}

function createSupport(referenceIndex) {
	const support = new Map();
	for (const run of referenceIndex.runs) {
		const sourceLikeEntries = run.references.filter(isSourceLike);
		support.set(run, {
			run,
			entryCount: run.references.length,
			sourceLikeEntries: sourceLikeEntries.length,
			sourceLikeRatio: run.references.length ? sourceLikeEntries.length / run.references.length : 0,
			mentionCount: 0,
			matchedEntries: new Set(),
			specificMatchedEntries: new Set(),
			identifierMatchedEntries: new Set(),
			accepted: false,
			reason: null,
		});
	}
	return support;
}

function countMentionSupport(support, mention, references) {
	const hasSpecificKey = mention.keys.some(key => key.type === 'authorYear' || key.type === 'identifier');
	const hasIdentifierKey = mention.keys.some(key => key.type === 'identifier');
	const countedRuns = new Set();
	for (const reference of references) {
		if (sameTopLevelBlock(mention.src.blockRef, reference.src.blockRef)) {
			continue;
		}
		const item = support.get(reference.run);
		if (!item) {
			continue;
		}
		if (!countedRuns.has(reference.run)) {
			item.mentionCount++;
			countedRuns.add(reference.run);
		}
		item.matchedEntries.add(reference);
		if (hasSpecificKey) {
			item.specificMatchedEntries.add(reference);
		}
		if (hasIdentifierKey) {
			item.identifierMatchedEntries.add(reference);
		}
	}
}

function acceptSupport(item) {
	const matchedEntries = item.matchedEntries.size;
	const specificMatchedEntries = item.specificMatchedEntries.size;
	const identifierMatchedEntries = item.identifierMatchedEntries.size;

	if (identifierMatchedEntries > 0) {
		return 'identifier-support';
	}
	if (item.sourceLikeEntries >= REFERENCE_RUN_SUPPORT.MIN_SOURCE_LIKE_ENTRIES_WITH_SUPPORT
		&& (specificMatchedEntries >= REFERENCE_RUN_SUPPORT.MIN_SPECIFIC_MATCHED_ENTRIES
			|| matchedEntries >= REFERENCE_RUN_SUPPORT.MIN_MATCHED_ENTRIES
			|| item.mentionCount >= REFERENCE_RUN_SUPPORT.MIN_MENTION_COUNT)) {
		return 'citation-support';
	}
	if (item.entryCount >= REFERENCE_RUN_SUPPORT.MIN_SOURCE_SHAPE_ENTRIES
		&& item.sourceLikeRatio >= REFERENCE_RUN_SUPPORT.SOURCE_SHAPE_ACCEPTANCE_RATIO) {
		return 'source-shape';
	}
	if (item.entryCount <= REFERENCE_RUN_SUPPORT.SMALL_RUN_MAX_ENTRIES
		&& item.sourceLikeEntries === item.entryCount
		&& specificMatchedEntries >= 1) {
		return 'small-run-support';
	}
	return null;
}

export function getReferenceRunSupport(structure, referenceIndex, structureIndex) {
	const support = createSupport(referenceIndex);
	const mentionWindows = getMentionWindows(structure, referenceIndex, structureIndex, {
		includeProseIdentity: false,
	});
	const context = createCitationResolutionContext(mentionWindows, referenceIndex);
	for (const mention of mentionWindows) {
		countMentionSupport(
			support,
			mention,
			resolveAllowedMention(mention, referenceIndex, context)
		);
	}
	for (const item of support.values()) {
		item.reason = acceptSupport(item);
		item.accepted = !!item.reason;
	}
	return support;
}

export function getSupportedReferenceLists(structure, referenceIndex, structureIndex) {
	const support = getReferenceRunSupport(structure, referenceIndex, structureIndex);
	return referenceIndex.runs.filter(run => support.get(run)?.accepted);
}

export function getReferenceEntrySourceShape(reference) {
	return isSourceLike(reference) ? 'source' : null;
}

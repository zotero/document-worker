/**
 * Text node utilities for merging, comparing, and extracting content.
 */

function deepEqual(a, b) {
	if (a === b) return true;
	if (a == null || b == null) return false;

	const aIsArray = Array.isArray(a);
	const bIsArray = Array.isArray(b);
	if (aIsArray || bIsArray) {
		if (!aIsArray || !bIsArray || a.length !== b.length) return false;
		for (let i = 0; i < a.length; i++) {
			if (!deepEqual(a[i], b[i])) return false;
		}
		return true;
	}

	if (typeof a !== 'object' || typeof b !== 'object') return false;

	const aKeys = Object.keys(a);
	const bKeys = Object.keys(b);
	if (aKeys.length !== bKeys.length) return false;

	for (const key of aKeys) {
		if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
		if (!deepEqual(a[key], b[key])) return false;
	}

	return true;
}

/**
 * Check if two text nodes can be merged (same style, refs, target).
 */
export function canMergeTextNodes(a, b) {
	if (!a || !b || typeof a.text !== 'string' || typeof b.text !== 'string') {
		return false;
	}

	const aHasTextMap = typeof a.anchor?.textMap === 'string';
	const bHasTextMap = typeof b.anchor?.textMap === 'string';

	return (
		aHasTextMap === bHasTextMap &&
		deepEqual(a.style ?? null, b.style ?? null) &&
		deepEqual(a.refs ?? null, b.refs ?? null) &&
		deepEqual(a.target ?? null, b.target ?? null)
	);
}

function readTextMapRuns(anchor) {
	if (!anchor || typeof anchor.textMap !== 'string') {
		return null;
	}

	try {
		const parsed = JSON.parse(anchor.textMap);
		return Array.isArray(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

/**
 * Merge adjacent text nodes with same style/refs/target in-place.
 */
export function mergeSequentialTextNodes(content) {
	if (!Array.isArray(content) || content.length === 0) {
		return content;
	}

	const merged = [];
	let current = null;
	let currentRuns = null;
	let currentTextMapUpdated = false;

	const finalizeCurrent = () => {
		if (!current) return;
		if (currentTextMapUpdated && currentRuns) {
			const anchor = current.anchor && typeof current.anchor === 'object'
				? { ...current.anchor }
				: {};
			anchor.textMap = JSON.stringify(currentRuns);
			current.anchor = anchor;
		}
		merged.push(current);
		current = null;
		currentRuns = null;
		currentTextMapUpdated = false;
	};

	for (const node of content) {
		const isTextNode = node && typeof node.text === 'string';

		if (!isTextNode) {
			finalizeCurrent();
			merged.push(node);
			continue;
		}

		if (!current) {
			current = { ...node };
			currentRuns = readTextMapRuns(node.anchor);
			continue;
		}

		if (!canMergeTextNodes(current, node)) {
			finalizeCurrent();
			current = { ...node };
			currentRuns = readTextMapRuns(node.anchor);
			continue;
		}

		current.text += node.text;

		const runs = readTextMapRuns(node.anchor);
		if (runs) {
			if (!currentRuns) currentRuns = [];
			currentRuns.push(...runs);
			currentTextMapUpdated = true;
		}
	}

	finalizeCurrent();

	content.length = 0;
	content.push(...merged);
	return content;
}

/**
 * Get plain text content from a block.
 */
export function getBlockPlainText(block) {
	const nodes = Array.isArray(block?.content) ? block.content : [];
	if (nodes.length === 0) {
		return '';
	}

	let text = '';
	for (const node of nodes) {
		if (node && typeof node.text === 'string') {
			text += node.text;
		}
	}

	return text;
}
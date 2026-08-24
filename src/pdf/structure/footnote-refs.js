import { createStructureIndex, getBlockRefKey } from './structure-index.js';

const SOURCE_TYPES = new Set(['paragraph', 'listitem', 'heading', 'caption']);
const TARGET_TYPES = new Set(['paragraph', 'listitem', 'note']);

function getFlowClass(structure, entry) {
	return entry.block.flowClass || structure.content[entry.ref[0]]?.flowClass || 'body';
}

function firstNonSpace(text) {
	for (let i = 0; i < text.length; i++) {
		if (!/\s/u.test(text[i])) return i;
	}
	return -1;
}

function isSuperscriptDigit(bt, offset) {
	return /[0-9]/.test(bt.text[offset]) && bt.attrs[offset]?.style?.sup === true;
}

function readDecimal(bt, start) {
	if (!isSuperscriptDigit(bt, start)) return null;
	let end = start;
	while (isSuperscriptDigit(bt, end + 1)) end++;
	return {
		value: bt.text.slice(start, end + 1).replace(/^0+/, '') || '0',
		start,
		end,
	};
}

function getWrapper(text, start, end) {
	if (text[start - 1] === '(' && text[end + 1] === ')') return 'parentheses';
	if (text[start - 1] === '[' && text[end + 1] === ']') return null;
	return 'plain';
}

function getLeadingLabel(entry) {
	if (!TARGET_TYPES.has(entry.block.type)) return null;
	const first = firstNonSpace(entry.bt.text);
	const wrapper = entry.bt.text[first] === '(' ? 'parentheses' : 'plain';
	const label = readDecimal(entry.bt, first + (wrapper === 'parentheses' ? 1 : 0));
	if (!label) return null;
	const suffix = label.end + (wrapper === 'parentheses' ? 2 : 1);
	if ((wrapper === 'parentheses' && entry.bt.text[label.end + 1] !== ')')
		|| (wrapper === 'plain' && /^(?:st|nd|rd|th)(?!\p{L})/iu.test(entry.bt.text.slice(suffix)))
		|| !/\p{L}/u.test(entry.bt.text.slice(suffix))) return null;
	return { ...label, wrapper };
}

function isInsideSquareBrackets(text, start, end) {
	return text.lastIndexOf('[', start) > text.lastIndexOf(']', start)
		&& text.indexOf(']', end + 1) >= 0;
}

function getMarkers(entry) {
	if (!SOURCE_TYPES.has(entry.block.type)) return [];
	const markers = [];
	const first = firstNonSpace(entry.bt.text);
	for (let i = 0; i < entry.bt.text.length; i++) {
		const label = readDecimal(entry.bt, i);
		if (!label) continue;
		i = label.end;
		const wrapper = getWrapper(entry.bt.text, label.start, label.end);
		const labelStart = wrapper === 'parentheses' ? label.start - 1 : label.start;
		if (wrapper === null
			|| labelStart === first
			|| isInsideSquareBrackets(entry.bt.text, label.start, label.end)
			|| /[\p{L}\p{M}\p{N}]/u.test(entry.bt.text[label.end + 1] || '')) continue;
		markers.push({
			...label,
			wrapper,
			entry,
			src: {
				blockRef: entry.ref,
				offsetStart: label.start,
				offsetEnd: label.end,
				text: entry.bt.text.slice(label.start, label.end + 1),
			},
		});
	}
	return markers;
}

function labelsIncrease(targets) {
	for (let i = 1; i < targets.length; i++) {
		const a = targets[i - 1].label.value;
		const b = targets[i].label.value;
		if (a.length > b.length || (a.length === b.length && a >= b)) return false;
	}
	return true;
}

function overlapsInternalRef(existingRefs, marker) {
	return (existingRefs?.get(getBlockRefKey(marker.src.blockRef)) || []).some(ref => (
		Array.isArray(ref.dest?.blockRef)
		&& Number.isInteger(ref.src?.offsetStart)
		&& Number.isInteger(ref.src?.offsetEnd)
		&& marker.start <= ref.src.offsetEnd
		&& ref.src.offsetStart <= marker.end
	));
}

function getPageRefs(structure, entries, existingRefs) {
	entries = entries
		.filter(entry => getFlowClass(structure, entry) !== 'excluded')
		.map((entry, order) => ({ ...entry, order }));
	const targets = [];
	for (let i = entries.length - 1; i >= 0; i--) {
		const label = getLeadingLabel(entries[i]);
		if (!label) break;
		targets.unshift({ entry: entries[i], label });
	}
	if (!targets.length || !labelsIncrease(targets)) return [];

	const firstTargetOrder = targets[0].entry.order;
	const markersByLabel = new Map(targets.map(target => [target.label.value, []]));
	for (const entry of entries.slice(0, firstTargetOrder)) {
		for (const marker of getMarkers(entry)) {
			if (markersByLabel.has(marker.value)) markersByLabel.get(marker.value).push(marker);
		}
	}

	const matches = targets.flatMap(target => {
		const markers = markersByLabel.get(target.label.value)
			.filter(marker => marker.wrapper === target.label.wrapper);
		return markers.length === 1 ? [{ marker: markers[0], target }] : [];
	});
	if (targets.length > 1 && matches.length < 2) return [];
	for (let i = 1; i < matches.length; i++) {
		const a = matches[i - 1].marker;
		const b = matches[i].marker;
		if (a.entry.order > b.entry.order
			|| (a.entry.order === b.entry.order && a.start >= b.start)) return [];
	}

	return matches
		.filter(({ marker }) => !overlapsInternalRef(existingRefs, marker))
		.map(({ marker, target }) => ({
			src: marker.src,
			dest: { blockRef: target.entry.ref },
			type: 'footnote',
		}));
}

export function getFootnoteRefs(
	structure,
	existingRefs = null,
	structureIndex = createStructureIndex(structure)
) {
	const refs = new Map();
	for (let pageIndex = 0; pageIndex < structure.catalog.pages.length; pageIndex++) {
		structureIndex.withPageEntries(pageIndex, entries => {
			for (const ref of getPageRefs(structure, entries, existingRefs)) {
				const key = getBlockRefKey(ref.src.blockRef);
				if (!refs.has(key)) refs.set(key, []);
				refs.get(key).push(ref);
			}
		});
	}
	return refs;
}

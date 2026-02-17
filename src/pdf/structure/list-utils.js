import { mergePageRects } from './util.js';

// wrap continous 'listitem' blocks into 'list' block
// you also need to update structure.pages.contentRanges accordingly
export function wrapListItems(structure) {
	if (!structure || !Array.isArray(structure.content) || structure.content.length === 0) {
		return structure;
	}

	const originalContent = structure.content;
	const newContent = [];
	const listItemMap = new Map();
	const indexMap = new Map();

	let i = 0;
	while (i < originalContent.length) {
		const block = originalContent[i];

		if (block && block.type === 'listitem') {
			const listIndex = newContent.length;
			const items = [];

			while (i < originalContent.length && originalContent[i]?.type === 'listitem') {
				listItemMap.set(i, { listIndex, itemIndex: items.length });
				items.push(originalContent[i]);
				i++;
			}

			const combinedRects = mergePageRects(items);
			const listBlock = {
				type: 'list',
				...(combinedRects && { anchor: { pageRects: combinedRects } }),
				content: items
			};

			newContent.push(listBlock);
			continue;
		}

		indexMap.set(i, newContent.length);
		newContent.push(block);
		i++;
	}

	if (listItemMap.size === 0) {
		return structure;
	}

	const mapRef = (ref) => {
		if (!Array.isArray(ref) || ref.length === 0) {
			return ref;
		}

		const oldIndex = ref[0];
		const listInfo = listItemMap.get(oldIndex);
		if (listInfo) {
			return [listInfo.listIndex, listInfo.itemIndex, ...ref.slice(1)];
		}

		const mappedIndex = indexMap.get(oldIndex);
		if (!Number.isInteger(mappedIndex)) {
			return ref;
		}

		return [mappedIndex, ...ref.slice(1)];
	};

	const updateRefPath = (ref) => {
		const mapped = mapRef(ref);
		if (mapped === ref || !Array.isArray(mapped)) {
			return;
		}
		ref.length = 0;
		ref.push(...mapped);
	};

	const updateRefsArray = (refs) => {
		if (!Array.isArray(refs)) {
			return;
		}
		for (const ref of refs) {
			updateRefPath(ref);
		}
	};

	const updateNodeRefs = (node) => {
		if (!node || typeof node !== 'object') {
			return;
		}

		if (Array.isArray(node.ref)) {
			updateRefPath(node.ref);
		}

		updateRefsArray(node.refs);

		if (Array.isArray(node.content)) {
			for (const child of node.content) {
				updateNodeRefs(child);
			}
		}

	};

	structure.content = newContent;

	for (const block of structure.content) {
		updateNodeRefs(block);
	}

	if (structure.outline) {
		updateNodeRefs(structure.outline);
	}

	if (Array.isArray(structure.pages)) {
		for (const page of structure.pages) {
			if (!page || !Array.isArray(page.contentRanges)) {
				continue;
			}
			for (const range of page.contentRanges) {
				if (range?.start?.ref) {
					updateRefPath(range.start.ref);
				}
				if (range?.end?.ref) {
					updateRefPath(range.end.ref);
				}
			}
		}
	}

	return structure;
}

// Merge continuous lists, and ofcourse update structure.pages.contentRanges
export function mergeLists(structure) {
	if (!structure || !Array.isArray(structure.content) || structure.content.length === 0) {
		return structure;
	}

	const originalContent = structure.content;
	const newContent = [];
	const listMap = new Map();
	const indexMap = new Map();
	let mergedAny = false;

	let i = 0;
	while (i < originalContent.length) {
		const block = originalContent[i];

		if (block && block.type === 'list') {
			const mergedIndex = newContent.length;
			const mergedItems = [];
			const mergedRefs = [];
			const listsToMerge = [];
			let baseBlock = block;
			let groupSize = 0;

			while (i < originalContent.length && originalContent[i]?.type === 'list') {
				const listBlock = originalContent[i];
				groupSize++;
				listsToMerge.push(listBlock);

				const listItems = Array.isArray(listBlock.content) ? listBlock.content : [];

				listMap.set(i, { mergedIndex, itemOffset: mergedItems.length });
				mergedItems.push(...listItems);

				if (Array.isArray(listBlock.refs)) {
					mergedRefs.push(...listBlock.refs);
				}

				i++;
			}

			if (groupSize > 1) {
				mergedAny = true;
			}

			const combinedRects = mergePageRects(listsToMerge);
			const mergedBlock = {
				...baseBlock,
				...(combinedRects && { anchor: { pageRects: combinedRects } }),
				content: mergedItems
			};

			if (mergedRefs.length > 0) {
				mergedBlock.refs = mergedRefs;
			}

			newContent.push(mergedBlock);
			continue;
		}

		indexMap.set(i, newContent.length);
		newContent.push(block);
		i++;
	}

	if (!mergedAny) {
		return structure;
	}

	const mapRef = (ref) => {
		if (!Array.isArray(ref) || ref.length === 0) {
			return ref;
		}

		const oldIndex = ref[0];
		const listInfo = listMap.get(oldIndex);
		if (listInfo) {
			if (ref.length > 1 && Number.isInteger(ref[1])) {
				return [listInfo.mergedIndex, listInfo.itemOffset + ref[1], ...ref.slice(2)];
			}
			return [listInfo.mergedIndex, ...ref.slice(1)];
		}

		const mappedIndex = indexMap.get(oldIndex);
		if (!Number.isInteger(mappedIndex)) {
			return ref;
		}

		return [mappedIndex, ...ref.slice(1)];
	};

	const updateRefPath = (ref) => {
		const mapped = mapRef(ref);
		if (mapped === ref || !Array.isArray(mapped)) {
			return;
		}
		ref.length = 0;
		ref.push(...mapped);
	};

	const updateRefsArray = (refs) => {
		if (!Array.isArray(refs)) {
			return;
		}
		for (const ref of refs) {
			updateRefPath(ref);
		}
	};

	const updateNodeRefs = (node) => {
		if (!node || typeof node !== 'object') {
			return;
		}

		if (Array.isArray(node.ref)) {
			updateRefPath(node.ref);
		}

		updateRefsArray(node.refs);

		if (Array.isArray(node.content)) {
			for (const child of node.content) {
				updateNodeRefs(child);
			}
		}

	};

	structure.content = newContent;

	for (const block of structure.content) {
		updateNodeRefs(block);
	}

	if (structure.outline) {
		updateNodeRefs(structure.outline);
	}

	if (Array.isArray(structure.pages)) {
		for (const page of structure.pages) {
			if (!page || !Array.isArray(page.contentRanges)) {
				continue;
			}
			for (const range of page.contentRanges) {
				if (range?.start?.ref) {
					updateRefPath(range.start.ref);
				}
				if (range?.end?.ref) {
					updateRefPath(range.end.ref);
				}
			}
		}
	}

	return structure;
}

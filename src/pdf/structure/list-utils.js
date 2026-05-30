import { mergePageRects } from './util.js';
import { normalizeFlowClass, resolveFlowClass } from './flow-policy.js';

function getMajorityFlowClass(blocks) {
	const counts = {
		body: 0,
		auxiliary: 0,
		excluded: 0,
	};

	for (const block of blocks) {
		counts[resolveFlowClass(block)]++;
	}

	let majorityFlowClass = 'body';
	for (const flowClass of ['auxiliary', 'excluded']) {
		if (counts[flowClass] > counts[majorityFlowClass]) {
			majorityFlowClass = flowClass;
		}
	}

	return normalizeFlowClass(majorityFlowClass);
}

// Wrap continuous 'listitem' blocks into 'list' blocks.
export function wrapListItems(structure) {
	if (!structure || !Array.isArray(structure.content) || structure.content.length === 0) {
		return structure;
	}

	const originalContent = structure.content;
	const newContent = [];
	const listItemMap = new Map();
	const indexMap = new Map();
	const listGroups = [];

	let i = 0;
	while (i < originalContent.length) {
		const block = originalContent[i];

		if (block && block.type === 'listitem') {
			const listIndex = newContent.length;
			const oldStart = i;
			const items = [];
			const pageIndex = block._metrics?.pageIndex;

			while (
				i < originalContent.length
				&& originalContent[i]?.type === 'listitem'
				&& originalContent[i]?._metrics?.pageIndex === pageIndex
			) {
				listItemMap.set(i, { listIndex, itemIndex: items.length });
				items.push(originalContent[i]);
				i++;
			}
			listGroups.push({
				oldStart,
				oldEnd: i,
				listIndex,
			});

			const combinedRects = mergePageRects(items);
			const flowClass = getMajorityFlowClass(items);
			const listBlock = {
				type: 'list',
				...(flowClass && { flowClass }),
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
		if (oldIndex === originalContent.length && ref.length === 1) {
			return [newContent.length];
		}

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

	const mapBoundary = (boundary) => {
		if (!Array.isArray(boundary) || boundary.length === 0) {
			return boundary;
		}

		const oldIndex = boundary[0];
		if (oldIndex === originalContent.length && boundary.length === 1) {
			return [newContent.length];
		}

		if (boundary.length === 1) {
			for (const group of listGroups) {
				if (oldIndex === group.oldStart) {
					return [group.listIndex];
				}
				if (oldIndex > group.oldStart && oldIndex < group.oldEnd) {
					return [group.listIndex, oldIndex - group.oldStart];
				}
			}
		}

		return mapRef(boundary);
	};

	const updateRefPath = (ref) => {
		const mapped = mapRef(ref);
		if (mapped === ref || !Array.isArray(mapped)) {
			return;
		}
		ref.length = 0;
		ref.push(...mapped);
	};

	const updateBoundaryPath = (boundary) => {
		const mapped = mapBoundary(boundary);
		if (mapped === boundary || !Array.isArray(mapped)) {
			return;
		}
		boundary.length = 0;
		boundary.push(...mapped);
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
		updateRefsArray(node.backRefs);
		updateRefPath(node.previousPart);
		updateRefPath(node.nextPart);

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

	if (Array.isArray(structure.catalog.pages)) {
		for (const page of structure.catalog.pages) {
			if (!Array.isArray(page?.contentRange)) {
				continue;
			}
			for (const boundary of page.contentRange) {
				updateBoundaryPath(boundary);
			}
		}
	}

	return structure;
}

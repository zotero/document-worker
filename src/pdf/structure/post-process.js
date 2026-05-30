function degradeSingleItemLists(structure) {
	if (!structure || !Array.isArray(structure.content)) {
		return structure;
	}

	for (let i = 0; i < structure.content.length; i++) {
		const block = structure.content[i];
		const items = block?.type === 'list' && Array.isArray(block.content)
			? block.content.filter(item => item?.type === 'listitem')
			: [];
		if (items.length !== 1 || block.content.length !== 1) {
			continue;
		}

		const item = items[0];
		structure.content[i] = {
			...item,
			type: 'paragraph',
			content: Array.isArray(item.content) ? item.content : [],
		};
	}

	return structure;
}

export function postProcessStructure(structure) {
	degradeSingleItemLists(structure);
	return structure;
}

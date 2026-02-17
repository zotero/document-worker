export function exportOutline(structure) {
	const outline = Array.isArray(structure?.outline) ? structure.outline : [];

	function normalizeItem(item) {
		if (!item || typeof item !== 'object') return null;
		if (typeof item.title !== 'string' || !item.title) return null;
		if (!Array.isArray(item.ref) || !item.ref.length) return null;

		const children = Array.isArray(item.children)
			? item.children.map(normalizeItem).filter(Boolean)
			: [];
		const normalized = {
			title: item.title,
			startRef: item.ref.join('.'),
		};
		if (children.length) {
			normalized.children = children;
		}
		return normalized;
	}

	return outline.map(normalizeItem).filter(Boolean);
}

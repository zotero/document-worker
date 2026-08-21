const EXCLUDED_FLOW_CLASS = 'excluded';
const NON_BODY_FLOW_CLASSES = new Set(['auxiliary', EXCLUDED_FLOW_CLASS]);

export function resolveFlowClass(blockOrFlowClass) {
	const flowClass = typeof blockOrFlowClass === 'string'
		? blockOrFlowClass
		: blockOrFlowClass?.flowClass;
	return NON_BODY_FLOW_CLASSES.has(flowClass) ? flowClass : 'body';
}

export function normalizeFlowClass(blockOrFlowClass) {
	const flowClass = resolveFlowClass(blockOrFlowClass);
	return flowClass === 'body' ? undefined : flowClass;
}

export function isBodyFlowBlock(block) {
	return !!block && normalizeFlowClass(block) == null;
}

export function isTransparentBetweenParts(block) {
	return !block || normalizeFlowClass(block) != null;
}

export function canCrossPagePartLink(structure, firstMetrics, secondMetrics) {
	if (!firstMetrics || !secondMetrics) {
		return false;
	}
	if (secondMetrics.pageIndex === firstMetrics.pageIndex) {
		return true;
	}
	if (secondMetrics.pageIndex !== firstMetrics.pageIndex + 1) {
		return false;
	}
	return !isDegradedExtractionPage(structure, firstMetrics.pageIndex)
		&& !isDegradedExtractionPage(structure, secondMetrics.pageIndex);
}

export function normalizePdfRawBlockFlow(block) {
	if (!block || typeof block !== 'object') {
		return block;
	}

	const flowClass = resolveFlowClass(block);
	setNormalizedFlowClass(block, flowClass);
	if (flowClass === EXCLUDED_FLOW_CLASS) {
		block.type = 'body';
	}
	return block;
}

export function setNormalizedFlowClass(block, blockOrFlowClass) {
	if (!block || typeof block !== 'object') {
		return;
	}
	const flowClass = normalizeFlowClass(blockOrFlowClass);
	if (flowClass) {
		block.flowClass = flowClass;
	}
	else {
		delete block.flowClass;
	}
}

export function normalizeTopLevelFlowClasses(structure) {
	if (!structure || !Array.isArray(structure.content)) {
		return structure;
	}

	for (const block of structure.content) {
		setNormalizedFlowClass(block, block);
		removeNestedFlowClasses(block);
	}

	return structure;
}

export function suppressAuxiliaryFlowOnRasterTextPages(structure, rasterTextPageIndexes) {
	if (!structure || !Array.isArray(structure.content) || !(rasterTextPageIndexes instanceof Set)) {
		return structure;
	}

	for (const block of structure.content) {
		if (block?.flowClass !== 'auxiliary') {
			continue;
		}
		const pageIndexes = [...new Set((block.anchor?.pageRects || [])
			.map(rect => rect?.[0])
			.filter(Number.isInteger))];
		if (pageIndexes.length && pageIndexes.every(pageIndex => rasterTextPageIndexes.has(pageIndex))) {
			delete block.flowClass;
		}
	}
	return structure;
}

function isDegradedExtractionPage(structure, pageIndex) {
	return Number.isInteger(pageIndex)
		&& structure?.catalog?.pages?.[pageIndex]?.extractionDegraded === true;
}

function removeNestedFlowClasses(block) {
	if (!block || typeof block !== 'object' || !Array.isArray(block.content)) {
		return;
	}

	for (const child of block.content) {
		if (!child || typeof child !== 'object') {
			continue;
		}
		delete child.flowClass;
		removeNestedFlowClasses(child);
	}
}

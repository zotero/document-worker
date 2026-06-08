import { createFallbackTableNode } from './output.js';

function createFallbackNode({ pageIndex, block, chars }) {
	return createFallbackTableNode({ pageIndex, block, chars });
}

export async function extractStructuredTable({
	pageIndex,
	block,
	chars,
}) {
	return createFallbackNode({ pageIndex, block, chars });
}

export async function extractStructuredTables(requests) {
	return requests.map(createFallbackNode);
}

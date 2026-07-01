import { charsToTextNodes } from '../../../../structured-document-text/src/pdf/index.js';
import { createBlockAnchor } from '../util.js';

export function createTableNode({ pageIndex, block, chars }) {
	const anchor = createBlockAnchor(pageIndex, block.bbox);
	return {
		type: 'table',
		...(anchor && { anchor }),
		content: charsToTextNodes(pageIndex, chars),
	};
}

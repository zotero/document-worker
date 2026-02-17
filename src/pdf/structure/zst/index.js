/**
 * ZST - Zotero Structured Text
 *
 * This module provides utilities for encoding, decoding, and manipulating
 * structured text content extracted from PDFs.
 *
 * File organization by concern:
 * - constants.js  : Header flags and basic helpers
 * - encode.js     : Convert chars to text nodes (charsToTextNodes)
 * - decode.js     : Reconstruct positions from textMap (reconstructCharPositions)
 * - text-node.js  : Text node utilities (merge, compare, plain text)
 * - block.js      : Block operations (navigation, manipulation, ranges)
 * - debug.js      : Debug utilities (compareRunErrors, printOptimizationReport)
 */

// Constants
export {
	HEADER_LAST_IS_SOFT_HYPHEN,
	HEADER_AXIS_DIR_SHIFT,
	HEADER_DIR_RTL,
	EPS,
	isVertical,
} from './constants.js';

// Encoding (char → text node)
export { charsToTextNodes } from './encode.js';

// Decoding (textMap → positions)
export {
	parseTextMap,
	reconstructCharPositions,
	buildRunData,
} from './decode.js';

// Text node utilities
export {
	canMergeTextNodes,
	mergeSequentialTextNodes,
	getBlockPlainText,
} from './text-node.js';

// Block operations
export {
	// Navigation
	getBlockByRef,
	getBlockText,
	getNextBlockRef,
	// Manipulation
	applyTextAttributes,
	getTextNodesAtRange,
	// Ranges
	getContentRangeFromBlocks,
	pushArtifactsToTheEnd,
	mergeBlocks,
	// Cursors
	nextChar,
	nextBlockChar,
} from './block.js';

// Debug utilities
export {
	compareRunErrors,
	printOptimizationReport,
} from './debug.js';
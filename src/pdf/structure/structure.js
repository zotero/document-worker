import { inference } from './model/line-seg/inference.js';
import { getOutline } from './outline/outline.js';
import { getReferenceLists } from './reference/reference.js';
import { getCandidates } from './candidate.js';
import { getFigures } from './figure.js';
import { getMathBlocks } from './math.js';
import { updateRegularWordsSet } from './reference/regular-words.js';
import { getReferenceIndex } from './reference/index.js';
// import { getLinkOverlays } from './link.js';
import { addPageLabels } from './page-label.js';
import { applyRefs, getRefsList } from './overlays.js';
import {
	charsToTextNodes,
	charsToPreformattedTextNodes,
	getContentRangeFromBlocks,
	mergeBlocks,
	pushArtifactsToTheEnd,
} from './zst/index.js';
import { mergeLists, wrapListItems } from './list-utils.js';
import { addRefs, getParsedLinkRefs, getAnnotLinkRefs, getLinksFromAnnotations } from './link.js';
import { cleanupBlockMetrics, cleanupTextNodeStyles, getHeadingMetrics, getParagraphMetrics, mergeParagraphs } from './paragraph-utils.js';
import { createBlockAnchor, ensureBlockPageRects } from './util.js';
// import { getNextChunk } from './structured-text-utils/chunker.js';
// import { getContent, getRefRangesFromPageRects } from './structured-text-utils/block.js';

const SCHEMA_VERSION = '1.0.0-draft';
const PROCESSOR_VERSION = '1.0.0-draft';

export async function getFullStructure(pdfDocument, onnxRuntimeProvider, modelProvider) {
	const pageCount = pdfDocument.numPages;

	let structure = {
		schemaVersion: SCHEMA_VERSION,
		processor: {
			type: 'pdf',
			version: PROCESSOR_VERSION
		},
		dateCreated: new Date().toISOString(),
		sourceContentType: 'application/pdf',
		sourceHash: '',
		metadata: {},
		pages: [],
		content: []
	};

	let docInfo = pdfDocument.documentInfo;
	let metadata = {};
	if (docInfo.PDFFormatVersion) {
		metadata.PDFFormatVersion = docInfo.PDFFormatVersion;
	}
	let infoKeys = ['Title', 'Author', 'Subject', 'Keywords', 'Creator', 'Producer', 'CreationDate', 'ModDate', 'Language'];
	for (let key of infoKeys) {
		if (typeof docInfo[key] === 'string') {
			metadata[key] = docInfo[key];
		}
	}
	let skipKeys = new Set([
		'PDFFormatVersion', 'EncryptFilterName',
		'IsLinearized', 'IsAcroFormPresent', 'IsXFAPresent',
		'IsCollectionPresent', 'IsSignaturesPresent',
		...infoKeys,
	]);
	if (docInfo.Custom) {
		for (let key in docInfo.Custom) {
			if (skipKeys.has(key)) continue;
			let value = docInfo.Custom[key];
			if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
				metadata[key] = value;
			}
		}
	}
	structure.metadata = metadata;

	// internal and external links
	let linkMap = new Map();

	let regularWordsSet = new Set();
	let catalogPageLabels = await pdfDocument.pdfManager.ensureCatalog("pageLabels");

	for (let i = 0; i < pageCount; i++) {

		let prevContentLength = structure.content.length;

		let { chars, objects } = await pdfDocument.module.getPageCharsObjects(i);

		updateRegularWordsSet(chars, regularWordsSet);

		let page = await pdfDocument.getPage(i);

		let links = await getLinksFromAnnotations(pdfDocument, page);
		if (links.length) {
			linkMap.set(i, links);
		}

		let pageDataList = [{ chars, objects, viewBox: page.view }];
		let blocks = [];

		if (chars.length) {
			let val= {};
			blocks = await inference(pageDataList, onnxRuntimeProvider, modelProvider, val);
		}

		for (let j = 0; j < blocks.length; j++) {
			let block = blocks[j];
			block.blockIndex = j;
			block.pageIndex = i;
		}

		chars.forEach(x => x.pageIndex = i);
		for (let bi = 0; bi < blocks.length; bi++) {
			let block = blocks[bi];

			let charsRange = chars.slice(block.startOffset, block.endOffset + 1);

			let node;
			let anchor = createBlockAnchor(i, block.bbox);
			if (block.type === 'title') {
				node = {
					type: 'heading',
					...(anchor && { anchor }),
					content: charsToTextNodes(i, charsRange),
					_metrics: getHeadingMetrics(block, charsRange)
				}
			}
			else if (block.type === 'body') {
				node = {
					type: 'paragraph',
					...(anchor && { anchor }),
					content: charsToTextNodes(i, charsRange),
					_metrics: getParagraphMetrics(block, charsRange)
				}
			}
			else if (block.type === 'caption') {
				node = {
					type: 'caption',
					...(anchor && { anchor }),
					content: charsToTextNodes(i, charsRange)
				}
			}
			else if (block.type === 'image') {
				node = {
					type: 'image',
					...(anchor && { anchor }),
					content: charsToTextNodes(i, charsRange)
				}
			}
			else if (block.type === 'table') {
				node = {
					type: 'table',
					...(anchor && { anchor }),
					content: charsToTextNodes(i, charsRange)
				}
			}
			else if (block.type === 'footnote') {
				node = {
					type: 'note',
					...(anchor && { anchor }),
					content: charsToTextNodes(i, charsRange)
				}
			}
			else if (block.type === 'list_item') {
				node = {
					type: 'listitem',
					...(anchor && { anchor }),
					content: charsToTextNodes(i, charsRange)
				}
			}
			else if (block.type === 'equation') {
				node = {
					type: 'math',
					...(anchor && { anchor }),
					content: charsToTextNodes(i, charsRange)
				}
			}
			else if (block.type === 'preformatted') {
				node = {
					type: 'preformatted',
					...(anchor && { anchor }),
					content: charsToPreformattedTextNodes(i, charsRange)
				}
			}
			else if (block.type === 'frame') {
				node = {
					type: 'paragraph',
					artifact: true,
					...(anchor && { anchor }),
					content: charsToTextNodes(i, charsRange)
				}
			}
			else {
				throw new Error(`Unknown block type: ${block.type}`);
			}

			if (node) {
				structure.content.push(node);
			}

			if (block.type === 'title') {
				let titleChars = chars.slice(block.startOffset, block.endOffset + 1);
				block.avgFontSize = Math.round(
					titleChars.reduce((acc, x) => acc + x.fontSize, 0) / titleChars.length
				);
			}
		}

		let newPage = {
			viewRect: page.view,
			contentRanges: []
		};

		if (prevContentLength < structure.content.length) {
			let contentRange = getContentRangeFromBlocks(structure.content, prevContentLength - 1, structure.content.length - 1)
			newPage.contentRanges.push(contentRange);
		}

		structure.pages.push(newPage);
	}

	// Block transformations
	wrapListItems(structure);
	pushArtifactsToTheEnd(structure);
	mergeLists(structure);
	mergeParagraphs(structure, mergeBlocks);

	// After this only text node transformations are allowed

	addPageLabels(structure, catalogPageLabels);

	let candidateGroups = new Map();

	let annotLinkRefs = getAnnotLinkRefs(structure, linkMap);
	let parsedLinkRefs = getParsedLinkRefs(structure);

	let referenceLists = getReferenceLists(structure, regularWordsSet);
	let refIndex = getReferenceIndex(referenceLists, regularWordsSet);
	let figures = getFigures(structure);
	let mathBlocks = getMathBlocks(structure);
	getCandidates(structure, candidateGroups, refIndex, figures, mathBlocks);
	let mainRefs = getRefsList(candidateGroups);

	addRefs(annotLinkRefs, parsedLinkRefs);
	addRefs(mainRefs, annotLinkRefs);

	applyRefs(structure, mainRefs);

	structure.outline = await getOutline(structure.content, [], pdfDocument);

	cleanupBlockMetrics(structure);
	cleanupTextNodeStyles(structure);
	ensureBlockPageRects(structure);

	// let chunks = [];
	// let startIndex = 0;
	// let chunk;
	// while (chunk = getNextChunk(structure, startIndex)) {
	// 	chunk.refRanges = getRefRangesFromPageRects(structure, chunk.pageRects);
	// 	chunk.content = getContent(structure, chunk.refRanges)
	// 	chunks.push(chunk);
	// 	startIndex = chunk.endBlockIndex + 1;
	// }

	return structure;
}

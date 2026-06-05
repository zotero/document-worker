import { buildInferenceErrorFallbackBlocks, inferenceBatch } from './model/block-seg/inference.js';
import { getOutline } from './outline/outline.js';
import { getReferenceLists } from './reference/reference.js';
import { getCandidates } from './citations.js';
import { getFigures } from './figure.js';
import { getMathBlocks } from './math.js';
import { updateRegularWordsSet } from './reference/regular-words.js';
import { getReferenceIndex } from './reference/index.js';
// import { getLinkOverlays } from './link.js';
import { addPageLabels } from './page-label.js';
import { applyRefs, getRefsList } from './apply-refs.js';
import {
	charsToTextNodes,
	charsToPreformattedTextNodes,
} from '../../../structured-document-text/src/pdf/index.js';
import { wrapListItems } from './list-utils.js';
import { addRefs, getParsedLinkRefs, getAnnotLinkRefs, getLinksFromAnnotations } from './link.js';
import { cleanupBlockMetrics, cleanupTextNodeStyles, getHeadingMetrics, getParagraphMetrics, markListItemParts, markParagraphParts } from './block-cleanup.js';
import { normalizePdfRawBlockFlow, normalizeTopLevelFlowClasses, setNormalizedFlowClass } from './flow-policy.js';
import { createBlockAnchor, ensureBlockPageRects } from './util.js';
import { createStructureIndex } from './structure-index.js';
import { extractStructuredTable, extractStructuredTables } from './table/extract.js';
import { postProcessStructure } from './post-process.js';
import {
	DOCUMENT_WORKER_PROCESSOR_VERSION,
	SDT_SCHEMA_VERSION,
} from '../../versions.js';
// import { getNextChunk } from '../../../structured-document-text/src/chunker.js';
// import { getContent, getRefRangesFromPageRects } from '../../../structured-document-text/src/pdf/content.js';

const DEGRADED_EXTRACTION_FALLBACK_REASONS = new Set([
	'inference_error',
	'too_many_lines',
]);

function hasDegradedExtractionFallbacks(layoutFallbacks) {
	return layoutFallbacks?.some(fallback => DEGRADED_EXTRACTION_FALLBACK_REASONS.has(fallback.reason));
}

function applyFlowClassMetadata(node, block) {
	setNormalizedFlowClass(node, block);
}

export class StructureAbortError extends Error {
	constructor() {
		super('Structured document text generation aborted');
		this.name = 'AbortError';
		this.aborted = true;
	}
}

// Options:
//   onChunk(chunk): when set, emits { kind: 'partial', ... } per batch (blocks
//     are pre-post-processing) and { kind: 'final', structure } once the
//     canonical structure is ready.
//   batchSize: pages per partial chunk (default 5).
//   shouldAbort(): checked between pages; throws StructureAbortError when truthy.
export async function getFullStructure(pdfDocument, onnxRuntimeProvider, modelProvider, options = {}) {
	const pageCount = pdfDocument.numPages;
	const onChunk = typeof options.onChunk === 'function' ? options.onChunk : null;
	const batchSize = Math.max(1, options.batchSize || 5);
	const inferenceBatchSize = Math.max(1, options.inferenceBatchSize || (onChunk ? batchSize : 8));
	const shouldAbort = typeof options.shouldAbort === 'function' ? options.shouldAbort : null;
	const sourceHash = options.sourceHash;

	function checkAbort() {
		if (shouldAbort?.()) throw new StructureAbortError();
	}

	let structure = {
		schemaVersion: SDT_SCHEMA_VERSION,
		metadata: {
			processor: {
				type: 'pdf',
				version: DOCUMENT_WORKER_PROCESSOR_VERSION
			},
			dateCreated: new Date().toISOString(),
			source: {
				contentType: 'application/pdf',
				hash: sourceHash,
				properties: {}
			}
		},
		catalog: {
			pages: [],
			outline: []
		},
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
	structure.metadata.source.properties = metadata;

	// internal and external links
	let linkMap = new Map();
	let tableGridCache = new Map();

	let regularWordsSet = new Set();
	let catalogPageLabels = await pdfDocument.pdfManager.ensureCatalog("pageLabels");

	let lastEmittedPageCount = 0;
	let lastEmittedContentCount = 0;

	async function emitPartialChunkIfDue(pageIndex, force = false) {
		if (!onChunk) return;
		let pagesInBatch = structure.catalog.pages.length - lastEmittedPageCount;
		if (!force && pagesInBatch < batchSize) return;
		if (pagesInBatch === 0) return;
		let pageIndexOffset = lastEmittedPageCount;
		let contentIndexOffset = lastEmittedContentCount;
		let chunk = {
			kind: 'partial',
			pages: structure.catalog.pages.slice(pageIndexOffset),
			content: structure.content.slice(contentIndexOffset),
			pageIndexOffset,
			contentIndexOffset,
			pageIndexRange: [pageIndexOffset, pageIndex],
			totalPageCount: pageCount,
		};
		lastEmittedPageCount = structure.catalog.pages.length;
		lastEmittedContentCount = structure.content.length;
		await onChunk(chunk);
	}

	async function appendPageContext(context) {
		let { i, chars, page, blocks, extractionDegraded } = context;
		let prevContentLength = structure.content.length;

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
				node = context.tableNodes?.get(bi)
					|| await extractStructuredTable({
						pageIndex: i,
						viewBox: page.view,
						block,
						chars: charsRange,
						onnxRuntimeProvider,
						modelProvider,
						tableGridCache,
					});
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
					content: charsToTextNodes(i, charsRange),
					_metrics: getParagraphMetrics(block, charsRange)
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
			else {
				throw new Error(`Unknown block type: ${block.type}`);
			}

			if (node) {
				applyFlowClassMetadata(node, block);
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
			...(extractionDegraded ? { extractionDegraded: true } : {}),
			contentRange: [[prevContentLength], [structure.content.length]]
		};

		structure.catalog.pages.push(newPage);

		await emitPartialChunkIfDue(i);
	}

	async function prepareTableNodesForContexts(contexts) {
		let requests = [];
		let targets = [];

		for (let context of contexts) {
			let { i, chars, page, blocks } = context;
			for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
				let block = blocks[blockIndex];
				if (block.type !== 'table') {
					continue;
				}
				requests.push({
					pageIndex: i,
					viewBox: page.view,
					block,
					chars: chars.slice(block.startOffset, block.endOffset + 1),
					onnxRuntimeProvider,
					modelProvider,
					tableGridCache,
				});
				targets.push({ context, blockIndex });
			}
		}

		if (!requests.length) {
			return;
		}

		let nodes = await extractStructuredTables(requests);
		for (let index = 0; index < nodes.length; index++) {
			let { context, blockIndex } = targets[index];
			if (!context.tableNodes) {
				context.tableNodes = new Map();
			}
			context.tableNodes.set(blockIndex, nodes[index]);
		}
	}

	async function inferBlockListsWithFallback(inferenceInputs, inferenceVals) {
		try {
			return await inferenceBatch(inferenceInputs, onnxRuntimeProvider, modelProvider, inferenceVals);
		}
		catch {
			let blockLists = [];
			for (let index = 0; index < inferenceInputs.length; index++) {
				try {
					blockLists[index] = (await inferenceBatch(
						[inferenceInputs[index]],
						onnxRuntimeProvider,
						modelProvider,
						[inferenceVals[index]],
					))[0];
				}
				catch (error) {
					blockLists[index] = buildInferenceErrorFallbackBlocks(
						inferenceInputs[index],
						inferenceVals[index],
						error,
					);
				}
			}
			return blockLists;
		}
	}

	for (let batchStart = 0; batchStart < pageCount; batchStart += inferenceBatchSize) {
		let contexts = [];
		let inferenceInputs = [];
		let inferenceVals = [];
		let inferenceContextIndexes = [];
		let batchEnd = Math.min(pageCount, batchStart + inferenceBatchSize);

		for (let i = batchStart; i < batchEnd; i++) {
			checkAbort();

			let { chars, objects } = await pdfDocument.module.getPageCharsObjects(i);

			updateRegularWordsSet(chars, regularWordsSet);

			let page = await pdfDocument.getPage(i);

			let links = await getLinksFromAnnotations(pdfDocument, page);
			if (links.length) {
				linkMap.set(i, links);
			}

			let context = { i, chars, objects, page, blocks: [], extractionDegraded: false };
			if (chars.length || objects?.length) {
				let val = {};
				inferenceInputs.push({ chars, objects, viewBox: page.view, pageIndex: i });
				inferenceVals.push(val);
				inferenceContextIndexes.push(contexts.length);
			}
			contexts.push(context);
		}

		if (inferenceInputs.length) {
			let blockLists = await inferBlockListsWithFallback(inferenceInputs, inferenceVals);
			for (let j = 0; j < blockLists.length; j++) {
				let context = contexts[inferenceContextIndexes[j]];
				let val = inferenceVals[j];
				context.blocks = blockLists[j];
				for (let block of context.blocks) {
					normalizePdfRawBlockFlow(block);
				}
				if (val.layoutFallbacks?.length) {
					context.extractionDegraded = hasDegradedExtractionFallbacks(val.layoutFallbacks);
				}
			}
		}

		checkAbort();
		await prepareTableNodesForContexts(contexts);
		checkAbort();

		for (let context of contexts) {
			checkAbort();
			await appendPageContext(context);
		}
	}

	await emitPartialChunkIfDue(pageCount - 1, true);

	// Block transformations
	wrapListItems(structure);
	postProcessStructure(structure);
	markListItemParts(structure);
	markParagraphParts(structure);
	normalizeTopLevelFlowClasses(structure);

	// After this only text node transformations are allowed

	addPageLabels(structure, catalogPageLabels);

	let candidateGroups = new Map();
	let structureIndex = createStructureIndex(structure, options.structureIndex);

	let annotLinkRefs = getAnnotLinkRefs(structure, linkMap, structureIndex);
	let parsedLinkRefs = getParsedLinkRefs(structure, structureIndex);

	let referenceLists = getReferenceLists(structure, regularWordsSet);
	for (let refList of referenceLists) {
		for (let ref of refList.references) {
			let node = structure.content[ref.src.blockRef[0]]
				?.content?.[ref.src.blockRef[1]];
			if (node) {
				node.reference = true;
			}
		}
	}
	let refIndex = getReferenceIndex(referenceLists, regularWordsSet);
	let figures = getFigures(structure);
	let mathBlocks = getMathBlocks(structure);
	getCandidates(structure, candidateGroups, refIndex, figures, mathBlocks, structureIndex);
	structureIndex.clearPageTextCache();
	let mainRefs = getRefsList(candidateGroups);

	addRefs(annotLinkRefs, parsedLinkRefs);
	addRefs(mainRefs, annotLinkRefs);

	applyRefs(structure, mainRefs);

	let outline = await getOutline(structure.content, [], pdfDocument);
	if (outline.length) {
		structure.catalog.outline = outline;
	}

	cleanupBlockMetrics(structure);
	cleanupTextNodeStyles(structure);
	ensureBlockPageRects(structure);

	if (onChunk) {
		await onChunk({ kind: 'final', structure });
	}

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

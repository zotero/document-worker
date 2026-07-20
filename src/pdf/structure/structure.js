import { buildInferenceErrorFallbackBlocks, inferenceBatch } from './model/block-seg/inference.js';
import { getNativeOutline, getOutline } from './outline/outline.js';
import { getLines } from './model/block-seg/input.js';
import {
	createContentsHeadingIndex,
	detectContentsRegion,
	getContentsEvidence,
	normalizeContentsBlocks,
} from './contents.js';
import { getReferenceLists } from './reference/reference.js';
import { getFigureAndMathCandidates } from './citations.js';
import { getFigures } from './figure.js';
import { getMathBlocks } from './math.js';
import { updateRegularWordsSet } from './reference/regular-words.js';
import { getReferenceIndex } from './reference/index.js';
import { getSupportedReferenceLists } from './reference/support.js';
// import { getLinkOverlays } from './link.js';
import { addPageLabels } from './page-label.js';
import { applyRefs, getRefsList } from './apply-refs.js';
import { getCitationRefs } from './citation-refs.js';
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
import { createTableNode } from './table/output.js';
import { postProcessStructure } from './post-process.js';
import { excludeRepeatedPageFurniture } from './page-furniture.js';
import {
	SDT_PROCESSOR_VERSIONS,
	SDT_SCHEMA_VERSION,
} from '../../versions.js';

const DEGRADED_EXTRACTION_FALLBACK_REASONS = new Set([
	'inference_error',
	'too_many_lines',
]);
// Match PDF.js's fallback for an invalid MediaBox.
const DEFAULT_PAGE_VIEW_RECT = [0, 0, 612, 792];
const VALID_PAGE_ROTATIONS = new Set([0, 90, 180, 270]);

function hasDegradedExtractionFallbacks(layoutFallbacks) {
	return layoutFallbacks?.some(fallback => DEGRADED_EXTRACTION_FALLBACK_REASONS.has(fallback.reason));
}

function normalizePageViewRect(viewRect) {
	if (
		Array.isArray(viewRect)
		&& viewRect.length === 4
		&& viewRect.every(Number.isFinite)
		&& Number.isFinite(viewRect[2] - viewRect[0])
		&& Number.isFinite(viewRect[3] - viewRect[1])
		&& viewRect[2] > viewRect[0]
		&& viewRect[3] > viewRect[1]
	) {
		return viewRect;
	}
	return DEFAULT_PAGE_VIEW_RECT.slice();
}

function applyFlowClassMetadata(node, block) {
	setNormalizedFlowClass(node, block);
}

function reportPageProgress(onProgress, pagesProcessed, pageCount) {
	if (typeof onProgress !== 'function') {
		return;
	}
	let progress;
	if (!pageCount) {
		progress = 90;
	}
	else {
		progress = 5 + (85 * pagesProcessed / pageCount);
	}
	try {
		onProgress(progress);
	}
	catch {
		// Progress reporting is best-effort and must not affect extraction.
	}
}

export async function getFullStructure(pdfDocument, onnxRuntimeProvider, modelProvider, options = {}) {
	const pageCount = pdfDocument.numPages;
	const inferenceBatchSize = Math.max(1, options.inferenceBatchSize || 8);
	const sourceHash = options.sourceHash;
	const onProgress = options.onProgress;

	let structure = {
		schemaVersion: SDT_SCHEMA_VERSION,
		metadata: {
			processor: {
				type: 'pdf',
				version: SDT_PROCESSOR_VERSIONS.pdf
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

	let regularWordsSet = new Set();
	let catalogPageLabels = await pdfDocument.pdfManager.ensureCatalog("pageLabels");
	let nativeOutline = await getNativeOutline(pdfDocument);
	let pageContentLengths = new Array(pageCount).fill(0);
	let inferredHeadings = [];
	let contentsContexts = [];
	const contentsNavigationRegions = [];
	let pagesProcessed = 0;
	reportPageProgress(onProgress, 0, pageCount);
	function getPageContentOffset(pageIndex) {
		let offset = 0;
		for (let index = 0; index < pageIndex; index++) {
			offset += pageContentLengths[index];
		}
		return offset;
	}

	async function appendPageContext(context, replace = false) {
		let { i, chars, page, viewRect, blocks, extractionDegraded } = context;
		let content = [];

		for (let j = 0; j < blocks.length; j++) {
			let block = blocks[j];
			block.blockIndex = j;
			block.pageIndex = i;
		}

		chars.forEach(x => x.pageIndex = i);
		for (let bi = 0; bi < blocks.length; bi++) {
			let block = blocks[bi];

			let charsRange = Array.isArray(block._charRanges)
				? block._charRanges.flatMap(([startOffset, endOffset]) => (
					chars.slice(startOffset, endOffset + 1)
				))
				: chars.slice(block.startOffset, block.endOffset + 1);

			let node;
			let anchor = createBlockAnchor(i, block.bbox);
			if (block.type === 'title') {
				node = {
					type: 'heading',
					...(anchor && { anchor }),
					content: charsToTextNodes(i, charsRange),
					_metrics: getHeadingMetrics(block, charsRange),
					...(block._contentsNavigationHeading && { _contentsNavigationHeading: true }),
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
				node = createTableNode({
					pageIndex: i,
					block,
					chars: charsRange,
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
					_metrics: getParagraphMetrics(block, charsRange),
					...(block._contentsList && { _contentsList: true }),
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
				content.push(node);
			}

			if (block.type === 'title') {
				let titleChars = chars.slice(block.startOffset, block.endOffset + 1);
				block.avgFontSize = Math.round(
					titleChars.reduce((acc, x) => acc + x.fontSize, 0) / titleChars.length
				);
			}
		}

		let rotation = VALID_PAGE_ROTATIONS.has(page.rotate) ? page.rotate : 0;
		let userUnit = Number.isFinite(page.userUnit) && page.userUnit > 0 ? page.userUnit : 1;
		if (replace) {
			structure.content.splice(
				getPageContentOffset(i),
				pageContentLengths[i],
				...content,
			);
			pageContentLengths[i] = content.length;
			return;
		}
		pageContentLengths[i] = content.length;
		structure.content.push(...content);
		structure.catalog.pages.push({
			viewRect,
			...(rotation !== 0 ? { rotation } : {}),
			...(userUnit !== 1 ? { userUnit } : {}),
			...(extractionDegraded ? { extractionDegraded: true } : {}),
		});
		pagesProcessed++;
		reportPageProgress(onProgress, pagesProcessed, pageCount);
	}

	function collectInferredHeadings(context) {
		for (const block of context.blocks || []) {
			if (block.type !== 'title') continue;
			const title = Array.isArray(block.lines)
				? block.lines.map(lineId => context.lines[lineId]?.text || '').join(' ').trim()
				: context.chars
					.slice(block.startOffset, block.endOffset + 1)
					.map(char => char?.c || '')
					.join('')
					.trim();
			if (title) {
				inferredHeadings.push({ title, _pageIndex: context.i });
			}
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
			let { chars, objects, forms } = await pdfDocument.module.getPageCharsObjects(i);
			let lines = getLines(chars);

			updateRegularWordsSet(chars, regularWordsSet);

			let page = await pdfDocument.getPage(i);
			let pageView = page.view;
			let viewRect = normalizePageViewRect(pageView);

			let links = await getLinksFromAnnotations(pdfDocument, page);
			if (links.length) {
				linkMap.set(i, links);
			}

			let context = {
				i,
				chars,
				lines,
				objects,
				page,
				viewRect,
				links,
				blocks: [],
				extractionDegraded: viewRect !== pageView,
			};
			if (chars.length || objects?.length) {
				let val = {};
				inferenceInputs.push({ chars, lines, objects, forms, viewBox: viewRect, pageIndex: i });
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
					context.extractionDegraded ||= hasDegradedExtractionFallbacks(val.layoutFallbacks);
				}
			}
		}

		for (let context of contexts) {
			collectInferredHeadings(context);
			contentsContexts.push({
				i: context.i,
				lines: context.lines.map(line => ({
					id: line.id,
					text: line.text,
					rect: line.rect,
					startOffset: line.startOffset,
					endOffset: line.endOffset,
				})),
				blocks: context.blocks,
				viewRect: context.viewRect,
				links: context.links,
			});
			await appendPageContext(context);
		}
	}

	// Confirm printed navigation only after inference has seen the whole PDF.
	const headingIndex = createContentsHeadingIndex(inferredHeadings);
	for (const context of contentsContexts) {
		const evidence = getContentsEvidence(
			context.lines,
			context.links,
			headingIndex,
			context.i,
		);
		const contentsRegion = detectContentsRegion(context.lines, context.viewRect, {
			evidence,
			links: context.links,
		});
		if (!contentsRegion) continue;
		contentsNavigationRegions.push({
			pageIndex: context.i,
			source: contentsRegion.source,
			rows: contentsRegion.rows,
		});
		const { chars } = await pdfDocument.module.getPageCharsObjects(context.i);
		const page = await pdfDocument.getPage(context.i);
		context.blocks = normalizeContentsBlocks(
			context.blocks,
			context.lines,
			context.viewRect,
			{ region: contentsRegion },
		);
		await appendPageContext({ ...context, chars, page }, true);
	}
	contentsContexts = null;

	let contentOffset = 0;
	for (let pageIndex = 0; pageIndex < pageCount; pageIndex++) {
		const contentLength = pageContentLengths[pageIndex];
		structure.catalog.pages[pageIndex].contentRange = [
			[contentOffset],
			[contentOffset + contentLength],
		];
		contentOffset += contentLength;
	}

	// Block transformations
	wrapListItems(structure);
	markListItemParts(structure);
	postProcessStructure(structure);
	markParagraphParts(structure);
	excludeRepeatedPageFurniture(structure);
	normalizeTopLevelFlowClasses(structure);

	// After this only text node transformations are allowed

	addPageLabels(structure, catalogPageLabels);

	let candidateGroups = new Map();
	let structureIndex = createStructureIndex(structure, options.structureIndex);

	let annotLinkRefs = getAnnotLinkRefs(structure, linkMap, structureIndex);
	let parsedLinkRefs = getParsedLinkRefs(structure, structureIndex);

	let candidateReferenceLists = getReferenceLists(structure, regularWordsSet);
	let candidateReferenceIndex = getReferenceIndex(candidateReferenceLists, regularWordsSet);
	let referenceLists = getSupportedReferenceLists(structure, candidateReferenceIndex, structureIndex);
	const markReferenceNode = (blockRef) => {
		if (!Array.isArray(blockRef)) {
			return;
		}
		let node = structure.content[blockRef[0]];
		for (let i = 1; node && i < blockRef.length; i++) {
			node = node.content?.[blockRef[i]];
		}
		if (node) {
			node.reference = true;
		}
	};
	for (let refList of referenceLists) {
		for (let blockRef of refList.blockRefs || []) {
			markReferenceNode(blockRef);
		}
		for (let ref of refList.references) {
			markReferenceNode(ref.src.blockRef);
		}
	}
	let referenceIndex = getReferenceIndex(referenceLists, regularWordsSet);
	let citationRefs = getCitationRefs(structure, referenceIndex, annotLinkRefs, structureIndex);
	let figures = getFigures(structure);
	let mathBlocks = getMathBlocks(structure);
	getFigureAndMathCandidates(structure, candidateGroups, figures, mathBlocks, structureIndex);
	structureIndex.clearPageTextCache();
	let mainRefs = getRefsList(candidateGroups);

	addRefs(annotLinkRefs, parsedLinkRefs);
	addRefs(citationRefs, mainRefs);
	addRefs(citationRefs, annotLinkRefs);

	applyRefs(structure, citationRefs);

	let referenceTitleRefs = referenceLists
		.map(referenceList => referenceList.titleRef)
		.filter(Array.isArray);
	let outline = await getOutline(
		structure.content,
		referenceTitleRefs,
		pdfDocument,
		nativeOutline,
		{
			navigationRegions: contentsNavigationRegions,
		},
	);
	if (outline.length) {
		structure.catalog.outline = outline;
	}
	for (const block of structure.content) {
		delete block._contentsNavigationHeading;
	}

	cleanupBlockMetrics(structure);
	cleanupTextNodeStyles(structure);
	ensureBlockPageRects(structure);

	return structure;
}

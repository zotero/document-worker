import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
	createContentsHeadingIndex,
	detectContentsRegion,
	getContentsEvidence,
	normalizeContentsBlocks,
} from '../../src/pdf/structure/contents.js';
import { getOutline } from '../../src/pdf/structure/outline/outline.js';

const PAGE_RECT = [0, 0, 600, 800];

function makeLine(id, text, rect, startOffset = id * 100) {
	const tokens = text.split(/\s+/u).filter(Boolean);
	const totalLength = Math.max(1, tokens.reduce((sum, token) => sum + token.length, 0));
	let x = rect[0];
	const words = tokens.map(token => {
		const width = (rect[2] - rect[0]) * token.length / totalLength;
		const word = { text: token, rect: [x, rect[1], x + width, rect[3]] };
		x += width;
		return word;
	});
	return {
		id,
		text,
		rect,
		words,
		startOffset,
		endOffset: startOffset + Math.max(0, text.length - 1),
	};
}

function makeNavigationLine(id, title, locator, rect, startOffset = id * 100) {
	const line = makeLine(id, `${title} ${locator}`, rect, startOffset);
	const locatorWidth = Math.max(8, String(locator).length * 6);
	const locatorWord = line.words.at(-1);
	locatorWord.rect = [rect[2] - locatorWidth, rect[1], rect[2], rect[3]];
	const titleWidth = Math.max(1, rect[2] - rect[0] - locatorWidth - 40);
	const titleWords = line.words.slice(0, -1);
	const totalTitleLength = Math.max(1, titleWords.reduce((sum, word) => sum + word.text.length, 0));
	let x = rect[0];
	for (const word of titleWords) {
		const width = titleWidth * word.text.length / totalTitleLength;
		word.rect = [x, rect[1], x + width, rect[3]];
		x += width;
	}
	return line;
}

function makeInlineContents(rowCount = 6, heading = 'Contents') {
	const lines = [makeLine(0, heading, [60, 730, 140, 745], 0)];
	for (let i = 0; i < rowCount; i++) {
		lines.push(makeNavigationLine(
			i + 1,
			`${i + 1}. A sufficiently descriptive chapter title`,
			String(i + 3),
			[60, 700 - i * 20, 520, 712 - i * 20],
		));
	}
	return lines;
}

function makeOutlineBlock(type, text, pageIndex, fontName = 'Heading', fontSize = 18) {
	return {
		type,
		anchor: { pageRects: [[pageIndex, 60, 700, 500, 720]] },
		content: [{ text }],
		_metrics: {
			pageIndex,
			fontName,
			fontSize,
			firstCharFontName: fontName,
			firstCharFontSize: fontSize,
		},
	};
}

function flattenOutlineRefs(items) {
	return (items || []).flatMap(item => [
		...(Array.isArray(item.ref) ? [item.ref] : []),
		...flattenOutlineRefs(item.children),
	]);
}

function makeHeadingNodes(titles, firstTargetPage = 10) {
	return titles.map((title, index) => ({
		title,
		_pageIndex: firstTargetPage + index,
	}));
}

function makeInternalLinks(lines, firstTargetPage = 10) {
	return lines.map((line, index) => ({
		src: { rect: line.rect },
		dest: { pageIndex: firstTargetPage + index },
	}));
}

describe('PDF printed contents detection', () => {
	function getEvidence(lines, titles, firstTargetPage = 10, links = []) {
		const index = createContentsHeadingIndex(makeHeadingNodes(titles, firstTargetPage));
		return getContentsEvidence(lines, links, index, 0);
	}

	it('detects a dense ordered repetition of inferred body headings', () => {
		const lines = makeInlineContents();
		const titles = lines.slice(1).map(line => (
			line.words.slice(0, -1).map(word => word.text).join(' ')
		));
		const evidence = getEvidence(lines, titles);
		const region = detectContentsRegion(lines, PAGE_RECT, { evidence });

		assert.equal(region?.source, 'heading-concentration');
		assert.equal(region?.rows.length, 6);
	});

	it('does not detect navigation without independent inferred headings', () => {
		assert.equal(detectContentsRegion(makeInlineContents(), PAGE_RECT), null);
	});

	it('requires at least four matching headings', () => {
		const lines = makeInlineContents(3);
		const titles = lines.slice(1).map(line => (
			line.words.slice(0, -1).map(word => word.text).join(' ')
		));
		const evidence = getEvidence(lines, titles);

		assert.equal(detectContentsRegion(lines, PAGE_RECT, { evidence }), null);
	});

	it('requires the matched body headings to preserve document order', () => {
		const lines = makeInlineContents(5);
		const titles = lines.slice(1).map(line => (
			line.words.slice(0, -1).map(word => word.text).join(' ')
		));
		const index = createContentsHeadingIndex(titles.map((title, index) => ({
			title,
			_pageIndex: 20 - index,
		})));
		const evidence = getContentsEvidence(lines, [], index, 0);

		assert.equal(detectContentsRegion(lines, PAGE_RECT, { evidence }), null);
	});

	it('rejects sparse repetitions spread through ordinary prose', () => {
		const titles = Array.from({ length: 4 }, (_, index) => `Independent heading ${index + 1}`);
		const lines = [makeLine(0, 'Page heading', [60, 760, 200, 775], 0)];
		for (let index = 0; index < titles.length; index++) {
			lines.push(makeNavigationLine(
				lines.length,
				titles[index],
				String(index + 2),
				[60, 700 - index * 100, 520, 714 - index * 100],
			));
			if (index !== titles.length - 1) {
				lines.push(makeLine(lines.length, 'First unrelated explanatory prose line', [60, 680 - index * 100, 500, 694 - index * 100]));
				lines.push(makeLine(lines.length, 'Second unrelated explanatory prose line', [60, 660 - index * 100, 500, 674 - index * 100]));
			}
		}
		const evidence = getEvidence(lines, titles);

		assert.equal(detectContentsRegion(lines, PAGE_RECT, { evidence }), null);
	});

	it('normalizes every physical row inside a confirmed span', () => {
		const titles = Array.from({ length: 4 }, (_, index) => `Matched chapter ${index + 1}`);
		const lines = [
			makeLine(0, 'Arbitrary navigation heading', [60, 750, 260, 766], 0),
			makeNavigationLine(1, titles[0], '2', [60, 710, 520, 724]),
			makeNavigationLine(2, 'Unmatched top-level entry', '7', [60, 690, 550, 704]),
			makeNavigationLine(3, titles[1], '9', [70, 670, 520, 684]),
			makeNavigationLine(4, titles[2], '12', [70, 650, 520, 664]),
			makeNavigationLine(5, 'Another unmatched row', '18', [60, 630, 550, 644]),
			makeNavigationLine(6, titles[3], '21', [70, 610, 520, 624]),
		];
		const evidence = getEvidence(lines, titles);
		const region = detectContentsRegion(lines, PAGE_RECT, { evidence });

		assert.equal(region?.rows.length, 6);
		assert.deepEqual(region?.rows.map(row => row.lineIds[0]), [1, 2, 3, 4, 5, 6]);
	});

	it('is independent of language and navigation-title wording', () => {
		const titles = ['第一章研究方法', '第二章实验结果', '第三章相关讨论', '第四章最终结论'];
		const lines = [
			makeLine(0, '任意の表題', [60, 730, 180, 745], 0),
			...titles.map((title, index) => makeNavigationLine(
				index + 1,
				title,
				String(index + 2),
				[60, 700 - index * 24, 520, 714 - index * 24],
			)),
		];
		const evidence = getEvidence(lines, titles);

		assert.equal(detectContentsRegion(lines, PAGE_RECT, { evidence })?.rows.length, 4);
	});

	it('does not use internal links as an independent detector', () => {
		const lines = makeInlineContents(6);
		const links = makeInternalLinks(lines.slice(1), 50);
		const evidence = getContentsEvidence(lines, links, { entries: [] }, 0);

		assert.equal(evidence.matches.length, 0);
		assert.equal(detectContentsRegion(lines, PAGE_RECT, { evidence }), null);
	});

	it('rejects ambiguous repeated body headings as evidence', () => {
		const repeatedTitle = 'A sufficiently descriptive chapter title';
		const lines = Array.from({ length: 4 }, (_, index) => makeNavigationLine(
			index,
			repeatedTitle,
			String(index + 2),
			[60, 700 - index * 24, 520, 714 - index * 24],
		));
		const index = createContentsHeadingIndex([
			{ title: repeatedTitle, _pageIndex: 10 },
			{ title: repeatedTitle, _pageIndex: 20 },
		]);
		const evidence = getContentsEvidence(lines, [], index, 0);

		assert.equal(evidence.matches.length, 0);
	});

	it('normalizes accepted contents independently of the model block type', () => {
		const lines = [
			makeLine(0, 'Paper title', [60, 760, 300, 775], 0),
			...makeInlineContents().map((line, index) => ({
				...line,
				id: index + 1,
				startOffset: line.startOffset + 100,
				endOffset: line.endOffset + 100,
			})),
			makeLine(8, 'Main body after the contents.', [60, 520, 400, 535], 900),
		];
		const blocks = [{
			type: 'table',
			flowClass: 'body',
			lines: lines.map(line => line.id),
			bbox: [60, 520, 520, 775],
			startOffset: 0,
			endOffset: 930,
		}];

		const titles = lines.slice(2, 8).map(line => (
			line.words.slice(0, -1).map(word => word.text).join(' ')
		));
		const evidence = getEvidence(lines, titles);
		const region = detectContentsRegion(lines, PAGE_RECT, { evidence });
		const normalized = normalizeContentsBlocks(blocks, lines, PAGE_RECT, { region });

		assert.deepEqual(normalized.map(block => block.type), [
			'table',
			'list_item',
			'list_item',
			'list_item',
			'list_item',
			'list_item',
			'list_item',
			'table',
		]);
		assert.ok(normalized.slice(1, 7).every(block => (
			block.flowClass === 'auxiliary' && block._contentsList === true
		)));
		assert.deepEqual(normalized[0].lines, [0, 1]);
		assert.deepEqual(normalized.at(-1).lines, [8]);
	});

	it('keeps printed contents entries from shadowing real outline targets', async () => {
		const blocks = [
			{
				type: 'heading',
				flowClass: 'auxiliary',
				_contentsNavigationHeading: true,
				anchor: { pageRects: [[0, 60, 700, 300, 720]] },
				content: [{ text: 'Chapter One' }],
			},
			{
				type: 'heading',
				anchor: { pageRects: [[10, 60, 700, 300, 720]] },
				content: [{ text: 'Chapter One' }],
			},
		];
		const nativeOutline = [{
			title: 'Chapter One',
			location: { position: { pageIndex: 10 } },
			items: [],
		}];

		const outline = await getOutline(blocks, [], null, nativeOutline);

		assert.equal(outline.length, 1);
		assert.deepEqual(outline[0].ref, [1]);
	});

	it('recovers an exact linked paragraph from styles anchored in the same region', async () => {
		const blocks = [
			makeOutlineBlock('heading', 'First section', 1),
			makeOutlineBlock('paragraph', 'Body text', 1, 'Body', 10),
			makeOutlineBlock('heading', 'Second section', 2),
			makeOutlineBlock('paragraph', 'Body text', 2, 'Body', 10),
			makeOutlineBlock('paragraph', 'Recovered Heading', 3),
			makeOutlineBlock('paragraph', 'Body text', 3, 'Body', 10),
		];
		const outline = await getOutline(blocks, [], null, [], {
			navigationRegions: [{
				pageIndex: 0,
				source: 'destination-link',
				rows: [
					{ title: 'First section', linkDestinations: [{ pageIndex: 1, rect: [60, 700, 60, 700] }] },
					{ title: 'Second section', linkDestinations: [{ pageIndex: 2, rect: [60, 700, 60, 700] }] },
					{ title: 'Recovered H e a d i n g', linkDestinations: [{ pageIndex: 3, rect: [60, 700, 60, 700] }] },
				],
			}],
		});

		assert.ok(flattenOutlineRefs(outline).some(ref => ref[0] === 4));
	});

	it('does not globally exclude an auxiliary heading', async () => {
		const auxiliaryHeading = {
			...makeOutlineBlock('heading', 'Recovered Heading', 3),
			flowClass: 'auxiliary',
		};
		const blocks = [
			makeOutlineBlock('heading', 'First section', 1),
			makeOutlineBlock('heading', 'Second section', 2),
			auxiliaryHeading,
		];
		const withoutNavigation = await getOutline(blocks, [], null, []);
		const withNavigation = await getOutline(blocks, [], null, [], {
			navigationRegions: [{
				pageIndex: 0,
				source: 'destination-link',
				rows: [
					{ title: 'First section', linkDestinations: [{ pageIndex: 1, rect: [60, 700, 60, 700] }] },
					{ title: 'Second section', linkDestinations: [{ pageIndex: 2, rect: [60, 700, 60, 700] }] },
					{ title: 'Recovered Heading', linkDestinations: [{ pageIndex: 3, rect: [60, 700, 60, 700] }] },
				],
			}],
		});

		assert.ok(flattenOutlineRefs(withoutNavigation).some(ref => ref[0] === 2));
		assert.ok(flattenOutlineRefs(withNavigation).some(ref => ref[0] === 2));
	});

	it('preserves a body heading with a unique exact contents match', async () => {
		const blocks = [
			makeOutlineBlock('heading', 'First section', 1, 'Heading', 18),
			makeOutlineBlock('heading', 'Unique preface', 2, 'Unique', 16),
			makeOutlineBlock('heading', 'Preface subsection', 3, 'Subheading', 14),
		];
		const baseline = await getOutline(structuredClone(blocks), [], null, []);
		const enriched = await getOutline(blocks, [], null, [], {
			navigationRegions: [{
				pageIndex: 0,
				source: 'layout-navigation',
				rows: [
					{ title: 'Unique preface' },
				],
			}],
		});

		assert.ok(!flattenOutlineRefs(baseline).some(ref => ref[0] === 1));
		assert.ok(flattenOutlineRefs(enriched).some(ref => ref[0] === 1));
		for (const ref of flattenOutlineRefs(baseline)) {
			assert.ok(flattenOutlineRefs(enriched).some(candidate => candidate[0] === ref[0]));
		}
	});

	it('does not recover an unlinked row or a linked object caption', async () => {
		const blocks = [
			makeOutlineBlock('heading', 'First section', 1),
			makeOutlineBlock('paragraph', 'Body text', 1, 'Body', 10),
			makeOutlineBlock('heading', 'Second section', 2),
			makeOutlineBlock('paragraph', 'Body text', 2, 'Body', 10),
			makeOutlineBlock('paragraph', 'Unlinked heading', 3),
			makeOutlineBlock('paragraph', 'Body text', 3, 'Body', 10),
			makeOutlineBlock('paragraph', 'Illustration caption', 4),
			{
				...makeOutlineBlock('image', '', 4),
				flowClass: 'auxiliary',
			},
		];
		const outline = await getOutline(blocks, [], null, [], {
			navigationRegions: [{
				pageIndex: 0,
				source: 'layout-navigation',
				rows: [
					{ title: 'Unlinked heading', linkDestinations: [] },
					{ title: 'Illustration caption', linkDestinations: [{ pageIndex: 4 }] },
				],
			}],
		});
		const refs = flattenOutlineRefs(outline);

		assert.ok(!refs.some(ref => ref[0] === 4));
		assert.ok(!refs.some(ref => ref[0] === 6));
	});

	it('does not recover a wrapped fragment when the link targets an existing heading', async () => {
		const blocks = [
			makeOutlineBlock('heading', 'First section', 1),
			makeOutlineBlock('paragraph', 'Body text', 1, 'Body', 10),
			makeOutlineBlock('heading', 'Second section', 2),
			makeOutlineBlock('paragraph', 'Body text', 2, 'Body', 10),
			makeOutlineBlock('heading', 'Full chapter title and fragment', 3),
			makeOutlineBlock('paragraph', 'and fragment', 3),
			makeOutlineBlock('paragraph', 'Body text', 3, 'Body', 10),
		];
		blocks[4].anchor.pageRects[0] = [3, 60, 700, 500, 720];
		blocks[5].anchor.pageRects[0] = [3, 60, 650, 500, 670];
		const outline = await getOutline(blocks, [], null, [], {
			navigationRegions: [{
				pageIndex: 0,
				source: 'destination-link',
				rows: [
					{ title: 'First section', linkDestinations: [{ pageIndex: 1, rect: [60, 700, 60, 700] }] },
					{ title: 'Second section', linkDestinations: [{ pageIndex: 2, rect: [60, 700, 60, 700] }] },
					{ title: 'and fragment', linkDestinations: [{ pageIndex: 3, rect: [60, 700, 60, 700] }] },
				],
			}],
		});

		assert.ok(!flattenOutlineRefs(outline).some(ref => ref[0] === 5));
	});

	it('does not add a navigation heading from native-outline agreement alone', async () => {
		const navigationHeading = {
			...makeOutlineBlock('heading', 'Navigation', 0),
			_contentsNavigationHeading: true,
		};
		navigationHeading._metrics.fontName = 'Body';
		const blocks = [
			navigationHeading,
			makeOutlineBlock('heading', 'First section', 1),
			makeOutlineBlock('heading', 'Second section', 2),
		];
		const nativeOutline = [{
			title: 'Navigation',
			location: { position: { pageIndex: 0 } },
			items: [],
		}];
		const withoutNative = await getOutline(blocks, [], null, []);
		const withNative = await getOutline(blocks, [], null, nativeOutline);

		assert.ok(!flattenOutlineRefs(withoutNative).some(ref => ref[0] === 0));
		assert.ok(!flattenOutlineRefs(withNative).some(ref => ref[0] === 0));
	});

	it('turns unmatched group headings inside a confirmed span into list items', () => {
		const lines = [makeLine(0, 'Contents', [60, 730, 140, 745], 0)];
		const titles = [];
		for (let i = 0; i < 3; i++) {
			const title = `Opening chapter title ${i + 1}`;
			titles.push(title);
			lines.push(makeNavigationLine(
				i + 1,
				title,
				String(i + 1),
				[60, 700 - i * 20, 520, 712 - i * 20],
			));
		}
		lines.push(makeLine(4, 'Part Two: A group heading', [60, 630, 300, 642]));
		for (let i = 0; i < 3; i++) {
			const title = `Later chapter title ${i + 1}`;
			titles.push(title);
			lines.push(makeNavigationLine(
				i + 5,
				title,
				String(i + 10),
				[60, 600 - i * 20, 520, 612 - i * 20],
			));
		}
		const blocks = [{
			type: 'body',
			flowClass: 'body',
			lines: lines.map(line => line.id),
			bbox: [60, 560, 520, 745],
			startOffset: 0,
			endOffset: lines.at(-1).endOffset,
		}];

		const evidence = getEvidence(lines, titles);
		const region = detectContentsRegion(lines, PAGE_RECT, { evidence });
		const normalized = normalizeContentsBlocks(blocks, lines, PAGE_RECT, { region });
		const groupHeading = normalized.find(block => block.lines?.includes(4));

		assert.ok(groupHeading);
		assert.equal(groupHeading.type, 'list_item');
		assert.equal(groupHeading.flowClass, 'auxiliary');
	});
});

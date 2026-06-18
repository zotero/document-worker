import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getReferenceIndex } from '../../src/pdf/structure/reference/index.js';
import { getReferenceLists } from '../../src/pdf/structure/reference/reference.js';
import { getSupportedReferenceLists } from '../../src/pdf/structure/reference/support.js';
import { createStructureIndex } from '../../src/pdf/structure/structure-index.js';

function paragraph(text) {
	return {
		type: 'paragraph',
		content: [{ text }],
	};
}

function referenceList(entries) {
	return {
		type: 'list',
		content: entries.map(text => ({
			type: 'listitem',
			content: [{ text }],
		})),
	};
}

function referenceListNodes(content) {
	return {
		type: 'list',
		content,
	};
}

function supportedLists(structure) {
	const candidates = getReferenceLists(structure, new Set());
	const index = getReferenceIndex(candidates, new Set());
	return getSupportedReferenceLists(structure, index, createStructureIndex(structure));
}

describe('PDF reference run support', () => {
	it('rejects numbered prose lists even when their labels are mentioned', () => {
		const structure = {
			content: [
				paragraph('The first principle [1] and second principle [2] matter.'),
				referenceList([
					'1. “Each person is to have an equal right” (Rawls, 2006, p. 63).',
					'2. “Social and economic inequalities are to be arranged” (Rawls, 2006, p. 72).',
				]),
			],
		};

		assert.equal(getReferenceLists(structure, new Set()).length, 1);
		assert.equal(supportedLists(structure).length, 0);
	});

	it('rejects topic lists that only contain parenthetical citations', () => {
		const structure = {
			content: [
				paragraph('A chapter discusses these factors.'),
				referenceList([
					'• Personality (McDonald, 2010)',
					'• Culture (McDonald, 2010)',
					'• Situations (Catlin and Maupin, 2010).',
				]),
			],
		};

		assert.equal(getReferenceLists(structure, new Set()).length, 1);
		assert.equal(supportedLists(structure).length, 0);
	});

	it('rejects topic lists with explanatory prose', () => {
		const structure = {
			content: [
				referenceList([
					'• Discretion. Officers must make judgement calls throughout their work (Smith, 2014).',
					'• Power. Officers can arrest, detain, search, and question people (Jones, 2010).',
					'• Public service. The state employs officers to keep the peace (Brown, 2010).',
				]),
			],
		};

		assert.equal(getReferenceLists(structure, new Set()).length, 1);
		assert.equal(supportedLists(structure).length, 0);
	});

	it('keeps supported source-shaped lists', () => {
		const structure = {
			content: [
				paragraph('Smith 2020 established the baseline.'),
				referenceList([
					'Smith, J. (2020). Example title. Journal of Examples, 12(3), 45-50.',
					'Jones, A. (2021). Another title. Example Press.',
				]),
			],
		};

		assert.equal(supportedLists(structure).length, 1);
	});

	it('keeps source-shaped bibliographies without citation support', () => {
		const structure = {
			content: [
				referenceList([
					'Smith, J. (2020). Example title. Journal of Examples, 12(3), 45-50.',
					'Jones, A. (2021). Another title. Example Press.',
					'World Health Organization. (2019). Report title. https://example.org/report',
				]),
			],
		};

		assert.equal(supportedLists(structure).length, 1);
	});

	it('keeps identifier-based bibliographies without years', () => {
		const structure = {
			content: [
				referenceList([
					'Smith, J. Example title. doi:10.1234/example-a',
					'Example organization. Project report. https://example.org/report',
					'Research group. Model description. arXiv:2409.04701v3',
				]),
			],
		};

		assert.equal(getReferenceLists(structure, new Set()).length, 1);
		assert.equal(supportedLists(structure).length, 1);
	});

	it('rejects resource link lists without bibliographic context', () => {
		const structure = {
			content: [
				referenceList([
					'• Contact us: https://open.bccampus.ca/contact-us/',
					'• Adoption of an open textbook: https://open.bccampus.ca/use-open-textbooks/',
					'• Web version: https://opentextbc.ca/foodsafety/',
				]),
			],
		};

		assert.equal(getReferenceLists(structure, new Set()).length, 0);
		assert.equal(supportedLists(structure).length, 0);
	});

	it('keeps language-neutral source-shaped bibliographies', () => {
		const structure = {
			content: [
				referenceList([
					'Petrauskas, J. (2020). Etikos sprendimai policijoje. 12(3), 45-50.',
					'García, M. (2021). Derechos y seguridad pública. 8:101-118.',
					'王, 小明. (2019). 法律倫理研究. 5(2), 10-22.',
				]),
			],
		};

		assert.equal(supportedLists(structure).length, 1);
	});

	it('keeps source-shaped paragraph bibliography runs', () => {
		const structure = {
			content: [
				paragraph('Smith, J. (2020). Example title. Journal of Examples, 12(3), 45-50.'),
				paragraph('Jones, A. (2021). Another title. Example Press.'),
				paragraph('World Health Organization. (2019). Report title. https://example.org/report'),
			],
		};

		const lists = supportedLists(structure);

		assert.equal(lists.length, 1);
		assert.deepEqual(lists[0].references.map(reference => reference.src.blockRef), [[0], [1], [2]]);
	});

	it('keeps long terminal-year paragraph bibliography runs', () => {
		const structure = {
			content: [
				paragraph('Smith, John. This title has more than twelve separate words before the final source year. Oxford Press. 2020.'),
				paragraph('Jones, Anna. Another source title with enough words to place the year outside the lead window. Cambridge Press. 2021.'),
				paragraph('Brown, Lee. A third long terminal source entry keeps the run above the source-shape support floor. Routledge. 2022.'),
			],
		};

		const lists = supportedLists(structure);

		assert.equal(lists.length, 1);
		assert.deepEqual(lists[0].references.map(reference => reference.src.blockRef), [[0], [1], [2]]);
	});

	it('folds split list-item continuations into the previous reference', () => {
		const structure = {
			content: [
				paragraph('Chung 2014 defined the classification scheme.'),
				referenceListNodes([
					{
						type: 'listitem',
						nextPart: [1, 1],
						content: [{ text: '5. Chung JW, Park SH, Kim N. Trial of ORG 10172 in acute stroke treatment classifica-' }],
					},
					{
						type: 'listitem',
						previousPart: [1, 0],
						content: [{ text: 'tion and vascular territory of ischemic stroke lesions. J Am Heart Assoc 2014;3:e001119.' }],
					},
					{
						type: 'listitem',
						content: [{ text: '6. Schwartz BG, Rezkalla S, Kloner RA. Cardiovascular effects of cocaine. Circulation 2010;122:2558-2569.' }],
					},
				]),
			],
		};

		const candidates = getReferenceLists(structure, new Set());
		const lists = supportedLists(structure);

		assert.equal(candidates[0].references.length, 2);
		assert.match(candidates[0].references[0].text, /classification and vascular territory/);
		assert.deepEqual(candidates[0].references[0].continuationBlockRefs, [[1, 1]]);
		assert.equal(lists.length, 1);
		assert.deepEqual(lists[0].blockRefs, [[1, 1]]);
	});
});

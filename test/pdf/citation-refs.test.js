import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getCitationRefs, getMentionWindows } from '../../src/pdf/structure/citation-refs.js';
import { getReferenceIndex } from '../../src/pdf/structure/reference/index.js';
import { getReferenceLists } from '../../src/pdf/structure/reference/reference.js';

function paragraph(text) {
	return {
		type: 'paragraph',
		content: [{ text }],
	};
}

function styledParagraph(content) {
	return {
		type: 'paragraph',
		content,
	};
}

function table(text) {
	return {
		type: 'table',
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

function getIndex(structure) {
	return getReferenceIndex(getReferenceLists(structure, new Set()), new Set());
}

describe('PDF citation references', () => {
	it('links exact numeric mentions to matching reference labels', () => {
		const structure = {
			content: [
				paragraph('See [1].'),
				referenceList(['[1] Smith, J. 2020. Example title.']),
			],
		};

		const refs = getCitationRefs(structure, getIndex(structure));

		assert.deepEqual(refs.get('0').map(ref => ref.dest.blockRef), [[1, 0]]);
	});

	it('uses superscript numeric style instead of weak table bracket ranges', () => {
		const structure = {
			content: [
				styledParagraph([
					{ text: 'Cocaine increased stroke risk.' },
					{ text: '1', style: { sup: true } },
					{ text: ' Vascular dysfunction was also observed.' },
					{ text: '2', style: { sup: true } },
				]),
				table('Age 61 [3-5] Score [1-2] Confidence [57-65]'),
				referenceList([
					'1. Rendon LF. Cocaine and ischemic stroke. J Clin Med 2023;12:5207.',
					'2. Middlekauff HR. Drugs of misuse. Can J Cardiol 2022;38:1364-1377.',
					'3. Memon MZ. Mechanical thrombectomy. J Stroke Cerebrovasc Dis 2020;29:105330.',
					'4. Dabhi N. Effect of drug use. Surg Neurol Int 2022;13:367.',
					'5. Chung JW. TOAST classification. J Am Heart Assoc 2014;3:e001119.',
				]),
			],
		};

		const refs = getCitationRefs(structure, getIndex(structure));

		assert.deepEqual(refs.get('0').map(ref => ref.dest.blockRef), [[2, 0], [2, 1]]);
		assert.equal(refs.has('1'), false);
	});

	it('keeps incidental superscript footnotes from overriding delimited numeric style', () => {
		const structure = {
			content: [
				paragraph('The first method [1] and second method [2] are related.'),
				styledParagraph([
					{ text: 'A footnote marker' },
					{ text: '1', style: { sup: true } },
					{ text: ' explains an implementation detail.' },
				]),
				referenceList([
					'[1] Smith, J. 2020. Example title.',
					'[2] Jones, A. 2021. Another title.',
				]),
			],
		};

		const refs = getCitationRefs(structure, getIndex(structure));

		assert.deepEqual(refs.get('0').map(ref => ref.dest.blockRef), [[2, 0], [2, 1]]);
		assert.equal(refs.has('1'), false);
	});

	it('treats comma-list superscripts as weak numeric metadata', () => {
		const structure = {
			content: [
				styledParagraph([
					{ text: 'Alice Smith,' },
					{ text: '1', style: { sup: true } },
					{ text: ', Bob Jones,' },
					{ text: '2', style: { sup: true } },
					{ text: ', Carol Lee,' },
					{ text: '3', style: { sup: true } },
					{ text: ', Department of Public Safety' },
				]),
				referenceList([
					'1. Smith, J. 2020. Example title.',
					'2. Jones, A. 2021. Another title.',
					'3. Lee, C. 2022. Third title.',
				]),
			],
		};

		const windows = getMentionWindows(structure, getIndex(structure))
			.filter(window => window.kind === 'superscript');
		const refs = getCitationRefs(structure, getIndex(structure));

		assert.equal(windows.length, 3);
		assert.equal(windows.every(window => window.sourceStrength === 'weak'), true);
		assert.equal(refs.has('0'), false);
	});

	it('does not link weak table bracket ranges in delimited numeric papers', () => {
		const structure = {
			content: [
				paragraph('This is a real citation [1].'),
				table('Age 61 [1-2] and confidence interval [57-65].'),
				referenceList([
					'[1] Smith, J. 2020. Example title.',
					'[2] Jones, A. 2021. Another title.',
				]),
			],
		};

		const refs = getCitationRefs(structure, getIndex(structure));

		assert.deepEqual(refs.get('0').map(ref => ref.dest.blockRef), [[2, 0]]);
		assert.equal(refs.has('1'), false);
	});

	it('suppresses inferred numeric refs when numeric styles tie', () => {
		const structure = {
			content: [
				paragraph('This is one real bracket citation [1].'),
				styledParagraph([
					{ text: 'A footnote marker' },
					{ text: '1', style: { sup: true } },
					{ text: ' is not a citation.' },
				]),
				referenceList(['[1] Smith, J. 2020. Example title.']),
			],
		};

		const refs = getCitationRefs(structure, getIndex(structure));

		assert.equal(refs.has('0'), false);
		assert.equal(refs.has('1'), false);
	});

	it('does not link equation-style parenthesized numbers as citations', () => {
		const structure = {
			content: [
				paragraph('Prior work established the method (2). Equation (1) defines the objective.'),
				referenceList([
					'(1) Smith, J. 2020. Equation-related source.',
					'(2) Jones, A. 2021. Method source.',
				]),
			],
		};

		const refs = getCitationRefs(structure, getIndex(structure));

		assert.deepEqual(refs.get('0').map(ref => ref.dest.blockRef), [[1, 1]]);
	});

	it('links exact first-author year mentions', () => {
		const structure = {
			content: [
				paragraph('Smith 2020 established the baseline.'),
				referenceList(['Smith, J. 2020. Example title.']),
			],
		};

		const refs = getCitationRefs(structure, getIndex(structure));

		assert.deepEqual(refs.get('0').map(ref => ref.dest.blockRef), [[1, 0]]);
	});

	it('matches a citation token from a given-name-first reference', () => {
		const structure = {
			content: [
				paragraph('Devlin 2019 established the baseline.'),
				referenceList(['Jacob Devlin, Ming-Wei Chang, Kenton Lee, and Kristina Toutanova. BERT. 2019.']),
			],
		};

		const refs = getCitationRefs(structure, getIndex(structure));

		assert.deepEqual(refs.get('0').map(ref => ref.dest.blockRef), [[1, 0]]);
	});

	it('can match by coauthor token without knowing surnames', () => {
		const structure = {
			content: [
				paragraph('Gurevych 2019 is cited through a coauthor token.'),
				referenceList(['Nils Reimers and Iryna Gurevych. Sentence-BERT. 2019.']),
			],
		};

		const refs = getCitationRefs(structure, getIndex(structure));

		assert.deepEqual(refs.get('0').map(ref => ref.dest.blockRef), [[1, 0]]);
	});

	it('allows capitalized surname particles as author tokens', () => {
		const structure = {
			content: [
				paragraph('Van 2020 established the baseline.'),
				referenceList(['Van, Anna. Example source title. 2020.']),
			],
		};

		const refs = getCitationRefs(structure, getIndex(structure));

		assert.deepEqual(refs.get('0').map(ref => ref.dest.blockRef), [[1, 0]]);
	});

	it('skips ambiguous author-token overlap in the same year and run', () => {
		const structure = {
			content: [
				paragraph('Wang 2024 is ambiguous here.'),
				referenceList([
					'Bo Wang and Han Xiao. First title. 2024.',
					'Liang Wang and Nan Yang. Second title. 2024.',
				]),
			],
		};

		const refs = getCitationRefs(structure, getIndex(structure));

		assert.equal(refs.has('0'), false);
	});

	it('prefers the same-year reference where the token appears earliest in the author prefix', () => {
		const structure = {
			content: [
				paragraph('Chen et al. 2024 introduced the method.'),
				referenceList([
					'Tong Chen, Hongwei Wang, and Dong Yu. Dense X retrieval. 2024.',
					'Kun Luo, Zheng Liu, Tong Zhou, Yubo Chen, and Kang Liu. Landmark embedding. 2024.',
				]),
			],
		};

		const refs = getCitationRefs(structure, getIndex(structure));

		assert.deepEqual(refs.get('0').map(ref => ref.dest.blockRef), [[1, 0]]);
	});

	it('does not treat et al. as an author token', () => {
		const structure = {
			content: [
				paragraph('Demszky et al., 2020 introduced the dataset.'),
				referenceList([
					'Dorottya Demszky, Dana Movshovitz-Attias, and Sujith Ravi. Goemotions. 2020.',
					'Patrick Lewis, Ethan Perez, and Mike Lewis, et al. Retrieval-Augmented Generation. 2020.',
				]),
			],
		};

		const refs = getCitationRefs(structure, getIndex(structure));

		assert.deepEqual(refs.get('0').map(ref => ref.dest.blockRef), [[1, 0]]);
	});

	it('keeps author outside parenthesized year local to the current citation', () => {
		const structure = {
			content: [
				paragraph('Prior work used datasets (Demszky et al., 2020), then document retrieval Callan (1994).'),
				referenceList([
					'Dorottya Demszky, Dana Movshovitz-Attias, and Sujith Ravi. Goemotions. 2020.',
					'James P Callan. Passage-level evidence in document retrieval. 1994.',
				]),
			],
		};

		const refs = getCitationRefs(structure, getIndex(structure));

		assert.deepEqual(refs.get('0').map(ref => ref.dest.blockRef), [[1, 0], [1, 1]]);
	});

	it('keeps et al. inside the citation context', () => {
		const structure = {
			content: [
				paragraph('The encoder follows prior work (Devlin et al., 2019).'),
				referenceList(['Jacob Devlin, Ming-Wei Chang, Kenton Lee, and Kristina Toutanova. BERT. 2019.']),
			],
		};

		const refs = getCitationRefs(structure, getIndex(structure));

		assert.deepEqual(refs.get('0').map(ref => ref.dest.blockRef), [[1, 0]]);
	});

	it('keeps author-year matching inside the current parenthetical group', () => {
		const structure = {
			content: [
				paragraph('Prior work used larger contexts (Press et al., 2022) and later models (Gunther et al., 2023).'),
				referenceList([
					'Ofir Press, Noah Smith, and Mike Lewis. Train Short, Test Long. 2022.',
					'Michael Gunther, Jackmin Ong, Isabelle Mohr, and Han Xiao. Jina Embeddings 2. 2023.',
				]),
			],
		};

		const refs = getCitationRefs(structure, getIndex(structure));

		assert.deepEqual(refs.get('0').map(ref => ref.dest.blockRef), [[1, 0], [1, 1]]);
	});

	it('matches names with combining marks from PDF extraction', () => {
		const structure = {
			content: [
				paragraph('Prior work used larger contexts (Gun\u0308ther et al., 2023).'),
				referenceList(['Michael Gun\u0308ther, Jackmin Ong, Isabelle Mohr, and Han Xiao. Jina Embeddings 2. 2023.']),
			],
		};

		const refs = getCitationRefs(structure, getIndex(structure));

		assert.deepEqual(refs.get('0').map(ref => ref.dest.blockRef), [[1, 0]]);
	});

	it('uses the author before a title that starts with a number', () => {
		const structure = {
			content: [
				paragraph('Kamradt 2024 describes text splitting levels.'),
				referenceList(['Greg Kamradt. 5 Levels of Text Splitting. https://example.org/notebook.ipynb, 2024.']),
			],
		};

		const refs = getCitationRefs(structure, getIndex(structure));

		assert.deepEqual(refs.get('0').map(ref => ref.dest.blockRef), [[1, 0]]);
	});

	it('does not use arxiv identifier fragments as the publication year', () => {
		const structure = {
			content: [
				paragraph('Oord 2018 introduced contrastive predictive coding.'),
				referenceList(['Aaron van den Oord, Yazhe Li, and Oriol Vinyals. Representation Learning with Contrastive Predictive Coding. CoRR, abs/1807.03748, 2018.']),
			],
		};

		const refs = getCitationRefs(structure, getIndex(structure));

		assert.deepEqual(refs.get('0').map(ref => ref.dest.blockRef), [[1, 0]]);
	});

	it('does not promote title-word year matches', () => {
		const structure = {
			content: [
				paragraph('Example 2020 is not an author-year citation.'),
				referenceList(['Smith, J. 2020. Example title.']),
			],
		};

		const windows = getMentionWindows(structure, getIndex(structure));
		const refs = getCitationRefs(structure, getIndex(structure));

		assert.equal(windows.some(window => window.kind === 'author-year'), false);
		assert.equal(refs.has('0'), false);
	});

	it('suppresses later title-token matches after learning an earlier citation identity', () => {
		const structure = {
			content: [
				paragraph('Devlin 2019 established the baseline. BERT 2019 is a model name here.'),
				referenceList([
					'Devlin Jacob Ming-Wei Chang Kenton Lee Kristina Toutanova BERT Pre-training of Deep Bidirectional Transformers 2019.',
				]),
			],
		};

		const refs = getCitationRefs(structure, getIndex(structure));

		assert.deepEqual(refs.get('0').map(ref => ref.dest.blockRef), [[1, 0]]);
	});

	it('keeps first-name last-name citations compatible with learned identity positions', () => {
		const structure = {
			content: [
				paragraph('Jacob Devlin 2019 introduced the model. Devlin 2019 is cited again.'),
				referenceList(['Jacob Devlin, Ming-Wei Chang, Kenton Lee, and Kristina Toutanova. BERT. 2019.']),
			],
		};

		const refs = getCitationRefs(structure, getIndex(structure));

		assert.deepEqual(refs.get('0').map(ref => ref.dest.blockRef), [[1, 0], [1, 0]]);
	});

	it('still allows title-first anonymous references to be cited by title', () => {
		const structure = {
			content: [
				paragraph('Global Status Report 2018 remains important.'),
				referenceList(['Global Status Report on Alcohol and Health. 2018. World Health Organization.']),
			],
		};

		const refs = getCitationRefs(structure, getIndex(structure));

		assert.deepEqual(refs.get('0').map(ref => ref.dest.blockRef), [[1, 0]]);
	});

	it('links unique no-year parenthetical identity citations', () => {
		const structure = {
			content: [
				paragraph('The theory is discussed elsewhere (Rawls 53).'),
				referenceList(['Rawls, John. A Theory of Justice. Harvard University Press. 1971.']),
			],
		};

		const refs = getCitationRefs(structure, getIndex(structure));

		assert.deepEqual(refs.get('0').map(ref => ref.dest.blockRef), [[1, 0]]);
	});

	it('does not treat a bare parenthetical identity as a no-year citation', () => {
		const structure = {
			content: [
				paragraph('The baseline engine (SpiderMonkey) is not being cited here.'),
				referenceList(['SpiderMonkey. JavaScript engine notes. 2009.']),
			],
		};

		const refs = getCitationRefs(structure, getIndex(structure));

		assert.equal(refs.has('0'), false);
	});

	it('skips ambiguous single-name no-year identity citations', () => {
		const structure = {
			content: [
				paragraph('The point is contested (Smith 42).'),
				referenceList([
					'Smith, John. First source. Journal of Examples. 2019.',
					'Smith, Anna. Second source. Journal of Examples. 2021.',
				]),
			],
		};

		const refs = getCitationRefs(structure, getIndex(structure));

		assert.equal(refs.has('0'), false);
	});

	it('links prose identity mentions after explicit identity evidence', () => {
		const structure = {
			content: [
				paragraph('The theory appears in Rawls (1971). Rawls argues that justice requires fairness.'),
				referenceList(['Rawls, John. A Theory of Justice. Harvard University Press. 1971.']),
			],
		};

		const refs = getCitationRefs(structure, getIndex(structure));

		assert.deepEqual(refs.get('0').map(ref => ref.dest.blockRef), [[1, 0], [1, 0]]);
	});

	it('does not let prose identity evidence leak across paragraphs', () => {
		const structure = {
			content: [
				paragraph('The theory appears in Rawls (1971).'),
				paragraph('Rawls argues that justice requires fairness.'),
				referenceList(['Rawls, John. A Theory of Justice. Harvard University Press. 1971.']),
			],
		};

		const refs = getCitationRefs(structure, getIndex(structure));

		assert.deepEqual(refs.get('0').map(ref => ref.dest.blockRef), [[2, 0]]);
		assert.equal(refs.has('1'), false);
	});

	it('does not use a same-paragraph year alone as prose identity evidence', () => {
		const structure = {
			content: [
				paragraph('The theory appears in Rawls (1971).'),
				paragraph('Rawls argues that justice requires fairness. The 1971 theory also covers institutions.'),
				referenceList(['Rawls, John. A Theory of Justice. Harvard University Press. 1971.']),
			],
		};

		const refs = getCitationRefs(structure, getIndex(structure));

		assert.deepEqual(refs.get('0').map(ref => ref.dest.blockRef), [[2, 0]]);
		assert.equal(refs.has('1'), false);
	});

	it('does not use a later citation as prose identity evidence', () => {
		const structure = {
			content: [
				paragraph('Rawls argues that justice requires fairness (Rawls, 1971).'),
				referenceList(['Rawls, John. A Theory of Justice. Harvard University Press. 1971.']),
			],
		};

		const refs = getCitationRefs(structure, getIndex(structure));

		assert.equal(refs.get('0').length, 1);
		assert.deepEqual(refs.get('0').map(ref => ref.dest.blockRef), [[1, 0]]);
	});

	it('skips ambiguous single-name prose identity mentions', () => {
		const structure = {
			content: [
				paragraph('Smith argues that the rule is unstable.'),
				referenceList([
					'Smith, John. First source. Journal of Examples. 2019.',
					'Smith, Anna. Second source. Journal of Examples. 2021.',
				]),
			],
		};

		const refs = getCitationRefs(structure, getIndex(structure));

		assert.equal(refs.has('0'), false);
	});

	it('uses adjacent years to disambiguate prose-shaped author-year mentions', () => {
		const structure = {
			content: [
				paragraph('Smith (2021) argues that the rule is unstable.'),
				referenceList([
					'Smith, John. First source. Journal of Examples. 2019.',
					'Smith, Anna. Second source. Journal of Examples. 2021.',
				]),
			],
		};

		const refs = getCitationRefs(structure, getIndex(structure));

		assert.deepEqual(refs.get('0').map(ref => ref.dest.blockRef), [[1, 1]]);
	});

	it('keeps prose paragraphs with leading author-year citations scannable', () => {
		const structure = {
			content: [
				paragraph('Lafollette (2007) argues that moral practice matters.'),
				paragraph('Punch (2009) describes the slippery slope in policing.'),
				referenceList([
					'Lafollette, H. (2007). The practice of ethics. Blackwell Publishing.',
					'Punch, M. (2009). Police corruption: Deviance accountability and reform in policing. Willan Publishing.',
				]),
			],
		};

		const refs = getCitationRefs(structure, getIndex(structure));

		assert.deepEqual(refs.get('0').map(ref => ref.dest.blockRef), [[2, 0]]);
		assert.deepEqual(refs.get('1').map(ref => ref.dest.blockRef), [[2, 1]]);
	});

	it('caps repeated prose identity mentions within one paragraph', () => {
		const structure = {
			content: [
				paragraph('Rawls (1971) argues that justice requires fairness. Rawls also distinguishes liberty from equality. Rawls later returns to institutions.'),
				referenceList(['Rawls, John. A Theory of Justice. Harvard University Press. 1971.']),
			],
		};

		const refs = getCitationRefs(structure, getIndex(structure));

		assert.equal(refs.get('0').length, 2);
		assert.deepEqual(refs.get('0').map(ref => ref.dest.blockRef), [[1, 0], [1, 0]]);
	});

	it('does not cap repeated explicit identity citations within one paragraph', () => {
		const structure = {
			content: [
				paragraph('The first point appears in (Rawls 53). The second appears in (Rawls 55).'),
				referenceList(['Rawls, John. A Theory of Justice. Harvard University Press. 1971.']),
			],
		};

		const refs = getCitationRefs(structure, getIndex(structure));

		assert.equal(refs.get('0').length, 2);
		assert.deepEqual(refs.get('0').map(ref => ref.dest.blockRef), [[1, 0], [1, 0]]);
	});

	it('links citations to paragraph-shaped reference runs', () => {
		const structure = {
			content: [
				paragraph('Smith 2020 established the baseline.'),
				paragraph('Smith, John. Example title. Journal of Examples, 12(3), 45-50. 2020.'),
				paragraph('Jones, Anna. Another title. Example Press. 2021.'),
			],
		};

		const refs = getCitationRefs(structure, getIndex(structure));

		assert.deepEqual(refs.get('0').map(ref => ref.dest.blockRef), [[1]]);
	});

	it('chooses the nearest compatible reference run for repeated local labels', () => {
		const structure = {
			content: [
				paragraph('First section cites [1].'),
				referenceList(['[1] Smith, J. 2020. First local reference.']),
				paragraph('Second section cites [1].'),
				referenceList(['[1] Jones, A. 2021. Second local reference.']),
			],
		};

		const refs = getCitationRefs(structure, getIndex(structure));

		assert.deepEqual(refs.get('0').map(ref => ref.dest.blockRef), [[1, 0]]);
		assert.deepEqual(refs.get('2').map(ref => ref.dest.blockRef), [[3, 0]]);
	});

	it('skips mentions inside reference runs', () => {
		const structure = {
			content: [
				referenceList([
					'[1] Smith, J. 2020. Cites [2] in title text.',
					'[2] Jones, A. 2021. Other title.',
				]),
			],
		};

		const refs = getCitationRefs(structure, getIndex(structure));

		assert.equal(refs.size, 0);
	});

	it('uses embedded links that point to reference entries', () => {
		const structure = {
			content: [
				paragraph('linked text'),
				referenceList(['[1] Smith, J. 2020. Example title.']),
			],
		};
		const annotLinkRefs = new Map([
			['0', [{
				src: { blockRef: [0], offsetStart: 0, offsetEnd: 5, text: 'linked' },
				dest: { blockRef: [1, 0] },
			}]],
		]);

		const refs = getCitationRefs(structure, getIndex(structure), annotLinkRefs);

		assert.deepEqual(refs.get('0').map(ref => ref.dest.blockRef), [[1, 0]]);
	});

	it('does not guess between duplicate author-year entries in one run', () => {
		const structure = {
			content: [
				paragraph('Smith 2020 is ambiguous here.'),
				referenceList([
					'Smith, J. 2020. First title.',
					'Smith, A. 2020. Second title.',
				]),
			],
		};

		const refs = getCitationRefs(structure, getIndex(structure));

		assert.equal(refs.has('0'), false);
	});
});

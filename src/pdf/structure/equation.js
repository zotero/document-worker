import { getBlockText } from './zst/index.js';

function getWords(blockText) {
	const words = [];
	const { text, rects } = blockText;
	if (!text) return words;

	let start = -1;
	let chars = [];

	const addWord = (end) => {
		if (chars.length === 0) return;
		const right = Math.max(...chars.map(c => c.rect[2]));
		words.push({ text: text.slice(start, end), start, end, chars, right });
		chars = [];
	};

	for (let i = 0; i < text.length; i++) {
		const isWS = text[i] === ' ' || text[i] === '\n' || text[i] === '\t';
		if (!isWS) {
			if (start === -1) start = i;
			if (rects[i]) chars.push({ rect: rects[i], index: i });
		} else if (start !== -1) {
			addWord(i);
			start = -1;
		}
	}

	if (start !== -1) addWord(text.length);
	return words;
}

export function getEquations(structure) {
	let equations = new Map();
	// Ensure we work with a Map<number, Array<...>>
	if (!(equations instanceof Map)) {
		equations = new Map();
	}

	for (let i = 0; i < structure.content.length; i++) {
		let block = structure.content[i];
		if (block.type === 'equation') {
			let blockText = getBlockText(structure, [i]);

			const words = getWords(blockText);
			if (words.length === 0) {
				block.rightMostWords = [];
				continue;
			}

			// Only consider words that are numbers wrapped in parentheses without spaces, e.g., "(123)" or "(1.23)"
			const parenNumberRe = /^\(\d+(?:\.\d+)?\)$/;
			const numericParenWords = words.filter(w => parenNumberRe.test(w.text));

			if (numericParenWords.length === 0) {
				block.rightMostWords = [];
				continue;
			}

			// Determine true rightmost position among candidate words
			const maxRight = numericParenWords.reduce((m, w) => Math.max(m, w.right), -Infinity);

			// Collect ALL words that are exactly at that rightmost edge (within small epsilon for float noise)
			const EPSILON = 0.5;
			const candidates = numericParenWords.filter(w => Math.abs(maxRight - w.right) <= EPSILON);

			// Sort for deterministic order: by start offset (reading order)
			candidates.sort((a, b) => a.start - b.start);

			// Group candidates by their numeric key inside parentheses
			for (const w of candidates) {
				const numKey = parseFloat(w.text.slice(1, -1)); // "(12.3)" -> 12.3
				const entry = {
					text: w.text,
					chars: w.chars,
					src: {
						blockRef: [i],
						offsetStart: w.start,
						offsetEnd: w.end
					},
				};
				const arr = equations.get(numKey) || [];
				arr.push(entry);
				equations.set(numKey, arr);
			}
		}
	}
	return equations;
}

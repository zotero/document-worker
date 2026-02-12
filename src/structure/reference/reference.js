import { titles } from './titles.js';
import { getSortIndex } from '../util.js';
import { tokenizeReferenceText } from './utils.js';
import { getBlockPlainText } from '../zst/index.js';



function expandList(list) {

}

function isListItemValid(regularWordsSet, text) {
	let tokens = tokenizeReferenceText(text);
	for (let { text, offset } of tokens) {
		let type;
		if (isName(text)) {
			type = 'name';
		}
		else if (isYear(text)) {
			type = 'year';
		}
		else {
			continue;
		}

		text = text.toLowerCase();

		// Stop adding names if title begins
		if (['“', '‘'].includes(text[0])) {
			let addingNames = false;
		}

		if (
			type === 'name' &&
			(!addingNames || regularWordsSet.has(text))
		) {
			continue;
		}
	}
}
	function isListValid( list) {
		let numYears = 0;
		for (let i = 0; i < list.references.length; i++) {
			let ref = list.references[i];
 			// Count block.text that have a standalone 4-digit year in them
			if (/(^|[^\d])\d{4}($|[^\d])/.test(ref.text)) {
				numYears++;
			}
		}
		if (numYears / list.references.length < 0.7) {
			return false;
		}
		return true;
	}

	function getItemId(text) {
		// Collect a small prefix of the reference to detect leading numbers even if tokenized oddly,
		// e.g., "[", "12", "]" in separate tokens.
		let prefix = '';
		for (let i = 0; i < text.length && i < 24; i++) {
			const ch = text[i];
			prefix += ch;
			// Stop early once we hit the first obvious letter (likely beyond the numeric label)
			if (/[A-Za-z]/.test(ch)) break;
		}

		// Match optional wrappers then digits at the very start:
		// Examples matched: "12", "12.", "[12]", "[12]:", "(12)", "{12}", "  [12]  "
		const match = prefix.match(/^\s*[\[\(\{]*\s*(\d+)\s*[\]\)\}\.:,-]*/);
		if (match) {
			return match[1];
		}

		return null;
	}

// TODO: Use regularWordsSet to eliminate to idetnify list_items that don't have author names (and year),
//  and cut off adding list_items to the current reference list if after more than one bad list_items in a row
//  are encountered
	export function getReferenceLists(structure, regularWordsSet) {
		const candidates = [];
		let current = null;
		// Track the last non-frame block to decide whether a title directly precedes a list (ignoring frames)
		let prevBlock = null;

		for (let i = 0; i < structure.content.length; i++) {
			const block = structure.content[i];
			if (block.type === 'list') {
				let candidate = {
					ref: [i],
					references: [],
				};

				if (prevBlock && prevBlock.type === 'heading') {
					candidate.titleRef = [i - 1];
				}

				for (let j = 0; j < block.content.length; j++) {
					let text = getBlockPlainText(block.content[j]);
					let id = getItemId(text);
					candidate.references.push({ id, text, src: { blockRef: [i, j] } });
				}

				if (candidate.references.length > 0 && isListValid(candidate)) {
					candidates.push(candidate);
				}

				prevBlock = block;
				continue;
			}

			prevBlock = block;
		}

		return candidates;
	}


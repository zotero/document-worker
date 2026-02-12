import { updateRegularWordsSet } from './regular-words.js';
import { tokenizeReferenceText } from './utils.js';

function isYear(word) {
	let number = parseInt(word);
	return (
		word.length === 4 &&
		number == word &&
		number >= 1800 &&
		number <= new Date().getFullYear()
	);
}

function isName(word) {
	return (
		word.length >= 2 &&
		word[0] === word[0].toUpperCase() &&
		word[0].toLowerCase() !== word[0].toUpperCase()
	);
}

// Add leading reference number (if any) to the index, including bracketed forms like "[12]" or "(12)".
export function addNumber(index, referenceLists) {
	for (let referenceList of referenceLists) {
		for (let reference of referenceList.references) {
			const numberKey = reference.id; // the leading number as string
			let refListsMap = index.get(numberKey);
			let refList;

			if (refListsMap) {
				refList = refListsMap.get(referenceList);
				if (!refList) {
					refList = new Map();
					refListsMap.set(referenceList, refList);
				}
			}
			else {
				refListsMap = new Map();
				refList = new Map();
				refListsMap.set(referenceList, refList);
				index.set(numberKey, refListsMap);
			}

			// Store under offset 0: Map<offset:number, references: Reference[]>
			const wordOffsetFrom = 0;
			let refsAtOffset = refList.get(wordOffsetFrom);
			if (!refsAtOffset) {
				refsAtOffset = [];
				refList.set(wordOffsetFrom, refsAtOffset);
			}
			if (!refsAtOffset.includes(reference)) {
				refsAtOffset.push(reference);
			}
		}
	}
	return index;
}



export function addNameYear(index, referenceLists, regularWordsSet) {
	for (let referenceList of referenceLists) {
		for (let reference of referenceList.references) {
			if (!reference?.text) continue;

			let addingNames = true;
			let addingYear = true;

			const tokens = tokenizeReferenceText(reference.text);

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
					addingNames = false;
				}

				if (
					type === 'name' &&
					(!addingNames || regularWordsSet.has(text))
				) {
					continue;
				}

				if (type === 'year' && !addingYear) {
					continue;
				}

				let refListsMap = index.get(text);
				let refList;

				if (refListsMap) {
					refList = refListsMap.get(referenceList);
					if (!refList) {
						refList = new Map();
						refListsMap.set(referenceList, refList);
					}
				}
				else {
					refListsMap = new Map();
					refList = new Map();
					refListsMap.set(referenceList, refList);
					index.set(text, refListsMap);
				}

				// Map<offset:number, references: Reference[]>
				let refsAtOffset = refList.get(offset);
				if (!refsAtOffset) {
					refsAtOffset = [];
					refList.set(offset, refsAtOffset);
				}
				if (!refsAtOffset.includes(reference)) {
					refsAtOffset.push(reference);
				}

				// Stop adding words to the index after a year is encountered.
				if (type === 'year') {
					addingYear = false;
					addingNames = false; // <--- also stop adding names after the first year
				}
			}
		}
	}
	return index;
}

function sortMatches(index) {
	for (const [_, refListsMap] of index) {
		for (const [referenceList, refList] of refListsMap) {
			// refList is Map<offset:number, references: Reference[]>
			const pairs = [];
			for (const [offset, refsAtOffset] of refList) {
				for (const reference of refsAtOffset) {
					pairs.push([offset, reference]);
				}
			}
			pairs.sort((a, b) => a[0] - b[0]);
			refListsMap.set(referenceList, pairs);
		}
	}
	return index;
}

export function getReferenceIndex(referenceLists, regularWordsSet) {
	let index = new Map();
	addNumber(index, referenceLists);
	addNameYear(index, referenceLists, regularWordsSet);
	sortMatches(index);
	return index;
}

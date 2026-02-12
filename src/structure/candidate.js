// Unified parser for delimited citation ranges like [...] and (...)
// Returns { items, nextIndex } only if a proper closing delimiter is found; otherwise returns null.
import { getBlockText, getNextBlockRef } from './zst/index.js';

function parseDelimitedRange(bt, openIndex, openCharVal, closeCharVal, type, refIndex, equations, blockRef) {
	const openChar = bt.text[openIndex];
	if (!openChar || openChar !== openCharVal) return null;

	let chars = [openChar];
	let i = openIndex + 1;
	const allowed = new Set(['0','1','2','3','4','5','6','7','8','9',',','-','–']);

	while (i < bt.text.length) {
		const cur = bt.text[i];

		// Accept digits/separators
		if (allowed.has(cur)) {
			chars.push(cur);
			i++;
			continue;
		}

		// Accept closing delimiter
		if (cur === closeCharVal) {
			chars.push(cur);

			// Support intervals of form [1-5] (already captured) and also [1]-[5] or (1)-(5)
			// Use provided openCharVal/closeCharVal for both bracket and parenthesis cases
			let j = i + 1;

			// Attempt to match: - or – immediately after, then another delimited integer using the same delimiters
			if (j < bt.text.length) {
				const dash = bt.text[j];
				if (dash && (dash === '-' || dash === '–')) {
					// Tentatively collect "-<openCharVal>number<closeCharVal>"
					let k = j + 1;
					if (k < bt.text.length && bt.text[k] === openCharVal) {
						// Append dash and second opening delimiter
						chars.push(dash);
						chars.push(openCharVal);
						k++;

						// Collect digits (only integers) until we find a matching closing delimiter
						let hadDigit = false;
						while (k < bt.text.length) {
							const cur2 = bt.text[k];
							// Only digits inside the second delimited block
							if (cur2 >= '0' && cur2 <= '9') {
								chars.push(cur2);
								hadDigit = true;
								k++;
								continue;
							}

							// Close the second block
							if (cur2 === closeCharVal) {
								// Must have at least one digit collected
								if (!hadDigit) return null;
								chars.push(cur2);
								// Extend the original end to here to cover "[1]-[5]" or "(1)-(5)"
								i = k;
								break;
							}

							// Any other char invalidates the interval extension
							return null;
						}
					}
				}
			}

			// Compute tokens of numbers/ranges from the successfully parsed delimited range
			// Build per-token chars that exclude any delimiters and commas; only digits and a single dash for ranges.
			const tokenCharGroups = (() => {
				const parts = [];
				let current = [];
				for (const ch of chars) {
					const c = ch;
					// Keep only digits, dash/en dash, or comma (comma acts as token separator)
					if ((c >= '0' && c <= '9') || c === '-' || c === '–' || c === ',') {
						if (c === ',') {
							if (current.length) {
								parts.push(current);
								current = [];
							}
						} else {
							current.push(ch);
						}
					}
					// Ignore brackets/parentheses and any other chars
				}
				if (current.length) parts.push(current);
				return parts;
			})();

			const items = [];
			for (const tokenChars of tokenCharGroups) {
				// Derive token text from the kept chars (digits and optional dash)
				const tok = tokenChars.join('');
				const parts = tok.split(/[-–]/).map(s => s.trim()).filter(Boolean);
				let numbers = [];
				let isRange = false;
				if (parts.length === 1) {
					const a = parseInt(parts[0], 10);
					if (Number.isInteger(a)) {
						numbers = [a];
					} else {
						continue;
					}
				} else if (parts.length === 2) {
					const a = parseInt(parts[0], 10);
					const b = parseInt(parts[1], 10);
					if (Number.isInteger(a) && Number.isInteger(b)) {
						const from = Math.min(a, b);
						const to = Math.max(a, b);
						// Do not expand the interval; keep only start and end
						numbers = [from, to];
						isRange = true;
					} else {
						continue;
					}
				} else {
					// Skip malformed token
					continue;
				}

				const referenceRelations = new Map();
				for (const n of numbers) {
					const key = String(n);
					let newRefListsMap = new Map();
					let refListsMap = refIndex.get(key);
					if (refListsMap) {
						for (let [refList, pairs] of refListsMap) {
							if (blockRef[0] < refList.ref[0]) {
								newRefListsMap.set(refList, pairs);
							}
						}
					}
					if (newRefListsMap.size) {
						referenceRelations.set(key, newRefListsMap);
					}
				}

				const equationRelations = [];
				for (const n of numbers) {
					const key = n;
					if (equations && equations.has(key)) {
						equationRelations.push(equations.get(key));
					}
				}

				items.push({
					type,
					group: openCharVal,
					text: tokenChars.join(''), // only digits (and dash for ranges)
					src: {
						blockRef,
						offsetStart: openIndex,
						offsetEnd: i
					},
					numbers,
					referenceRelations,
					equationRelations,
					...(isRange ? { range: true } : {})
				});
			}

			return {
				items,
				nextIndex: i
			};
		}

		// Any other character breaks a properly delimited range
		return null;
	}

	// Ran out of characters without finding the closing delimiter
	return null;
}

// Detect if current char at index i starts a superscript citation number.
function isSuperscriptStart(bt, i) {
	const char = bt.text[i];
	if (!char) return false;
	if (!(char >= '0' && char <= '9')) return false;
	return !!bt.attrs[i]?.style?.sup;
}

// Parse a superscript number starting at index i.
// Returns { item, nextIndex } if a valid sequence is captured; otherwise returns null.
function parseSuperscriptRange(bt, startIndex, refIndex, blockRef) {
	const startChar = bt.text[startIndex];
	if (!bt.attrs[startIndex]?.style?.sup || startChar < '0' || startChar > '9') {
		return null;
	}

	let i = startIndex;
	let chars = [bt.text[i]];

	// Allow digits and simple separators; must remain superscript-sized/positioned and stable font size.
	const allowed = new Set(['0','1','2','3','4','5','6','7','8','9',',','-','–']);
	while (++i < bt.text.length) {
		const cur = bt.text[i];
		// Keep only allowed chars
		if (!bt.attrs[i]?.style?.sup || !allowed.has(cur)) break;
		chars.push(cur);
	}

	// Require at least one digit captured; i has already moved one step past last accepted
	if (chars.length === 0) return null;

	// Build per-token chars by splitting on commas; keep only digits and dashes within tokens
	const tokenCharGroups = (() => {
		const parts = [];
		let current = [];
		for (const ch of chars) {
			const c = ch;
			if ((c >= '0' && c <= '9') || c === '-' || c === '–' || c === ',') {
				if (c === ',') {
					if (current.length) {
						parts.push(current);
						current = [];
					}
				} else {
					current.push(ch);
				}
			}
			// ignore anything else (shouldn't be present here)
		}
		if (current.length) parts.push(current);
		return parts;
	})();

	const items = [];
	for (const tokenChars of tokenCharGroups) {
		const tok = tokenChars.join('');
		const parts = tok.split(/[-–]/).map(s => s.trim()).filter(Boolean);
		let numbers = [];
		let isRange = false;
		if (parts.length === 1) {
			const a = parseInt(parts[0], 10);
			if (Number.isInteger(a)) {
				numbers = [a];
			} else {
				continue;
			}
		} else if (parts.length === 2) {
			const a = parseInt(parts[0], 10);
			const b = parseInt(parts[1], 10);
			if (Number.isInteger(a) && Number.isInteger(b)) {
				const from = Math.min(a, b);
				const to = Math.max(a, b);
				// Do not expand the interval; keep only start and end
				numbers = [from, to];
				isRange = true;
			} else {
				continue;
			}
		} else {
			continue;
		}

		const referenceRelations = new Map();
		for (const n of numbers) {
			const key = String(n);
			let newRefListsMap = new Map();
			let refListsMap = refIndex.get(key);
			if (refListsMap) {
				for (let [refList, pairs] of refListsMap) {
					if (blockRef[0] < refList.ref[0]) {
						newRefListsMap.set(refList, pairs);
					}
				}
			}
			if (newRefListsMap.size) {
				referenceRelations.set(key, newRefListsMap);
			}
		}

		items.push({
			type: 'superscript',
			group: 's',
			text: tokenChars.join(''), // only digits (and dash for ranges)
			src: {
				blockRef,
				offsetStart: startIndex,
				offsetEnd: startIndex + chars.length - 1
			},
			numbers,
			referenceRelations,
			...(isRange ? { range: true } : {})
		});
	}

	return {
		items,
		nextIndex: startIndex + chars.length - 1
	};
}

// ... existing code ...
// Parse a single word starting at index if it begins at a word boundary.
// Returns { text, start, end } or null
function parseWord(bt, startIndex, blockRef) {
	const startChar = bt.text[startIndex];
	if (!startChar) return null;
	// Must start at a word boundary
	const prev = bt.text[startIndex - 1];
	if (prev && !/\s/.test(prev)) return null;

	let text = '';
	let i = startIndex;
	while (i < bt.text.length) {
		const cur = bt.text[i];
		if (/\s/.test(cur)) break;
		text += cur;
		i++;
	}

	if (!text) return null;

	return { text, start: startIndex, end: startIndex + text.length - 1 };
}

function isYearText(text) {
	const n = parseInt(text, 10);
	if (String(n) !== text) return false;
	if (text.length !== 4) return false;
	const now = new Date().getFullYear();
	return n >= 1800 && n <= now;
}

// Parse a year token at index. Returns { item, nextIndex } or null.
function parseYearAt(bt, startIndex, refIndex, blockRef) {
	const word = parseWord(bt, startIndex, blockRef);
	if (!word) return null;
	if (!isYearText(word.text)) return null;

	const referenceRelations = new Map();
	const key = word.text;
	let newRefListsMap = new Map();
	let refListsMap = refIndex.get(key);
			if (refListsMap) {
				for (let [refList, pairs] of refListsMap) {
					if (blockRef[0] < refList.ref[0]) {
						newRefListsMap.set(refList, pairs);
					}
				}
			}
	if (newRefListsMap.size) {
		referenceRelations.set(key, newRefListsMap);
	}

	return {
		item: {
			type: 'year',
			group: 'n-y',
			text: word.text,
			src: {
				blockRef,
				offsetStart: word.start,
				offsetEnd: word.end
			},
			referenceRelations: referenceRelations
		},
		nextIndex: word.end
	};
}

// Parse a name token at index. Returns { item, nextIndex } or null.
function parseNameAt(bt, startIndex, refIndex, blockRef) {
	const word = parseWord(bt, startIndex, blockRef);
	if (!word) return null;

	if (parseInt(word.text[0]) == word.text[0]) {
		return null;
	}
	const referenceRelations = new Map();
	const key = word.text.toLowerCase();
	let newRefListsMap = new Map();
	let refListsMap = refIndex.get(key);
	if (refListsMap) {
		for (let [refList, pairs] of refListsMap) {
			if (blockRef[0] < refList.ref[0]) {
				newRefListsMap.set(refList, pairs);
			}
		}
	}

	if (newRefListsMap.size) {
		referenceRelations.set(key, newRefListsMap);
	}
	else {
		return null;
	}

	return {
		item: {
			type: 'name',
			group: 'n-y',
			text: word.text,
			src: {
				blockRef,
				offsetStart: word.start,
				offsetEnd: word.end
			},
			// Map keyed by the matched name text
			referenceRelations
		},
		nextIndex: word.end
	};
}

// Helpers for figure-reference parsing
function hasDigit(str) {
	return /[0-9]/.test(str);
}

// Trim non-letters from both ends using casing heuristic
function trimNonLettersUsingCase(str) {
	let start = 0;
	let end = str.length - 1;
	while (start <= end && str[start].toLowerCase() === str[start].toUpperCase()) start++;
	while (end >= start && str[end].toLowerCase() === str[end].toUpperCase()) end--;
	return str.slice(start, end + 1);
}

// Trim leading/trailing non-digits
function trimNonNumbers(str) {
	return str.replace(/^\D+|\D+$/g, '');
}

const FIGURE_LABELS = new Map([
	['figure', 'figure'], ['fig', 'figure'],
	['photograph', 'photograph'], ['photo', 'photograph'],
	['illustration', 'illustration'], ['illus', 'illustration'],
	['table', 'table'], ['tbl', 'table'],
	['equation', 'equation'], ['eq', 'equation'],
	['example', 'example'], ['ex', 'example'],
]);

function normalizeLabelWord(textRaw) {
	// Normalize like "Fig." -> "fig"
	let text = trimNonLettersUsingCase(textRaw).toLowerCase();
	// Remove trailing period on abbreviations (e.g., "fig.")
	if (text.endsWith('.')) text = text.slice(0, -1);
	return FIGURE_LABELS.get(text) || null;
}

// Parse an in-text figure reference at index by matching known figure names from `figures`.
// We only accept references where the first word is a known figure name (present as a key in `figures`),
// and the second word starts with a number that maps to figures.get(name).get(number).
function parseFigureRefAt(bt, startIndex, figures, blockRef) {
	const firstWord = parseWord(bt, startIndex, blockRef);
	if (!firstWord) return null;

	// Normalize the label (e.g., "Fig." -> "figure")
	const name = firstWord.text.toLowerCase();
	if (!name) return null;

	// Only proceed if `figures` has this name as a key
	if (!figures || !figures.has || !figures.has(name)) return null;

	// Get the next word (the number token)
	const secondWord = parseWord(bt, firstWord.end + 1, blockRef);
	if (!secondWord) return null;

	// Only consider the leading number in the second word
	const m = secondWord.text.match(/^(\d+)/);
	if (!m) return null;
	const number = m[1];

	// Lookup id via figures.get(name).get(number)
	const byName = figures.get(name);
	if (!byName || !byName.get) return null;

	const id = byName.get(number);
	if (!id) return null;

	const from = firstWord.start;
	const to = secondWord.end;

	const text = bt.text.slice(from, to + 1);

	return {
		item: {
			type: 'figure',
			group: name,
			text,
			src: {
				blockRef,
				offsetStart: from,
				offsetEnd: to
			},
			id,
			figureRelations: [id]
		},
		nextIndex: to
	};
}

// URL/DOI parsing helpers and parser
const URL_BREAK_CHARS = new Set(['/', '-', '_', '.', '?', '&', '=', ':', '#', ';', ',', '+', '~', '@', '!', '%']);

// Collect a continuous sequence suitable for URLs starting at startIndex
function collectUrlSequence(bt, startIndex) {
	let from = startIndex;
	let to = startIndex;
	for (let i = startIndex; i < bt.text.length; i++) {
		const cur = bt.text[i];
		const prev = bt.text[i - 1];

		// Always include current first
		if (i === startIndex) {
			to = i;
			continue;
		}

		// Hard break on explicit spacing
		if (prev && /\s/.test(prev)) break;

		// Break on big font/name change or wrapped line that is not URL-friendly
		const prevRect = bt.rects[i - 1];
		const curRect = bt.rects[i];
		const wrappedLeft = prevRect && curRect && prevRect[0] > curRect[0];
		const lineHeight = curRect ? (curRect[3] - curRect[1]) : 0;
		const wrappedTooFar =
			wrappedLeft &&
			(prevRect[1] - curRect[3] > lineHeight / 2) &&
			!(URL_BREAK_CHARS.has(prev) || URL_BREAK_CHARS.has(cur));

		if (wrappedTooFar) break;

		to = i;
	}
	return { from, to };
}

export function getCandidates(structure, candidateGroups, refIndex, figures, equations) {
	// { type, blockIndex, rect, text, offsetStart, offsetEnd, char }

	// write a parser

	let items = [];

	let blockRef = null;
	while ((blockRef = getNextBlockRef(structure, blockRef))) {
		let bt = getBlockText(structure, blockRef);
		for (let i = 0; i < bt.text.length; i++) {
			let parsed;

			// Try delimited ranges; parser will validate openings
			if ((parsed = parseDelimitedRange(bt, i, '[', ']', 'brackets', refIndex, equations, blockRef))) {
				if (parsed.items && parsed.items.length) items.push(...parsed.items);
				i = parsed.nextIndex;
			}
			else if ((parsed = parseDelimitedRange(bt, i, '(', ')', 'parentheses', refIndex, equations, blockRef))) {
				if (parsed.items && parsed.items.length) items.push(...parsed.items);
				i = parsed.nextIndex;
			}
			// Superscript detection
			else
			if ((parsed = parseSuperscriptRange(bt, i, refIndex, blockRef))) {
				if (parsed.items && parsed.items.length) items.push(...parsed.items);
				i = parsed.nextIndex;
			}
			// Year token (e.g., 1998)
			else if ((parsed = parseYearAt(bt, i, refIndex, blockRef))) {
				items.push(parsed.item);
				i = parsed.nextIndex;
			}
			// Name token (capitalized word, e.g., Smith)
			else if ((parsed = parseNameAt(bt, i, refIndex, blockRef))) {
				items.push(parsed.item);
				i = parsed.nextIndex;
			}
			// In-text figure reference (e.g., Fig. 2, (Figure 3), Table 1)
			else if ((parsed = parseFigureRefAt(bt, i, figures, blockRef))) {
				items.push(parsed.item);
				i = parsed.nextIndex;
			}
		}
	}

	// Group items by item.group using a Map for simplicity
	for (const item of items) {
		const key = item.group || '';
		if (!candidateGroups.has(key)) {
			candidateGroups.set(key, []);
		}
		candidateGroups.get(key).push(item);
	}

	return candidateGroups;
}

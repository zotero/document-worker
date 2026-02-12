
// export function validatePageLabel(blocks, chars, pageLabel) {
// 	let combinedChars = blocks.flatMap(x => chars.slice(x.startOffset, x.endOffset + 1));
// 	let words = getWordsFromChars(combinedChars);
//
// 	// Normalize and parse the provided pageLabel into a comparable form
// 	const target = (pageLabel == null ? '' : String(pageLabel)).trim();
// 	if (!target) return false;
//
// 	const parsedTarget = parseCandidateNumber(target);
// 	if (!parsedTarget) return false;
//
// 	// Look for any word on the page that represents the same label
// 	for (const word of words) {
// 		const parsedWord = parseCandidateNumber(word.text);
// 		if (parsedWord && parsedWord.type === parsedTarget.type && parsedWord.integer === parsedTarget.integer) {
// 			return true;
// 		}
// 	}
//
// 	return false;
// }


function romanToInteger(str) {
	// Check if the string is empty or mixed case
	if (!str || str.length === 0 || (str !== str.toUpperCase() && str !== str.toLowerCase())) {
		return null; // Not a valid Roman numeral due to empty, mixed case, or non-string input
	}

	// Define Roman numeral values and subtractive pairs for validation
	const values = {I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000};
	// Normalize input to uppercase for consistent processing
	const input = str.toUpperCase();

	let total = 0;
	let prevValue = 0;

	for (let i = 0; i < input.length; i++) {
		const currentValue = values[input[i]];

		// Invalid character check
		if (currentValue === undefined) return null;

		// Main conversion logic with subtractive notation handling
		if (currentValue > prevValue) {
			// Subtract twice the previous value since it was added once before
			total += currentValue - 2 * prevValue;
		} else {
			total += currentValue;
		}

		prevValue = currentValue;
	}

	return total;
}

function extractLastInteger(str) {
	let numStr = '';
	let foundDigit = false;

	for (let i = str.length - 1; i >= 0; i--) {
		const char = str[i];
		if (char >= '0' && char <= '9') {
			numStr = char + numStr;
			foundDigit = true;
		} else if (foundDigit) {
			// Once a non-digit is encountered after finding at least one digit, break
			break;
		}
	}

	return foundDigit ? parseInt(numStr, 10) : null;
}

function parseCandidateNumber(str) {
	let type = 'arabic';
	let integer = extractLastInteger(str);
	if (!integer) {
		type = 'roman';
		integer = romanToInteger(str);
		if (!integer) {
			return null;
		}
	}
	return { type, integer };
}

function getPageLabelCandidates(contentNodes) {
	let candidates = [];

	// Only look at artifact paragraphs (frames)
	let frameNodes = contentNodes.filter(x => x.artifact);

	// Extract all text from frame nodes
	for (let node of frameNodes) {
		if (!node.content) continue;

		// node.content is an array of text nodes, extract the text
		for (let textNode of node.content) {
			if (textNode.type === 'text' && textNode.text) {
				// Split text into words
				let words = textNode.text.split(' ').filter(Boolean);
				for (let word of words) {
					let candidateNumber = parseCandidateNumber(word);
					if (candidateNumber) {
						candidates.push({
							text: word,
							type: candidateNumber.type,
							integer: candidateNumber.integer
						});
					}
				}
			}
		}
	}

	return candidates;
}

// pageLabelCandidates is an array where each index represent each page and is array of candidates for that page
function getBestSequences(pageLabelCandidates) {
	// Helper: Fenwick Tree (Binary Indexed Tree) for max (length, nodeId)
	class FenwickMax {
		constructor(n) {
			this.n = n;
			this.tree = new Array(n + 2);
			for (let i = 0; i < this.tree.length; i++) {
				this.tree[i] = { len: 0, nodeId: -1 };
			}
		}
		_query(i) {
			let best = { len: 0, nodeId: -1 };
			while (i > 0) {
				if (this.tree[i].len > best.len) best = this.tree[i];
				i -= i & -i;
			}
			return best;
		}
		queryLessThan(i) {
			// query max in [1..i]
			return this._query(i);
		}
		update(i, len, nodeId) {
			while (i <= this.n) {
				if (len > this.tree[i].len) this.tree[i] = { len, nodeId };
				i += i & -i;
			}
		}
	}

	// Organize candidates per type and keep node references for path reconstruction
	const types = ['arabic', 'roman'];
	// resultSequences now maps type -> items[] directly
	const resultSequences = {};

	for (const type of types) {
		// Collect all candidates of this type across pages
		const pages = pageLabelCandidates.map((cands) => (cands || []).filter(c => c.type === type));

		// Early exit if no candidates
		const hasAny = pages.some(cands => cands.length > 0);
		if (!hasAny) {
			resultSequences[type] = [];
			continue;
		}

		// Coordinate compression for integer values of this type
		const allVals = [];
		for (const cands of pages) {
			for (const c of cands) allVals.push(c.integer);
		}
		allVals.sort((a, b) => a - b);
		const uniqVals = [];
		for (let i = 0; i < allVals.length; i++) {
			if (i === 0 || allVals[i] !== allVals[i - 1]) uniqVals.push(allVals[i]);
		}
		const coord = new Map();
		for (let i = 0; i < uniqVals.length; i++) coord.set(uniqVals[i], i + 1); // 1-based

		// Node store and DP info
		const fenwick = new FenwickMax(uniqVals.length);
		const nodes = []; // { id, pageIndex, candidate, integer, prevId, len }
		let bestEndId = -1;
		let bestLen = 0;

		for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
			const cands = pages[pageIndex];
			if (!cands || cands.length === 0) continue;

			// First pass: compute DP res for this page's candidates based on previous pages only
			const tempUpdates = []; // { idx, len, nodeId }
			for (let candIndex = 0; candIndex < cands.length; candIndex++) {
				const cand = cands[candIndex];
				const compressed = coord.get(cand.integer);
				// strictly increasing, so query strictly smaller values -> indices < compressed
				const bestPrev = fenwick.queryLessThan(compressed - 1);
				const prevLen = bestPrev.len;
				const prevId = bestPrev.nodeId;
				const curLen = prevLen + 1;

				const nodeId = nodes.length;
				nodes.push({
					id: nodeId,
					pageIndex,
					candidate: cand,
					integer: cand.integer,
					prevId,
					len: curLen,
				});

				tempUpdates.push({ idx: compressed, len: curLen, nodeId });

				// Track global best
				if (curLen > bestLen) {
					bestLen = curLen;
					bestEndId = nodeId;
				}
			}

			// Second pass: apply updates for this page (prevents intra-page chaining)
			for (const u of tempUpdates) {
				fenwick.update(u.idx, u.len, u.nodeId);
			}
		}

		// Reconstruct best sequence for this type
		const items = [];
		let cur = bestEndId;
		while (cur !== -1 && cur != null) {
			const node = nodes[cur];
			items.push({
				pageIndex: node.pageIndex,
				integer: node.integer,
				candidate: node.candidate,
			});
			cur = node.prevId;
		}
		items.reverse();

		// Store items array directly under the type
		resultSequences[type] = items;
	}

	// Return object keyed by type to items array without sorting
	return resultSequences;
}

function validate(catalogPageLabels, pages) {
	let rx = /[?.,;!¡¿。、·(){}\[\]\/$:]+/u;

	let validatedPageLabels = [];
	for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
		let page = pages[pageIndex];
		let pageLabel = catalogPageLabels[pageIndex];
		let validatedInFrame = false;
		for (let block of page.blocks) {
			if (block.type === 'frame') {
				let parts = new Set(block.text.split(rx).filter(Boolean));
				if (parts.has(pageLabel)) {
					validatedInFrame = true;
					break;
				}
			}
		}

		let validatedInBody = false;
		if (!validatedInFrame) {
			for (let block of page.blocks) {
				if (block.type !== 'frame') {
					let parts = new Set(block.text.split(rx).filter(Boolean));
					if (parts.has(pageLabel)) {
						validatedInBody = true;
						break;
					}
				}
			}
		}

		validatedPageLabels[pageIndex] = [pageLabel, validatedInFrame, validatedInBody];
	}
	return validatedPageLabels;
}

function getPageLabels(catalogPageLabels, pageLabelCandidates, pagesCount) {
	let pageLabels = Array(pagesCount).fill('-');

	let { arabic, roman } = getBestSequences(pageLabelCandidates);

	if (arabic.length / pagesCount >= 0.3) {
		for (let item of arabic) {
			pageLabels[item.pageIndex] = item.integer.toString();
		}
	}

	if (roman.length >= 5) {
		for (let item of roman) {
			pageLabels[item.pageIndex] = item.candidate.text.toLowerCase();
		}
	}

	// let validatedPageLabels = validate(catalogPageLabels, pages);

	return pageLabels;
}

export function addPageLabels(structure, catalogPageLabels) {
	if (!structure || !Array.isArray(structure.pages)) {
		return;
	}

	const pagesCount = structure.pages.length;
	let pageLabels = null;

	if (Array.isArray(catalogPageLabels) && catalogPageLabels.length === pagesCount) {
		pageLabels = catalogPageLabels;
	} else {
		const pageLabelCandidates = [];
		for (let pageIndex = 0; pageIndex < structure.pages.length; pageIndex++) {
			let page = structure.pages[pageIndex];
			if (page && Array.isArray(page.contentRanges)) {
				// Get all content nodes for this page
				let contentNodes = [];
				for (let range of page.contentRanges) {
					for (let i = range[0]; i <= range[1]; i++) {
						contentNodes.push(structure.content[i]);
					}
				}
				pageLabelCandidates.push(getPageLabelCandidates(contentNodes));
			} else {
				pageLabelCandidates.push([]);
			}
		}

		const inferred = getPageLabels(catalogPageLabels, pageLabelCandidates, pagesCount);
		if (Array.isArray(inferred) && inferred.some(label => label && label !== '-')) {
			pageLabels = inferred;
		}
	}

	if (!pageLabels) {
		pageLabels = Array.from({ length: pagesCount }, (_, i) => (i + 1).toString());
	}

	for (let i = 0; i < pagesCount; i++) {
		const label = pageLabels[i] != null ? String(pageLabels[i]) : (i + 1).toString();
		structure.pages[i].label = label;
	}
}

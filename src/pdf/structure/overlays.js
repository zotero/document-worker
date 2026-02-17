import { applyTextAttributes, getBlockText } from './zst/index.js';

function preprocessNumberReferences(refCit) {
	let { references } = refCit.refList;
	for (let [candidate, relations] of refCit.candidateRelations) {
		let preprocessedReferences = [];
		let values = Array.from(relations.values());
		let startReference = values[0][0][1];
		let endReference;
		// Single citation
		if (values.length === 1) {
			preprocessedReferences.push(startReference);
		} // Citation interval
		else if (values.length === 2) {
			endReference = values[1][0][1];
			let startIndex = references.indexOf(startReference);
			let endIndex = references.indexOf(endReference);
			preprocessedReferences = references.slice(startIndex, endIndex + 1);
		}
		preprocessedReferences = preprocessedReferences.map(x => ({ originalReference: x, offset: 0 }));
		candidate.preprocessedReferences = preprocessedReferences;
	}

}

function preprocessNameReferences(candidateRelations) {
	let entries = Array.from(candidateRelations.entries());

	for (let i = 0; i < entries.length; i++) {
		let [candidate, relations] = entries[i];
		if (candidate.type !== 'name') {
			continue;
		}

		candidate.preprocessedReferences = new Map(relations.values().next().value.map(x => [
			x[1],
			{
				originalReference: x[1],
				offset: x[0],
				years: new Map()
			}
		]));

		let blockIndex = candidate.blockIndex;


		let surroundingMatches = [];
		for (let j = i - 1; j >= 0; j--) {
			let [prevCandidate, prevRelations] = entries[j];
			if (prevCandidate.blockIndex !== blockIndex) {
				break;
			}

			let [year, prevReferences] = prevRelations.entries().next().value;
			let distance = i - j;

			let matchedAnyReference = false;
			for (let [offset, reference] of prevReferences) {
				if (candidate.preprocessedReferences.has(reference)) {
					matchedAnyReference = true;
					if (prevCandidate.type === 'year') {
						surroundingMatches.push([distance, offset, year, reference]);
					}
				}
			}
			if (!matchedAnyReference) {
				break;
			}
		}

		for (let j = i + 1; j < entries.length; j++) {
			let [nextCandidate, nextRelations] = entries[j];
			if (nextCandidate.blockIndex !== blockIndex) {
				break;
			}
			let [year, nextReferences] = nextRelations.entries().next().value;
			let distance = j - i;

			let matchedAnyReference = false;
			for (let [offset, reference] of nextReferences) {
				if (candidate.preprocessedReferences.has(reference)) {
					matchedAnyReference = true;
					if (nextCandidate.type === 'year') {
						surroundingMatches.push([distance, offset, year, reference]);
					}
				}
			}
			if (!matchedAnyReference) {
				break;
			}
		}


		// sort descending by distance to the previous year candidate
		surroundingMatches.sort((a, b) => a[0] - b[0]);

		let matchDist = new Map();
		for (let [distance, offset, year, reference] of surroundingMatches) {
			let nameRef = candidate.preprocessedReferences.get(reference);
			if (!nameRef.years.has(year)) {
				nameRef.years.set(year, { textDistance: distance, refOffset: offset });
			}
		}

		candidate.preprocessedReferences = Array.from(candidate.preprocessedReferences.values());

		candidate.preprocessedReferences.sort((a, b) => {
			if (a.offset === b.offset) {
				// Closest year dist
				let distance1 = Array.from(a.years.values()).map(x => x.textDistance).sort()[0] || 0;
				let distance2 = Array.from(b.years.values()).map(x => x.textDistance).sort()[0] || 0;
				return distance2 - distance1;
			}
			return a.offset - b.offset;
		});

	}
}

export function getRefCit(candidateGroups) {
	let refCitGroups = new Map();
	for (let [key, candidateGroup] of candidateGroups) {
		for (let candidate of candidateGroup) {
			if (candidate.referenceRelations) {
				for (let [matchText, refListsMap] of candidate.referenceRelations) {
					for (let [refList, pairs] of refListsMap) {
						let g1 = refCitGroups.get(refList);
						if (!g1) {
							g1 = new Map();
							refCitGroups.set(refList, g1);
						}

						let obj = g1.get(candidateGroup);
						if (!obj) {
							obj = {
								refList,
								candidateGroup,
								candidateRelations: new Map()
							};
							g1.set(candidateGroup, obj);
						}

						let candidateRelation = obj.candidateRelations.get(candidate);

						if (!candidateRelation) {
							candidateRelation = new Map();
							obj.candidateRelations.set(candidate, candidateRelation);
						}

						candidateRelation.set(matchText, pairs);
					}
				}
			}
		}
	}

	refCitGroups = Array.from(refCitGroups.values().flatMap(x => x.values()));

	for (let refCit of refCitGroups) {
		// Only explicit numbers are counted. For intervals only start and end numbers are counted
		let matchedRefsSet = new Set();
		for (const candidateRelation of refCit.candidateRelations.values()) {
			for (const [key, pairs] of candidateRelation) {
				for (const pair of pairs) {
					if (!(key.length === 4 && parseInt(key) == key)) {
						const reference = pair[1];
						matchedRefsSet.add(reference);
					}
				}
			}
		}

		refCit.type = refCit.candidateGroup[0].numbers ? 'number' : 'name';

		refCit.matchedReferences = Array.from(matchedRefsSet);
		refCit.referenceCoverage = refCit.matchedReferences.length / refCit.refList.references.length;
		let matchedPages = [...new Set(refCit.candidateGroup.map(x => x.pageIndex))].filter(Number.isInteger);
		refCit.matchedPages = matchedPages;
		let totalPages = null;
		let firstRefBlockPageIndex = refCit.refList?.references?.[0]?.blocks?.[0]?.pageIndex;
		if (Number.isInteger(firstRefBlockPageIndex)) {
			totalPages = firstRefBlockPageIndex + 1;
		}
		else if (matchedPages.length) {
			totalPages = Math.max(...matchedPages) + 1;
		}
		refCit.pageCoverage = totalPages ? matchedPages.length / totalPages : 1;
	}

	let bestRefCit = null;
	for (let refCit of refCitGroups) {
		if (
			(!bestRefCit || refCit.matchedReferences > bestRefCit.matchedReferences)
			&& refCit.referenceCoverage > 0.3 && refCit.pageCoverage >= 0.3
		) {
			bestRefCit = refCit;
		}
	}

	if (bestRefCit) {
		if (bestRefCit.type === 'number') {
			preprocessNumberReferences(bestRefCit);
		}
		// name
		else {
			preprocessNameReferences(bestRefCit.candidateRelations);
			for (let [candidate, relations] of bestRefCit.candidateRelations) {
				if (candidate.type === 'year') {
					bestRefCit.candidateRelations.delete(candidate);
				}
			}
		}
		candidateGroups.delete(bestRefCit.candidateGroup);
	}

	return bestRefCit;
}

export function getRefsList(candidateGroups) {
	let equationGroup = null;
	let figureGroups = [];

	let bestRefCit = getRefCit(candidateGroups);


	for (let [key, candidateGroup] of candidateGroups) {
		if (candidateGroup[0].equationRelations) {
			equationGroup = candidateGroup;
			candidateGroups.delete(candidateGroup);
			break;
		}
	}

	for (let [key, candidateGroup] of candidateGroups) {
		if (candidateGroup[0].figureRelations) {
			candidateGroups.delete(candidateGroup);
			figureGroups.push(candidateGroup[0]);
			break;
		}
	}

	let refsList = new Map();
	const addRef = (source, destination, type) => {
		const key = Array.isArray(source?.blockRef) ? source.blockRef.join(',') : null;
		if (!key) {
			return;
		}
		let group = refsList.get(key);
		if (!group) {
			group = [];
			refsList.set(key, group);
		}
		group.push({ src: source, dest: destination, type });
	};
	const isSameBlock = (srcA, srcB) =>
		srcA?.blockRef?.[0] !== undefined && srcA?.blockRef?.[0] === srcB?.blockRef?.[0];

	if (bestRefCit) {
		for (let [citation, relations] of bestRefCit.candidateRelations) {
			if (!citation?.src) {
				continue;
			}
			let references = citation.preprocessedReferences?.map(x => x.originalReference) || [];
			for (let reference of references) {
				if (!isSameBlock(citation.src, reference.src)) {
					addRef(citation.src, reference.src, 'citation');
				}
			}
		}
	}

	for (let figure of figureGroups) {
		let destination = figure?.figureRelations?.[0];
		if (!isSameBlock(figure.src, destination.src)) {
			addRef(figure.src, destination.src, 'figure');
		}
	}

	if (equationGroup) {
		for (let equation of equationGroup) {
			let destination = equation?.equationRelations?.[0]?.[0];
			if (destination && !isSameBlock(equation.src, destination.src)) {
				addRef(equation.src, destination.src, 'equation');
			}
		}
	}

	return refsList;
}

function sameRef(a, b) {
	if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
		return false;
	}
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) {
			return false;
		}
	}
	return true;
}

function getNodeByRef(structure, ref) {
	if (!structure || !Array.isArray(ref)) {
		return null;
	}
	let node = { content: structure.content };
	for (const index of ref) {
		if (!node || !Array.isArray(node.content)) {
			return null;
		}
		node = node.content[index];
		if (!node || typeof node !== 'object') {
			return null;
		}
	}
	return node;
}

function addRef(node, refToAdd) {
	if (!node || !Array.isArray(refToAdd)) {
		return node;
	}
	const refs = Array.isArray(node.refs) ? node.refs.slice() : [];
	if (!refs.some((ref) => sameRef(ref, refToAdd))) {
		refs.push(refToAdd.slice());
	}
	return {
		...node,
		refs
	};
}

function addBackRef(node, refToAdd) {
	if (!node || !Array.isArray(refToAdd)) {
		return node;
	}
	const backRefs = Array.isArray(node.backRefs) ? node.backRefs.slice() : [];
	if (!backRefs.some((ref) => sameRef(ref, refToAdd))) {
		backRefs.push(refToAdd.slice());
	}
	return {
		...node,
		backRefs
	};
}

function applyRefToText(structure, target, refToAdd) {
	if (!target?.blockRef) {
		return null;
	}
	return applyTextAttributes(
		structure,
		target.blockRef,
		target.offsetStart,
		target.offsetEnd,
		(node) => addRef(node, refToAdd)
	);
}

function applyRefToBlock(structure, blockRef, refToAdd) {
	const node = getNodeByRef(structure, blockRef);
	if (!node) {
		return null;
	}
	const updated = addRef(node, refToAdd);
	Object.assign(node, updated);
	return blockRef;
}

function applyBackRefToText(structure, target, refToAdd) {
	if (!target?.blockRef) {
		return null;
	}
	return applyTextAttributes(
		structure,
		target.blockRef,
		target.offsetStart,
		target.offsetEnd,
		(node) => addBackRef(node, refToAdd)
	);
}

function applyBackRefToBlock(structure, blockRef, refToAdd) {
	const node = getNodeByRef(structure, blockRef);
	if (!node) {
		return null;
	}
	const updated = addBackRef(node, refToAdd);
	Object.assign(node, updated);
	return blockRef;
}

export function applyRefs(structure, refsList) {
	if (!structure || !refsList) {
		return;
	}

	const groups = refsList instanceof Map ? refsList.values() : [refsList];
	for (const group of groups) {
		if (!Array.isArray(group) || group.length === 0) {
			continue;
		}
		for (const entry of group) {
			if (!entry?.src || !entry?.dest) {
				continue;
			}
			const source = entry.src;
			const destination = entry.dest;

			if (!source?.blockRef || !destination?.blockRef) {
				continue;
			}

			const destRef = Array.isArray(destination.blockRef) ? destination.blockRef : null;
			if (!destRef) {
				continue;
			}

			let sourceTextNodeRef = applyRefToText(structure, source, destRef);
			if (!sourceTextNodeRef) {
				sourceTextNodeRef = applyRefToBlock(structure, source.blockRef, destRef);
			}
			if (!sourceTextNodeRef) {
				continue;
			}

			let destTextNodeRef = applyBackRefToText(structure, destination, sourceTextNodeRef);
			if (!destTextNodeRef) {
				applyBackRefToBlock(structure, destination.blockRef, sourceTextNodeRef);
			}
		}
	}
}

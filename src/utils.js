import { distance } from 'fastest-levenshtein';

export function quadPointsToRects(quadPoints) {
	let rects = [];
	for (let j = 0; j < quadPoints.length; j += 8) {
		let topLeft = { x: quadPoints[j + 4], y: quadPoints[j + 5] };
		let bottomRight = { x: quadPoints[j + 2], y: quadPoints[j + 3] };
		let x = Math.min(topLeft.x, bottomRight.x);
		let y = Math.min(topLeft.y, bottomRight.y);
		let width = Math.abs(topLeft.x - bottomRight.x);
		let height = Math.abs(topLeft.y - bottomRight.y);
		rects.push([x, y, x + width, y + height]);
	}
	return rects;
}

export function pdfDateToIso(str) {
	let m = str.match(/([0-9]{4})([0-9]{2}|)([0-9]{2}|)([0-9]{2}|)([0-9]{2}|)([0-9]{2}|)/);
	if (!m) {
		return (new Date()).toISOString();
	}
	let d = [];
	for (let i = 1; i <= 6; i++) {
		if (!m[i]) break;
		d.push(parseInt(m[i]));
	}

	if (d[1]) {
		d[1] -= 1;
	}

	return (new Date(Date.UTC(...d))).toISOString();
}

export function normalizeText(text) {
	// Decompose and remove diacritics, spaces, all types of dashes
	return text
		.normalize('NFD')
		.replace(/[\u0300-\u036f\s\x2D\u058A\u05BE\u1400\u1806\u2010-\u2015\u2E17\u2E1A\u2E3A\u2E3B\u301C\u3030\u30A0\uFE31\uFE32\uFE58\uFE63\uFF0D]/g, '')
		.toLowerCase();
}

export function textApproximatelyEqual(a, b) {
	a = normalizeText(a);
	b = normalizeText(b);
	return distance(a, b) < a.length * 0.1;
}

export function getSortIndex(pageIndex, offset, top) {
	return [
		pageIndex.toString().slice(0, 5).padStart(5, '0'),
		offset.toString().slice(0, 6).padStart(6, '0'),
		Math.max(Math.floor(top), 0).toString().slice(0, 5).padStart(5, '0')
	].join('|');
}

export function getPositionFromRects(chars, pageIndex) {
	let chars1 = [];
	let chars2 = [];
	for (let char of chars) {
		if (char.pageIndex === pageIndex) {
			chars1.push(char);
		} else {
			chars2.push(char);
		}
	}
	let position = {
		pageIndex,
		rects: getRectsFromChars(chars1),
	};
	if (chars2.length) {
		position.nextPageRects = getRectsFromChars(chars2);
	}
	return position;
}

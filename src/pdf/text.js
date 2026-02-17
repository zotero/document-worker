
function rectsDist([ax1, ay1, ax2, ay2], [bx1, by1, bx2, by2]) {
	let left = bx2 < ax1;
	let right = ax2 < bx1;
	let bottom = by2 < ay1;
	let top = ay2 < by1;

	if (top && left) {
		return Math.hypot(ax1 - bx2, ay2 - by1);
	}
	else if (left && bottom) {
		return Math.hypot(ax1 - bx2, ay1 - by2);
	}
	else if (bottom && right) {
		return Math.hypot(ax2 - bx1, ay1 - by2);
	}
	else if (right && top) {
		return Math.hypot(ax2 - bx1, ay2 - by1);
	}
	else if (left) {
		return ax1 - bx2;
	}
	else if (right) {
		return bx1 - ax2;
	}
	else if (bottom) {
		return ay1 - by2;
	}
	else if (top) {
		return by1 - ay2;
	}

	return 0;
}

function getClosestOffset(chars, rect) {
	let dist = Infinity;
	let idx = 0;
	for (let i = 0; i < chars.length; i++) {
		let ch = chars[i];
		let distance = rectsDist(ch.rect, rect);
		if (distance < dist) {
			dist = distance;
			idx = i;
		}
	}
	return idx;
}

function quickIntersectRect(r1, r2) {
	return !(r2[0] > r1[2]
		|| r2[2] < r1[0]
		|| r2[1] > r1[3]
		|| r2[3] < r1[1]);
}

function getCenterRect(r) {
	return [
		r[0] + (r[2] - r[0]) / 2,
		r[1] + (r[3] - r[1]) / 2,
		r[0] + (r[2] - r[0]) / 2,
		r[1] + (r[3] - r[1]) / 2
	];
}


function getRangeByHighlight(chars, rects) {
	// Note: rects may not be in order, so we find the first and last occurrence in chars
	if (!chars.length) {
		return null;
	}
	let anchorOffset = Infinity;
	for (let i = 0; i < chars.length; i++) {
		let char = chars[i];
		if (rects.some(rect => quickIntersectRect(getCenterRect(char.rect), rect))) {
			anchorOffset = i;
			break;
		}
	}
	let headOffset = 0;
	for (let i = chars.length - 1; i >= 0; i--) {
		let char = chars[i];
		if (rects.some(rect => quickIntersectRect(getCenterRect(char.rect), rect))) {
			headOffset = i;
			break;
		}
	}

	headOffset++;

	if (anchorOffset > headOffset) {
		return null;
	}

	let range = getRange(chars, anchorOffset, headOffset);
	range.offset = range.anchorOffset;
	range.from = range.anchorOffset;
	range.to = range.headOffset;
	// delete range.anchorOffset;
	// delete range.headOffset;
	return range;
}

function getLineSelectionRect(line, charFrom, charTo) {
	if ([90, 270].includes(line.words.at(-1).chars.at(-1).rotation)) {
		return [
			line.rect[0],
			Math.min(charFrom.rect[1], charTo.rect[1]),
			line.rect[2],
			Math.max(charFrom.rect[3], charTo.rect[3])
		];
	}
	else {
		return [
			Math.min(charFrom.rect[0], charTo.rect[0]),
			line.rect[1],
			Math.max(charFrom.rect[2], charTo.rect[2]),
			line.rect[3]
		];
	}
}

function getRectsFromChars(chars) {
	let lineRects = [];
	let currentLineRect = null;
	for (let char of chars) {
		if (!currentLineRect) {
			currentLineRect = char.inlineRect.slice();
		}
		currentLineRect = [
			Math.min(currentLineRect[0], char.inlineRect[0]),
			Math.min(currentLineRect[1], char.inlineRect[1]),
			Math.max(currentLineRect[2], char.inlineRect[2]),
			Math.max(currentLineRect[3], char.inlineRect[3])
		];
		if (char.lineBreakAfter) {
			lineRects.push(currentLineRect);
			currentLineRect = null;
		}
	}
	if (currentLineRect) {
		lineRects.push(currentLineRect);
	}
	return lineRects;
}

function getTextFromChars(chars) {
	let text = [];
	for (let char of chars) {
		if (!char.ignorable) {
			text.push(char.c);
			if (char.spaceAfter || char.lineBreakAfter) {
				text.push(' ');
			}
		}
		// OCRed PDFs sometimes result in each line being a separate paragraph
		// while, normal PDFs only need this when paragraph is wrapped to another column
		if (!char.ignorable && char.paragraphBreakAfter) {
			text.push(' ');
		}
	}
	return text.join('').trim();
}

function getRange(chars, anchorOffset, headOffset) {
	let charStart;
	let charEnd;
	if (anchorOffset < headOffset) {
		charStart = anchorOffset;
		charEnd = headOffset - 1;
	}
	else if (anchorOffset > headOffset) {
		charStart = headOffset;
		charEnd = anchorOffset - 1;
	}
	else {
		return { collapsed: true, anchorOffset, headOffset, rects: [], text: '' };
	}

	let rangeChars = chars.slice(charStart, charEnd + 1);
	let text = getTextFromChars(rangeChars);
	let rects = getRectsFromChars(rangeChars);
	rects = rects.map(rect => rect.map(value => parseFloat(value.toFixed(3))));
	return { anchorOffset, headOffset, rects, text };
}

export {
	getClosestOffset,
	getRangeByHighlight
};

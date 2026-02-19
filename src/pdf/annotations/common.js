import { isArrayEqual, Util } from '../../../pdf.js/src/shared/util.js';

function applyTransform(p, m) {
	const xt = p[0] * m[0] + p[1] * m[2] + m[4];
	const yt = p[0] * m[1] + p[1] * m[3] + m[5];
	return [xt, yt];
}

function getBoundingBox(points) {
	let minX = Math.min(...points.map(p => p[0]));
	let maxX = Math.max(...points.map(p => p[0]));
	let minY = Math.min(...points.map(p => p[1]));
	let maxY = Math.max(...points.map(p => p[1]));
	return [minX, minY, maxX, maxY];
}

function getCenter(rect) {
	return [(rect[0] + rect[2]) / 2, (rect[1] + rect[3]) / 2];
}

function getRawPageView(rawPage) {
	const LETTER_SIZE_MEDIABOX = [0, 0, 612, 792];
	let mediaBox = rawPage['/MediaBox'] || LETTER_SIZE_MEDIABOX;
	let cropBox = rawPage['/CropBox'] || mediaBox;

	// From the spec, 6th ed., p.963:
	// "The crop, bleed, trim, and art boxes should not ordinarily
	// extend beyond the boundaries of the media box. If they do, they are
	// effectively reduced to their intersection with the media box."

	let view;
	if (cropBox === mediaBox || isArrayEqual(cropBox, mediaBox)) {
		view = mediaBox;
	}
	else {
		const box = Util.intersect(cropBox, mediaBox);
		if (box && box[2] - box[0] !== 0 && box[3] - box[1] !== 0) {
			view = box;
		}
	}
	return view || mediaBox;
}

/**
 * Convert a raw PDF string or return an empty string
 *
 * @param value
 * @returns {string}
 */
function getString(value) {
	return typeof value === 'string' ? value.slice(1, -1) : '';
}

function isValidNumber(value) {
	return typeof value === 'number' && !isNaN(value);
}

function getAnnotationID(rawAnnot) {
	let str = getString(rawAnnot['/Zotero:Key']);
	if (str) {
		return str;
	}

	str = getString(rawAnnot['/NM']);
	if (str.startsWith('Zotero-')) {
		return str.slice(7);
	}

	return null;
}

function isTransferable(rawAnnot) {
	let id = getAnnotationID(rawAnnot);
	return !!(['/Text', '/Highlight', '/Underline'].includes(rawAnnot['/Subtype'])
		|| ['/Square', '/Ink', '/FreeText'].includes(rawAnnot['/Subtype']) && id);
}

export {
	applyTransform,
	getBoundingBox,
	getCenter,
	getRawPageView,
	getString,
	isValidNumber,
	getAnnotationID,
	isTransferable
};

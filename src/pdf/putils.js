import { DeviceCmykCS, DeviceGrayCS, DeviceRgbCS } from '../../pdf.js/build/lib-legacy/core/colorspace.js';

// The code below is extracted from pdf.js source because there was
// no way to incorporate it directly or some modifications were necessary

/* Copyright 2012 Mozilla Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// Create local singletons matching the new ColorSpace API
const GRAY_CS = new DeviceGrayCS();
const RGB_CS = new DeviceRgbCS();
const CMYK_CS = new DeviceCmykCS();

// Returns a rectangle [x1, y1, x2, y2] corresponding to the
// intersection of rect1 and rect2. If no intersection, returns 'false'
// The rectangle coordinates of rect1, rect2 should be [x1, y1, x2, y2]
function intersect(rect1, rect2) {
	function compare(a, b) {
		return a - b;
	}

	// Order points along the axes
	var orderedX = [rect1[0], rect1[2], rect2[0], rect2[2]].sort(compare),
		orderedY = [rect1[1], rect1[3], rect2[1], rect2[3]].sort(compare),
		result = [];

	rect1 = Util_normalizeRect(rect1);
	rect2 = Util_normalizeRect(rect2);

	// X: first and second points belong to different rectangles?
	if ((orderedX[0] === rect1[0] && orderedX[1] === rect2[0])
		|| (orderedX[0] === rect2[0] && orderedX[1] === rect1[0])) {
		// Intersection must be between second and third points
		result[0] = orderedX[1];
		result[2] = orderedX[2];
	}
	else {
		return false;
	}

	// Y: first and second points belong to different rectangles?
	if ((orderedY[0] === rect1[1] && orderedY[1] === rect2[1])
		|| (orderedY[0] === rect2[1] && orderedY[1] === rect1[1])) {
		// Intersection must be between second and third points
		result[1] = orderedY[1];
		result[3] = orderedY[2];
	}
	else {
		return false;
	}

	return result;
}

/**
 * Set the color and take care of color space conversion.
 * The default value is black, in RGB color space.
 *
 * @public
 * @memberof Annotation
 * @param {Array} color - The color array containing either 0
 *                        (transparent), 1 (grayscale), 3 (RGB) or
 *                        4 (CMYK) elements
 */
function getColorArray(color) {
	const rgbColor = new Uint8ClampedArray(3);
	if (!Array.isArray(color)) {
		return rgbColor;
	}
	let value = null;
	switch (color.length) {
		case 0: // Transparent, which we indicate with a null value
			value = null;
			break;

		case 1: // Convert grayscale to RGB
			GRAY_CS.getRgbItem(color, 0, rgbColor, 0);
			value = rgbColor;
			break;

		case 3: // Convert RGB [0,1] to sRGB bytes
			RGB_CS.getRgbItem(color, 0, rgbColor, 0);
			value = rgbColor;
			break;

		case 4: // Convert CMYK to RGB
			CMYK_CS.getRgbItem(color, 0, rgbColor, 0);
			value = rgbColor;
			break;

		default:
			value = rgbColor;
			break;
	}
	return value;
}

// Normalize rectangle rect=[x1, y1, x2, y2] so that (x1,y1) < (x2,y2)
// For coordinate systems whose origin lies in the bottom-left, this
// means normalization to (BL,TR) ordering. For systems with origin in the
// top-left, this means (TL,BR) ordering.
function normalizeRect(rect) {
	var r = rect.slice(0); // clone rect
	if (rect[0] > rect[2]) {
		r[0] = rect[2];
		r[2] = rect[0];
	}
	if (rect[1] > rect[3]) {
		r[1] = rect[3];
		r[3] = rect[1];
	}
	return r;
}

export {
	intersect,
	getColorArray,
	normalizeRect
};

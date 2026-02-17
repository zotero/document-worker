import { applyTransform, getBoundingBox, getCenter } from './common.js';
import { stringToAsciiOrUTF16BE } from '../../pdf.js/build/lib-legacy/core/core_utils.js';

const NOTE_SIZE = 22;

export async function writeRawAnnotations(structure, annotations, fontEmbedder) {
	for (let annotation of annotations) {
		let pageIndex = annotation.position.pageIndex;
		let page = structure['/Root']['/Pages']['/Kids'][pageIndex];
		if (!page['/Annots']) {
			page['/Annots'] = [];
		}
		let rawAnnotation = await annotationToRaw(annotation, fontEmbedder);
		if (!rawAnnotation) {
			continue;
		}
		page['/Annots'].push(rawAnnotation);
		if (['highlight', 'underline'].includes(annotation.type) && annotation.comment) {
			page['/Annots'].push(addPopup(rawAnnotation));
		}
	}
};

function rectsToQuads(rects) {
	let quads = [];
	for (let rect of rects) {
		quads.push(
			rect[0],
			rect[3],
			rect[2],
			rect[3],
			rect[0],
			rect[1],
			rect[2],
			rect[1]
		);
	}
	return quads;
}

function stringToRaw(text) {
	return stringToAsciiOrUTF16BE(text);
}

function colorToRaw(hex) {
	var result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
	if (result) {
		return [
			parseInt(result[1], 16) / 255,
			parseInt(result[2], 16) / 255,
			parseInt(result[3], 16) / 255
		];
	}
	return null;
}

// D:20190429115637+03'00'
function dateToRaw(str) {
	return 'D:' + (new Date(str)).toISOString().slice(0, 19)
	.replace(/[^0-9]/g, '') + "Z00'00'";
}

function calculateLines(chars, fontSize, maxWidth) {
	let lines = [];
	let currentLine = [];
	let currentLineWidth = 0;

	for (let i = 0; i < chars.length; i++) {
		let char = chars[i];
		let charWidth = char.width / 1000 * fontSize;

		if (char.char === ' ') {
			// Calculate the width of the next word
			let nextSpaceIndex = chars.findIndex((c, idx) => idx > i && c.char === ' ');
			if (nextSpaceIndex === -1) nextSpaceIndex = chars.length;

			let nextWordWidth = chars.slice(i + 1, nextSpaceIndex).reduce((acc, c) => acc + c.width / 1000 * fontSize, 0);

			// Check if adding the next word (excluding the space) will exceed maxWidth
			if (currentLineWidth + nextWordWidth > maxWidth && currentLine.length > 0) {
				lines.push(currentLine);
				currentLine = [];
				currentLineWidth = 0;
				continue; // Skip adding the space character to the new line
			}
		}

		// Add the character to the current line and update the line width
		currentLine.push(char);
		currentLineWidth += charWidth;
	}

	// Add the final line if not empty
	if (currentLine.length > 0) {
		lines.push(currentLine);
	}

	return lines;
}

async function annotationToRaw(annotation, fontEmbedder) {
	annotation = JSON.parse(JSON.stringify(annotation));
	let containerRect;
	if (annotation.position.rects) {
		annotation.position.rects = annotation.position.rects.map(r => r.map(n => Math.round(n * 1000) / 1000));
		containerRect = annotation.position.rects[0].slice();
		for (let rect of annotation.position.rects) {
			containerRect[0] = Math.min(containerRect[0], rect[0]);
			containerRect[1] = Math.min(containerRect[1], rect[1]);
			containerRect[2] = Math.max(containerRect[2], rect[2]);
			containerRect[3] = Math.max(containerRect[3], rect[3]);
		}
	}
	else if (annotation.position.paths) {
		annotation.position.paths = annotation.position.paths.map(r => r.map(n => Math.round(n * 1000) / 1000));
		let x = annotation.position.paths[0][0];
		let y = annotation.position.paths[0][1];
		containerRect = [x, y, x, y];
		for (let path of annotation.position.paths) {
			for (let i = 0; i < path.length - 1; i += 2) {
				let x = path[i];
				let y = path[i + 1];
				containerRect[0] = Math.min(containerRect[0], x);
				containerRect[1] = Math.min(containerRect[1], y);
				containerRect[2] = Math.max(containerRect[2], x);
				containerRect[3] = Math.max(containerRect[3], y);
			}
		}
	}

	if (annotation.type === 'note') {
		let res = {
			'/Type': '/Annot',
			'/Rect': containerRect,
			'/Subtype': '/Text',
			'/M': '(' + dateToRaw(annotation.dateModified) + ')',
			'/T': '(' + stringToRaw(annotation.authorName) + ')',
			'/Contents': '(' + stringToRaw(annotation.comment) + ')',
			'/NM': '(' + 'Zotero-' + annotation.id + ')',
			'/Zotero:Key': '(' + annotation.id + ')',
			'/Zotero:AuthorName': '(' + stringToRaw(annotation.authorName) + ')',
			'/F': 4,
			'/C': colorToRaw(annotation.color),
			'/CA': 1,
			'/Border': [0, 0, 1],
			'/AP': {
				'/N': {
					'/BBox': [0, 0, NOTE_SIZE, NOTE_SIZE],
					'/FormType': 1,
					'/Subtype': '/Form',
					'/Type': '/XObject',
					'stream': colorToRaw(annotation.color).join(' ') + ' rg\n' +
						'21.457 0.488 m 21.457 21.457 l 0.457 21.457 l 0.457 10.516 l 10.5 0.488\n' +
						' l h\n' +
						'21.457 0.488 m f\n' +
						'0 0 0 rg\n' +
						'21.914 0.031 m 10.312 0.031 l 0 10.328 l 0 21.91 l 21.914 21.91 l h\n' +
						'1.559 10.059 m 10.043 1.59 l 10.043 10.059 l h\n' +
						'0.914 21 m 0.914 10.973 l 10.957 10.973 l 10.957 0.945 l 21 0.945 l 21 \n' +
						'21 l h\n' +
						'0.914 21 m f',
					'num': 0,
					'gen': 0
				}
			},
			num: 0,
			gen: 0
		};

		if (annotation.tags.length) {
			res['/Zotero:Tags'] = '(' + stringToRaw(JSON.stringify(annotation.tags)) + ')';
		}

		return res;
	}
	else if (annotation.type === 'text') {
		// Normalize degrees
		let normalizedRotation = ((annotation.position.rotation % 360) + 360) % 360;
		// Integer
		let roundedDegrees = Math.round(normalizedRotation);
		// One decimal place
		let roundedFontSize = Math.round(annotation.position.fontSize * 10) / 10;
		let res = {
			'/Type': '/Annot',
			'/Rect': containerRect,
			'/Subtype': '/FreeText',
			'/M': '(' + dateToRaw(annotation.dateModified) + ')',
			'/T': '(' + stringToRaw(annotation.authorName) + ')',
			'/Contents':  '(' + stringToRaw(annotation.comment) + ')',
			'/NM': '(' + 'Zotero-' + annotation.id + ')',
			'/Zotero:Key': '(' + annotation.id + ')',
			'/Zotero:AuthorName': '(' + stringToRaw(annotation.authorName) + ')',
			'/Zotero:Rect': containerRect,
			'/Zotero:Rotation': roundedDegrees,
			'/Zotero:FontSize': roundedFontSize,
			'/Zotero:Color': colorToRaw(annotation.color),
			'/DA': `(/Helvetica ${roundedFontSize} Tf ${colorToRaw(annotation.color).join(' ')} rg)`,
			'/F': 4,
			'/CA': 1,
			'/Border': [0, 0, 1],
			num: 0,
			gen: 0
		};

		if (annotation.tags.length) {
			res['/Zotero:Tags'] = '(' + stringToRaw(JSON.stringify(annotation.tags)) + ')';
		}

		let fontResource = {};
		let chars = await fontEmbedder.embedChars(annotation.comment, fontResource);
		if (chars) {
			let fontSize = roundedFontSize;
			let lineHeightMultiplier = 1.2;

			let width = containerRect[2] - containerRect[0];
			let height = containerRect[3] - containerRect[1];

			let maxLines;
			let lines;
			let n = 0;
			// Reduce font size to fit the text within the annotation area
			while (n++ < 20) {
				maxLines = Math.floor(height / (fontSize * lineHeightMultiplier));
				lines = calculateLines(chars, fontSize, width);
				if (lines.length > maxLines && fontSize > 4) {
					fontSize -= 0.5;
					continue;
				}
				break;
			}

			let rect = containerRect;
			let rotation = roundedDegrees * Math.PI / 180;
			let cosTheta = Math.cos(rotation);
			let sinTheta = Math.sin(rotation);
			let rotationMatrix = [cosTheta, sinTheta, -sinTheta, cosTheta, 0, 0];
			let [x2, y2] = applyTransform([rect[0], rect[3]], rotationMatrix);
			// Calculate delta values for adjusting rotation origin
			let deltaX = rect[0] - x2;
			let deltaY = rect[3] - y2;
			// Adjust the rotation matrix with delta values
			rotationMatrix[4] = deltaX;
			rotationMatrix[5] = deltaY;

			// Apply transformation to each corner of the rectangle
			let points = [
				applyTransform([rect[0], rect[1]], rotationMatrix),
				applyTransform([rect[0], rect[3]], rotationMatrix),
				applyTransform([rect[2], rect[1]], rotationMatrix),
				applyTransform([rect[2], rect[3]], rotationMatrix)
			];

			// Calculate bounding box of the transformed rectangle
			let transformedRect = getBoundingBox(points);

			// Find centers of the original and transformed rectangles
			let originalCenter = getCenter(rect);
			let transformedCenter = getCenter(transformedRect);

			// Calculate the distances along x and y axes
			deltaX = transformedCenter[0] - originalCenter[0];
			deltaY = transformedCenter[1] - originalCenter[1];

			let matrix = rotationMatrix.slice();
			matrix[4] -= deltaX;
			matrix[5] -= deltaY;

			// Reapply the adjusted matrix to the rectangle corners
			points = [
				applyTransform([rect[0], rect[1]], matrix),
				applyTransform([rect[0], rect[3]], matrix),
				applyTransform([rect[2], rect[3]], matrix),
				applyTransform([rect[2], rect[1]], matrix),
			];

			let bbox = getBoundingBox(points);
			bbox = bbox.map(n => Math.round(n * 1000) / 1000);
			res['/Rect'] = bbox;

			let stream = ['q'];

			// // Set stroke color to green (0 Red, 1 Green, 0 Blue)
			// stream.push('0 1 0 RG');
			// // Construct the path commands
			// stream.push(
			// 	`${points[0][0]} ${points[0][1]} m`,
			// 	`${points[1][0]} ${points[1][1]} l`,
			// 	`${points[2][0]} ${points[2][1]} l`,
			// 	`${points[3][0]} ${points[3][1]} l`,
			// 	'h S'
			// );

			stream.push('BT');
			stream.push(`${colorToRaw(annotation.color).join(' ')} rg`);

			// The reference point for rotation (bottom-left corner of the rectangle)
			let refX = rect[0];
			let refY = rect[3];

			for (let i = 0; i < lines.length; i++) {
				let lineY = refY - (i + 1) * fontSize * lineHeightMultiplier;

				// Rotating around the reference point
				let transformedX = refX - (lineY - refY) * sinTheta - deltaX;
				let transformedY = refY + (lineY - refY) * cosTheta - deltaY;

				let matrix = rotationMatrix.slice();
				matrix[4] = transformedX.toFixed(3);
				matrix[5] = transformedY.toFixed(3);

				stream.push(`${matrix.join(' ')} Tm`);

				let chars = lines[i];
				let currentFont = '';
				let textBuffer = '';

				for (let char of chars) {
					if (char.resKey !== currentFont) {
						// If the font changes, render the accumulated text and start a new buffer
						if (textBuffer) {
							stream.push(`(${textBuffer}) Tj`);
							textBuffer = '';
						}
						currentFont = char.resKey;
						stream.push(`/${currentFont} ${fontSize} Tf`);
					}
					textBuffer += char.utf16;
				}

				// Render any remaining text in the buffer
				if (textBuffer) {
					stream.push(`(${textBuffer}) Tj`);
				}
			}

			stream.push('ET', 'Q');
			stream = stream.join(' ');

			res['/AP'] = {
				'/N': {
					'/BBox': bbox,
					'/FormType': 1,
					'/Subtype': '/Form',
					'/Type': '/XObject',
					'/Resources': {
						'/Font': fontResource,
						'/ProcSet': ['/PDF', '/Text']
					},
					'stream': stream,
					'num': 0,
					'gen': 0
				}
			};
		}
		return res;
	}
	else if (annotation.type === 'highlight') {
		let p = '';
		for (let rect of annotation.position.rects) {
			p += rect[0] + ' ' + rect[1] + ' m\n';
			p += rect[2] + ' ' + rect[1] + ' l\n';
			p += rect[2] + ' ' + rect[3] + ' l\n';
			p += rect[0] + ' ' + rect[3] + ' l\nh\n';
		}

		let res = {
			'/Type': '/Annot',
			'/Rect': containerRect,
			'/Subtype': '/Highlight',
			'/QuadPoints': rectsToQuads(annotation.position.rects),
			'/M': '(' + dateToRaw(annotation.dateModified) + ')',
			'/T': '(' + stringToRaw(annotation.authorName) + ')',
			'/Contents': '(' + stringToRaw(annotation.comment) + ')',
			'/NM': '(' + 'Zotero-' + annotation.id + ')',
			'/Zotero:Key': '(' + annotation.id + ')',
			'/Zotero:AuthorName': '(' + stringToRaw(annotation.authorName) + ')',
			'/F': 4,
			'/C': colorToRaw(annotation.color),
			'/AP': {
				'/N': {
					'/BBox': containerRect,
					'/FormType': 1,
					'/Resources': {
						'/ExtGState': {
							'/G0': {
								'/BM': '/Multiply',
								'/CA': 1,
								'/ca': 1,
								num: 0,
								gen: 0
							},
							num: 0,
							gen: 0
						}, num: 0, gen: 0
					},
					'/Subtype': '/Form',
					'/Type': '/XObject',
					stream: '/G0 gs\n' + colorToRaw(annotation.color).join(' ') + ' rg\n' + p + 'f\n',
					num: 0,
					gen: 0
				}
			},
			num: 0,
			gen: 0
		};

		if (!annotation.comment) {
			delete res['/Contents'];
		}

		if (annotation.tags.length) {
			res['/Zotero:Tags'] = '(' + stringToRaw(JSON.stringify(annotation.tags)) + ')';
		}

		return res;
	}
	else if (annotation.type === 'underline') {
		let p = '';
		for (let rect of annotation.position.rects) {
			p += rect[0] + ' ' + rect[1] + ' m\n';
			p += rect[2] + ' ' + rect[1] + ' l\n';
			p += rect[2] + ' ' + (rect[1] + 3) + ' l\n';
			p += rect[0] + ' ' + (rect[1] + 3) + ' l\nh\n';
		}

		let res = {
			'/Type': '/Annot',
			'/Rect': containerRect,
			'/Subtype': '/Underline',
			'/QuadPoints': rectsToQuads(annotation.position.rects),
			'/M': '(' + dateToRaw(annotation.dateModified) + ')',
			'/T': '(' + stringToRaw(annotation.authorName) + ')',
			'/Contents': '(' + stringToRaw(annotation.comment) + ')',
			'/NM': '(' + 'Zotero-' + annotation.id + ')',
			'/Zotero:Key': '(' + annotation.id + ')',
			'/Zotero:AuthorName': '(' + stringToRaw(annotation.authorName) + ')',
			'/F': 4,
			'/C': colorToRaw(annotation.color),
			'/AP': {
				'/N': {
					'/BBox': containerRect,
					'/FormType': 1,
					'/Resources': {
						'/ExtGState': {
							'/G0': {
								'/BM': '/Multiply',
								'/CA': 1,
								'/ca': 1,
								num: 0,
								gen: 0
							},
							num: 0,
							gen: 0
						}, num: 0, gen: 0
					},
					'/Subtype': '/Form',
					'/Type': '/XObject',
					stream: '/G0 gs\n' + colorToRaw(annotation.color).join(' ') + ' rg\n' + p + 'f\n',
					num: 0,
					gen: 0
				}
			},
			num: 0,
			gen: 0
		};

		if (!annotation.comment) {
			delete res['/Contents'];
		}

		if (annotation.tags.length) {
			res['/Zotero:Tags'] = '(' + stringToRaw(JSON.stringify(annotation.tags)) + ')';
		}

		return res;
	}
	else if (annotation.type === 'image') {
		let p = [
			containerRect[0],
			containerRect[1],
			containerRect[2] - containerRect[0],
			containerRect[3] - containerRect[1]
		].join(' ');

		let res = {
			'/Type': '/Annot',
			'/Subtype': '/Square',
			'/Rect': containerRect,
			'/BS': {
				'/W': 2
			},
			'/C': colorToRaw(annotation.color),
			'/M': '(' + dateToRaw(annotation.dateModified) + ')',
			'/T': '(' + stringToRaw(annotation.authorName) + ')',
			'/Contents': '(' + stringToRaw(annotation.comment) + ')',
			'/NM': '(' + 'Zotero-' + annotation.id + ')',
			'/Zotero:Key': '(' + annotation.id + ')',
			'/Zotero:AuthorName': '(' + stringToRaw(annotation.authorName) + ')',
			'/F': 4,
			'/AP': {
				'/N': {
					'/BBox': containerRect,
					'/FormType': 1,
					'/Resources': {
						'/ExtGState': {
							'/G0': { '/CA': 1, '/ca': 1, num: 0, gen: 0 },
							num: 0,
							gen: 0
						}, num: 0, gen: 0
					},
					'/Subtype': '/Form',
					'/Type': '/XObject',
					stream: '/G0 gs\n' + colorToRaw(annotation.color).join(' ') + ' RG\n0 0 0 0 k\n2 w\n[] 0 d\n' + p + ' re\nS\n',
					num: 0,
					gen: 0
				}
			},
			num: 0,
			gen: 0
		};

		if (annotation.tags.length) {
			res['/Zotero:Tags'] = '(' + stringToRaw(JSON.stringify(annotation.tags)) + ')';
		}

		return res;
	}
	else if (annotation.type === 'ink') {
		let p = '';
		for (let path of annotation.position.paths) {
			for (let i = 0; i < path.length - 1; i += 2) {
				let x = path[i];
				let y = path[i + 1];

				if (i === 0) {
					p += `${x} ${y} m\n`;
				}
				else {
					p += `${x} ${y} l\n`;
				}
			}
		}

		let { width } = annotation.position;
		containerRect[0] -= width;
		containerRect[1] -= width;
		containerRect[2] += width;
		containerRect[3] += width;

		let res = {
			'/Type': '/Annot',
			'/Subtype': '/Ink',
			'/Rect': containerRect,
			'/BS': {
				'/S': '/N',
				'/Type': '/Border',
				'/W': annotation.position.width
			},
			'/F': 4,
			'/InkList': annotation.position.paths,
			'/C': colorToRaw(annotation.color),
			'/CA': 1,
			'/M': '(' + dateToRaw(annotation.dateModified) + ')',
			'/T': '(' + stringToRaw(annotation.authorName) + ')',
			'/NM': '(' + 'Zotero-' + annotation.id + ')',
			'/Zotero:Key': '(' + annotation.id + ')',
			'/Zotero:AuthorName': '(' + stringToRaw(annotation.authorName) + ')',
			'/AP': {
				'/N': {
					'/BBox': containerRect,
					'/FormType': 1,
					'/Resources': {
						'/ExtGState': {
							'/G0': {
								'/CA': 1,
								'/ca': 1,
								'/LC': 1,
								'/LJ': 1,
								num: 0,
								gen: 0
							},
							num: 0,
							gen: 0
						}, num: 0, gen: 0
					},
					'/Subtype': '/Form',
					'/Type': '/XObject',
					stream: '/G0 gs\n' + colorToRaw(annotation.color).join(' ') + ' RG\n' + annotation.position.width + ' w\n' + p + 'S\n',
					num: 0,
					gen: 0
				}
			},
			num: 0,
			gen: 0
		};

		if (annotation.tags.length) {
			res['/Zotero:Tags'] = '(' + stringToRaw(JSON.stringify(annotation.tags)) + ')';
		}

		return res;
	}
}

function addPopup(annotation) {
	let popup = {
		'/Type': '/Annot',
		'/Subtype': '/Popup',
		'/Parent': annotation,
		'/Rect': annotation['/Rect'],
		num: 0,
		gen: 0
	};

	annotation['/Popup'] = popup;
	return popup;
}

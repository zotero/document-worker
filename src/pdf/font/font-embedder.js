import { TTFFont } from './ttffont.js';
import { fonts } from './fonts.js';

// This function can be used to generate character intervals for fonts.js
function getUnicodeCharacterIntervals(font) {
	let unicodeCmap = font.metadata.cmap.unicode.codeMap;
	let intervals = [];
	let start = null;
	let end = null;

	// Sort the keys (unicode character codes) in ascending order
	let sortedKeys = Object.keys(unicodeCmap).map(Number).sort((a, b) => a - b);

	for (let i = 0; i < sortedKeys.length; i++) {
		let current = sortedKeys[i];

		// If start is null, we are beginning a new interval
		if (start === null) {
			start = current;
			end = current;
		}
		else {
			// If the current code is adjacent to the end, extend the interval
			if (current === end + 1) {
				end = current;
			}
			else {
				// Otherwise, close the current interval and start a new one
				intervals.push([start, end]);
				start = current;
				end = current;
			}
		}
	}

	// Add the last interval if it exists
	if (start !== null) {
		intervals.push([start, end]);
	}

	return intervals;
}

function toUnicodeCmap(map) {
	var code, codes, range, unicode, unicodeMap, _i, _len;
	unicodeMap =
		"/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo <<\n  /Registry (Adobe)\n  /Ordering (UCS)\n  /Supplement 0\n>> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000><ffff>\nendcodespacerange";
	codes = Object.keys(map).sort(function (a, b) {
		return a - b;
	});

	range = [];
	for (_i = 0, _len = codes.length; _i < _len; _i++) {
		code = codes[_i];
		if (range.length >= 100) {
			unicodeMap +=
				"\n" +
				range.length +
				" beginbfchar\n" +
				range.join("\n") +
				"\nendbfchar";
			range = [];
		}

		if (
			map[code] !== undefined &&
			map[code] !== null &&
			typeof map[code].toString === "function"
		) {
			unicode = ("0000" + map[code].toString(16)).slice(-4);
			code = ("0000" + (+code).toString(16)).slice(-4);
			range.push("<" + code + "><" + unicode + ">");
		}
	}

	if (range.length) {
		unicodeMap +=
			"\n" +
			range.length +
			" beginbfchar\n" +
			range.join("\n") +
			"\nendbfchar\n";
	}
	unicodeMap +=
		"endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend";
	return unicodeMap;
}

function escapeChar(char) {
	switch (char) {
		case '\n':
			return '\\n';
		case '\r':
			return '\\r';
		case '\t':
			return '\\t';
		case '\b':
			return '\\b';
		case '\f':
			return '\\f';
		case '(':
			return '\\(';
		case ')':
			return '\\)';
		case '\\':
			return '\\\\';
	}
	return char;
}

export class FontEmbedder {
	constructor({ standardFontProvider }) {
		this._fonts = [];
		this._standardFontProvider = standardFontProvider;
	}

	getFontByCharacter(char) {
		for (let font of fonts) {
			let { unicodeIntervals } = font;
			let charCode = char.charCodeAt(0);
			for (let i = 0; i < unicodeIntervals.length; i++) {
				let [start, end] = unicodeIntervals[i];
				if (charCode >= start && charCode <= end) {
					return font;
				}
			}
		}
	}

	async embedChars(chars, fontResource) {
		let chars2 = [];
		let resultChars = [];
		for (let char of chars) {
			let font = this.getFontByCharacter(char);
			if (!font) {
				return;
			}
			chars2.push({ char, font });
		}
		for (let char2 of chars2) {
			let { font, char } = char2;
			if (!this._fonts.includes(font)) {
				this._fonts.push(font);
				font.charsUsed = [];
				font.ref = {};
				font.ttfFont = TTFFont.open(await this._standardFontProvider(font.fileName));
			}
			if (!font.charsUsed.includes(char)) {
				font.charsUsed.push(char);
			}

			let resKeys = Object.keys(fontResource);
			let resKey = resKeys.find(x => fontResource[x] === font.ref);
			if (!resKey) {
				resKey = '/F' + (new Array(100000)).findIndex((v, i) => !fontResource['/F' + i]);
				fontResource[resKey] = font.ref;
			}

			let key = char.charCodeAt(0);
			key = parseInt(key);
			let charCode = font.ttfFont.characterToGlyph(key);

			let utf16 = '';
			let hex = ('0000' + charCode.toString(16)).slice(-4);
			utf16 += escapeChar(String.fromCharCode(parseInt(hex[0] + hex[1], 16)));
			utf16 += escapeChar(String.fromCharCode(parseInt(hex[2] + hex[3], 16)));

			let resultChar = {
				char: char2.char,
				charCode,
				utf16,
				resKey,
				width: Math.round(font.ttfFont.widthOfGlyph(charCode))
			};

			resultChars.push(resultChar);
		}

		let fonts = Array.from(new Set(chars2.map(x => x.font)));
		for (let font of fonts) {
			this._embedFontData(font);
		}

		return resultChars;
	}

	_embedFontData(font) {
		let { fontName, ttfFont, ref } = font;

		var widths = [];
		let toUnicode = {};
		let glyphIDsUsed = [];
		let unicodeCmap = ttfFont.cmap.unicode.codeMap;

		for (let key in unicodeCmap) {
			key = parseInt(key);
			let t = ttfFont.characterToGlyph(key);
			glyphIDsUsed.push(t);
			toUnicode[t] = key;
			if (widths.indexOf(t) == -1) {
				widths.push(t);
				widths.push([parseInt(ttfFont.widthOfGlyph(t), 10)]);
			}
		}

		let fontTableBytes = ttfFont.subset.encode(glyphIDsUsed, 1);
		fontTableBytes = new Uint8Array(fontTableBytes);

		let cmapData = toUnicodeCmap(toUnicode);

		let fontData = {
			'/Type': '/Font',
			'/Subtype': '/Type0',
			'/ToUnicode': {
				'stream': cmapData,
				'/Length1': cmapData.length,
				num: 0,
				gen: 0
			},
			'/BaseFont': fontName,
			'/Encoding': '/Identity-H',
			'/DescendantFonts': [
				{
					'/Type': '/Font',
					'/BaseFont': fontName,
					'/FontDescriptor': {
						'/Type': '/FontDescriptor',
						'/FontName': fontName,
						'/FontFile2': {
							'stream': fontTableBytes,
							'/Length1': fontTableBytes.length,
							num: 0,
							gen: 0

						},
						'/FontBBox': ttfFont.bbox,
						'/Flags': ttfFont.flags,
						'/StemV': ttfFont.stemV,
						'/ItalicAngle': ttfFont.italicAngle,
						'/Ascent': ttfFont.ascender,
						'/Descent': ttfFont.decender,
						'/CapHeight': ttfFont.capHeight,
						num: 0,
						gen: 0
					},
					'/W': widths,
					'/CIDToGIDMap': '/Identity',
					'/DW': 1000,
					'/Subtype': '/CIDFontType2',
					'/CIDSystemInfo': {
						'/Supplement': 0,
						'/Registry': '(Adobe)',
						'/Ordering': '(Identity-H)'
					},
					num: 0,
					gen: 0
				}
			],
			num: 0,
			gen: 0
		};

		Object.assign(ref, fontData);
	}
}

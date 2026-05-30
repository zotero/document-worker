// Hash functions for first-3-word features
const HASH_MOD = 32768; // produces 0..32767
const LINE_TEXT_FEATURE_CACHE_LIMIT = 50000;
const MAX_LAYOUT_OBJECTS_PER_PAGE = 256;
const lineTextFeatureCache = new Map();
export const BLOCK_SEG_LINE_FEATURE_DIM = 22;
export const READING_ORDER_Y_BACKTRACK_TO_PREV_INDEX = 13;
export const CORRECT_Y_GAP_TO_PREV_INDEX = 21;

function fnv1a32(str) {
	let h = 0x811c9dc5;
	for (let i = 0; i < str.length; i++) {
		h ^= str.charCodeAt(i);
		h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
	}
	return h >>> 0;
}

function hashToBucket(str) {
	return fnv1a32(str) % HASH_MOD;
}

const FIRST3_TOKEN_RE = /[\p{L}]+|\d+|[.:]/gu;

function first3HashesFigureStyle(text) {
	const out = [0, 0, 0];
	if (!text) {
		return { hashes: out };
	}

	const s = text.normalize("NFKC");
	FIRST3_TOKEN_RE.lastIndex = 0;
	let match;
	let index = 0;
	while (index < 3 && (match = FIRST3_TOKEN_RE.exec(s)) !== null) {
		const t = match[0];
		const x = t.toLowerCase();

		// Normalize all numbers (years, figure indices, ref numbers)
		let token = /^\d+$/.test(x) ? "<NUM>" : x;

		// Keep selected punctuation tokens as-is
		// (Everything matched by the punctuation class is 1 char, so this is safe.)
		if (x.length === 1 && /[()[\]{}.,:;!?'"""''\-–—=+×*/<>≤≥#%@&]/u.test(x)) {
			token = x;
		}
		out[index++] = hashToBucket(token);
	}
	return { hashes: out };
}

export function getPageLines(pdfData) {
	// Local utilities (not shared)
	function round(value) {
		return Math.round(value * 1000) / 1000;
	}
	function median(values) {
		if (!Array.isArray(values) || values.length === 0) return 0;
		const arr = values.slice().sort((a, b) => a - b);
		const mid = Math.floor(arr.length / 2);
		return arr.length % 2 === 0 ? (arr[mid - 1] + arr[mid]) / 2 : arr[mid];
	}
	function getMedianCharHeight(line) {
		const chars = Array.isArray(line?.chars) ? line.chars : [];
		const heights = [];
		for (const ch of chars) {
			if (ch && ch.rect && Array.isArray(ch.rect) && ch.rect.length === 4) {
				const h = ch.rect[3] - ch.rect[1];
				if (Number.isFinite(h) && h > 0) heights.push(h);
			} else if (ch && Number.isFinite(ch.fontSize) && ch.fontSize > 0) {
				heights.push(ch.fontSize);
			}
		}
		if (heights.length > 0) return median(heights);
		if (line && line.rect && Array.isArray(line.rect) && line.rect.length === 4) {
			const lh = line.rect[3] - line.rect[1];
			if (Number.isFinite(lh) && lh > 0) return lh;
		}
		return 0;
	}

	// Reduced boundary fallback classes (dense 0..4)
	// These provide compact categorical codes for character classes used in line start/end features.
	const REDUCED_BOUNDARY = {
		LetterUpper: 0,
		LetterLower: 1,
		Digit: 2,
		OtherPunct: 3,
		Other: 4
	};

	// Fallback classifier for a single character (used by both start/end)
	function getReducedBoundaryCode(ch) {
		if (!ch) return REDUCED_BOUNDARY.Other;
		if (/\p{Alphabetic}/u.test(ch)) {
			return /\p{Uppercase}/u.test(ch) ? REDUCED_BOUNDARY.LetterUpper : REDUCED_BOUNDARY.LetterLower;
		}
		if (/\p{Nd}/u.test(ch)) return REDUCED_BOUNDARY.Digit;
		if (/\p{P}/u.test(ch)) return REDUCED_BOUNDARY.OtherPunct;
		return REDUCED_BOUNDARY.Other;
	}

	// Start classes: fallback 0..4, specials 5+ (contiguous)
	// Fallback: 0 Upper, 1 Lower, 2 Digit, 3 OtherPunct, 4 Other
	// Specials: 5 Bullet, 6 NumberedStart, 7 RomanStart, 8 LetteredStart, 9 CaptionStart, 10 Dash, 11 QuoteOrOpenStart
	const LINE_START_CLASS = {
		Bullet: 5,
		NumberedStart: 6,
		RomanStart: 7,
		LetteredStart: 8,
		CaptionStart: 9,
		Dash: 10,
		QuoteOrOpenStart: 11
	};
	function isCaptionStart(text) {
		if (!text || text[0].toUpperCase() !== text[0]) return false;
		const toks = text.toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, '').split(' ');
		return toks.length >= 2
			&& toks[0].length >= 3
			&& (/^\p{N}+$/u.test(toks[1]) || /^[ivxlcdm]+$/iu.test(toks[1]));
	}
	// Returns integer in [0..11]
	function lineStartClass(text) {
		const t = String(text || '');
		if (!t) return REDUCED_BOUNDARY.Other;

		// Bullets (exclude dashes; common bullet-like glyphs and simple symbols)
		// • · ‣ ◦ ● ○ ▪ ▫ ■ □ ◆ ◇ ▶ ► ❖ and simple * +
		if (/^[•·‣◦●○▪▫■□◆◇▶►❖*+]/u.test(t)) return LINE_START_CLASS.Bullet;

		// Numbered: 1.  1)  (1)  1-  1.2.3  (1.2)
		const isNumbered = /^\(?\p{Nd}+(?:[.\u2024]\p{Nd}+)*\)?[.)\p{Dash}:]/u.test(t);

		// Roman (letters only, not strict numeral validation): i.  IV)  (x)  x–
		const isRoman = /^\(?[ivxlcdm]+\)?[.)\p{Dash}:]/iu.test(t);

		// Lettered (any single Unicode letter): a.  A)  (β)  б–
		const isLettered = /^\(?\p{L}\)?[.)\p{Dash}:]/u.test(t);

		// Distinct ordinal classes
		if (isNumbered) return LINE_START_CLASS.NumberedStart;
		if (isRoman) return LINE_START_CLASS.RomanStart;
		if (isLettered) return LINE_START_CLASS.LetteredStart;

		// Dash-led line (any Unicode dash)
		if (/^\p{Dash}/u.test(t)) return LINE_START_CLASS.Dash;

		// Opening quotes OR opening punctuation (merged)
		if (/^(?:\p{Quotation_Mark}|\p{Ps})/u.test(t)) return LINE_START_CLASS.QuoteOrOpenStart;

		// Fallback to reduced boundary class of FIRST char (0..4)
		return getReducedBoundaryCode(t[0]);
	}

	// End classes: fallback 0..4, specials 5+ (contiguous)
	// Fallback: 0 Upper, 1 Lower, 2 Digit, 3 OtherPunct, 4 Other
	// Specials: 5 SentencePunct (includes ellipsis), 6 Hyphen, 7 ClosePunctOrQuote
	const LINE_END_CLASS = {
		SentencePunct: 5,
		Hyphen: 6,
		ClosePunctOrQuote: 7
	};

	// Returns integer in [0..7]
	function lineEndClass(text) {
		const t = String(text || '');
		if (!t) return REDUCED_BOUNDARY.Other;
		const lastIdx = t.length - 1;

		// Sentence-ending punctuation (includes ellipsis: … U+2026, ‥ U+2025, or 3+ periods)
		if (/(?:[\u2026\u2025]|\.{3,}|[.!?;:])$/.test(t)) return LINE_END_CLASS.SentencePunct;

		// Hyphenation/dash at end (any Unicode dash)
		if (/\p{Dash}$/.test(t)) return LINE_END_CLASS.Hyphen;

		// Closing punctuation or quotes: any Pe or any quotation mark
		if (/[\p{Pe}\p{Quotation_Mark}]$/u.test(t)) return LINE_END_CLASS.ClosePunctOrQuote;

		// Fallback to reduced boundary class of LAST char (0..4)
		return getReducedBoundaryCode(t[lastIdx]);
	}

	function getUppercasePercentage(text) {
		if (!text || typeof text !== 'string' || text.length === 0) return 0;
		let asciiUppercaseCount = 0;
		for (let i = 0; i < text.length; i++) {
			const code = text.charCodeAt(i);
			if (code > 0x7f) {
				let uppercaseCount = 0;
				for (const char of text) {
					if (char === char.toUpperCase()) uppercaseCount++;
				}
				return Number((uppercaseCount / text.length).toFixed(2));
			}
			if (code < 97 || code > 122) {
				asciiUppercaseCount++;
			}
		}
		return Number((asciiUppercaseCount / text.length).toFixed(2));
	}
	function getFontMatchRatioWithPrev(currentLine, prevLine) {
		if (!currentLine || !prevLine) return 0;
		const currData = getLineFontData(currentLine);
		const prevData = getLineFontData(prevLine);
		if (!currData.keys.length || !prevData.keys.length) return 0;
		let prevSet = prevData.set;
		if (!prevSet) {
			prevSet = new Set(prevData.keys);
			prevData.set = prevSet;
		}
		let matchCount = 0;
		for (const key of currData.keys) {
			if (prevSet.has(key)) matchCount++;
		}
		return round(matchCount / currData.keys.length);
	}
	function getAvgFontSize(line) {
		const chars = Array.isArray(line?.chars) ? line.chars : [];
		const sizes = chars
		.map(ch => (ch && Number.isFinite(ch.fontSize) ? ch.fontSize : null))
		 .filter(v => v !== null);
		if (!sizes.length) return 0;
		return sizes.reduce((a, b) => a + b, 0) / sizes.length;
	}
	// Detect whether a font name suggests bold weight
	function isBoldFontName(fontName) {
		if (!fontName || typeof fontName !== 'string') return false;
		const lower = fontName.toLowerCase();
		// Quick path for common concatenations like BoldItalic
		if (lower.includes('bold')) return true;
		// Tokenize to detect abbreviations or weight words
		const tokens = lower.split(/[^a-z]+/).filter(Boolean);
		const tokenSet = new Set(tokens);
		// Common bold-ish indicators in font naming
		const indicators = [
			'bold', 'semibold', 'demibold', 'extrabold', 'ultrabold',
			'black', 'heavy', 'bd' // 'bd' occurs in some families as "Bold"
		];
		for (const ind of indicators) {
			if (tokenSet.has(ind)) return true;
		}
		return false;
	}
	function isItalicFontName(fontName) {
		if (!fontName || typeof fontName !== 'string') {
			return false;
		}
		const lower = fontName.toLowerCase();
		// Quick path for common concatenations like BoldItalic
		if (lower.includes('italic')) {
			return true;
		}
		// Tokenize to detect abbreviations or weight words
		const tokens = lower.split(/[^a-z]+/).filter(Boolean);
		const tokenSet = new Set(tokens);
		// Common italic-ish indicators in font naming
		const indicators = [
			'italic', 'oblique', 'it', 'slanted', 'inclined',
			'kursiv', // "kursiv" occurs in some fonts as "Italic"
		];
		for (const ind of indicators) {
			if (tokenSet.has(ind)) {
				return true;
			}
		}
		return false;
	}
	const fontNameStyleCache = new Map();
	function isBoldOrItalicFontName(fontName) {
		if (fontNameStyleCache.has(fontName)) {
			return fontNameStyleCache.get(fontName);
		}
		const value = isBoldFontName(fontName) || isItalicFontName(fontName);
		fontNameStyleCache.set(fontName, value);
		return value;
	}
	const lineFontDataCache = new WeakMap();
	function getLineFontData(line) {
		let data = lineFontDataCache.get(line);
		if (data) {
			return data;
		}
		const chars = Array.isArray(line?.chars) ? line.chars : [];
		const keys = [];
		for (const ch of chars) {
			if (ch && ch.fontName != null && ch.fontSize != null) {
				keys.push(`${ch.fontName}::${ch.fontSize}`);
			}
		}
		data = { keys, set: null };
		lineFontDataCache.set(line, data);
		return data;
	}
	function getBoldCharFraction(line) {
		const chars = Array.isArray(line?.chars) ? line.chars : [];
		if (!chars.length) return 0;
		let total = 0;
		let bold = 0;
		for (const ch of chars) {
			if (!ch) continue;
			total++;
			if (isBoldOrItalicFontName(ch.fontName)) bold++;
		}
		if (total === 0) return 0;
		// fraction [0..1] of characters whose font is bold-ish by font name
		return Math.round((bold / total) * 1000) / 1000;
	}

	const lines = Array.isArray(pdfData?.lines) ? pdfData.lines : [];
	const vp = pdfData.viewport;
	if (!vp || !Array.isArray(vp) || vp.length !== 4) return { lines: [] };

	const w1 = vp[2] - vp[0];
	const h1 = vp[3] - vp[1];
	const clamped01 = (v) => Math.round(Math.min(1, Math.max(0, v)) * 1000) / 1000;

	// NEW: object support
	function isObjectLine(line) {
		return line && line.type === 'object';
	}
	function safeRect(line) {
		const r = line?.rect;
		return Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) ? r : [0, 0, 0, 0];
	}
	// subtype: lines => 0 always. objects => 0/1/2.
	function getSubtypeCode(line) {
		if (!isObjectLine(line)) return 0;

		if (line.subtype === 'xobject') return 1;

		// If you have another known object subtype, map it here:
		if (line.subtype === 'image') return 2;
		if (line.subtype === 'path') return 3;

		return 0;
	}

	const outLines = [];
	let previousTextNormalizedLine = null;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];

		const obj = isObjectLine(line);
		const r = safeRect(line);

		const x1 = r[0] / w1;
		const y1 = (vp[3] - r[3]) / h1;
		const x2 = r[2] / w1;
		const y2 = (vp[3] - r[1]) / h1;
		const normalizedLine = [clamped01(x1), clamped01(y1), clamped01(x2), clamped01(y2)];

		const lineWidth = Math.max(0, r[2] - r[0]);
		const lineHeight = Math.max(0, r[3] - r[1]);

		// Objects don't have chars; treat text-dependent features as 0
		const textWidth = obj
			? 0
			: (Array.isArray(line.words) ? line.words : []).reduce(
				(acc, w) => acc + (w.rect[2] - w.rect[0]) * (w.rect[3] - w.rect[1]),
				0
			);

		const prevLine = i > 0 ? lines[i - 1] : null;
		const fontShareWithPrev = obj ? 0 : getFontMatchRatioWithPrev(line, prevLine);

		let deltaXToPrev = 0;
		if (prevLine) {
			const pr = safeRect(prevLine);
			const px1 = clamped01(pr[0] / w1);
			deltaXToPrev = round(px1 - x1);
		}
		let correctVerticalGapToPrev = 0;
		let readingOrderYBacktrackToPrev = 0;
		if (!obj && previousTextNormalizedLine) {
			const prevY1 = previousTextNormalizedLine[1];
			const prevY2 = previousTextNormalizedLine[3];
			const currY1 = normalizedLine[1];
			const currY2 = normalizedLine[3];
			const denom = Math.max(prevY2 - prevY1, currY2 - currY1, 1e-6);
			correctVerticalGapToPrev = round(Math.max(0, currY1 - prevY2) / denom);
			readingOrderYBacktrackToPrev = round(Math.max(0, prevY1 - currY2) / denom);
		}

		const lineText = obj ? '' : (line.text || '');

		let textFeatures = null;
		if (!obj) {
			textFeatures = lineTextFeatureCache.get(lineText);
			if (!textFeatures) {
				textFeatures = {
					startClass: lineStartClass(lineText),
					endClass: lineEndClass(lineText),
					uppercasePct: round(getUppercasePercentage(lineText)),
					captionFlag: isCaptionStart(lineText) ? 1 : 0,
					f3: first3HashesFigureStyle(lineText),
				};
				if (lineTextFeatureCache.size >= LINE_TEXT_FEATURE_CACHE_LIMIT) {
					lineTextFeatureCache.clear();
				}
				lineTextFeatureCache.set(lineText, textFeatures);
			}
		}
		const startClass = obj ? 0 : textFeatures.startClass;
		const endClass = obj ? 0 : textFeatures.endClass;
		const uppercasePct = obj ? 0 : textFeatures.uppercasePct;
		const captionFlag = obj ? 0 : textFeatures.captionFlag;
		const boldFrac = obj ? 0 : getBoldCharFraction(line);

		let f3 = obj ? { hashes: [0, 0, 0] } : textFeatures.f3;
		const widthNorm = round(lineWidth / w1);

		const vec = [
			...normalizedLine,
			widthNorm,
			round(lineHeight / h1),
			round((lineWidth * lineHeight) / (w1 * h1)),
			round(textWidth / ((lineWidth * lineHeight) || 1)),
			uppercasePct,
			startClass,
			endClass,
			fontShareWithPrev,
			deltaXToPrev,
			readingOrderYBacktrackToPrev,
			captionFlag,
			boldFrac,
			obj ? 1 : 0,         // lineType: 0=line, 1=object
			getSubtypeCode(line), // subtype: lines always 0; objects 0/1/2
			f3.hashes[0],
			f3.hashes[1],
			f3.hashes[2],
			correctVerticalGapToPrev
		];

		outLines.push(vec);
		if (!obj) {
			previousTextNormalizedLine = normalizedLine;
		}
	}

	return { lines: outLines };
}

export function getLines(chars) {
  const lines = [];

  // Accumulators for current word/line
  let textParts = [];
  let wordRect = null; // [x1, y1, x2, y2]
  let lineRect = null; // [x1, y1, x2, y2]
  let wordChars = [];
  let lineChars = [];
  let words = [];
  // Track offsets into the original chars array (inclusive)
  let wordStartOffset = null;
  let lineStartOffset = null;
  let lastCharOffset = null;
  let lineSeqMin = null;
  let lineSeqMax = null;

  const roundRect = (rect) => ([
    Math.round(rect[0] * 100) / 100,
    Math.round(rect[1] * 100) / 100,
    Math.round(rect[2] * 100) / 100,
    Math.round(rect[3] * 100) / 100,
  ]);

  const resetWordState = () => {
    textParts = [];
    wordRect = null;
    wordChars = [];
    wordStartOffset = null;
  };

  const resetLineState = () => {
    lineRect = null;
    lineChars = [];
    words = [];
    lineStartOffset = null;
    lineSeqMin = null;
    lineSeqMax = null;
    resetWordState();
  };

  const pushWord = () => {
    if (!textParts.length || !wordRect) return;

    const word = {
      text: textParts.join(''),
      rect: roundRect(wordRect),
      chars: wordChars.slice(),
      startOffset: wordStartOffset,
      endOffset: lastCharOffset,
    };

    words.push(word);
    resetWordState();
  };

  const pushLine = () => {
    if (!words.length || !lineRect) {
      resetLineState();
      return;
    }

    const line = {
      id: lines.length,
      text: words.map(w => w.text).join(' '),
      rect: roundRect(lineRect),
      words: words.slice(),
      chars: lineChars.slice(),
      startOffset: lineStartOffset,
      endOffset: lastCharOffset,
      ...(lineSeqMin !== null ? { seq: lineSeqMin, seqStart: lineSeqMin, seqEnd: lineSeqMax ?? lineSeqMin } : {}),
    };

    lines.push(line);
    resetLineState();
  };

  for (let idx = 0; idx < chars.length; idx++) {
    const char = chars[idx];
    if (!char) continue;

    // Mark starts for word/line when the first char of each is seen
    if (wordStartOffset === null) wordStartOffset = idx;
    if (lineStartOffset === null) lineStartOffset = idx;
    lastCharOffset = idx;
    if (Number.isFinite(char.seq)) {
      lineSeqMin = lineSeqMin === null ? char.seq : Math.min(lineSeqMin, char.seq);
      lineSeqMax = lineSeqMax === null ? char.seq : Math.max(lineSeqMax, char.seq);
    }

    // 1) Collect character(s)
    if (typeof char.c === 'string') {
      textParts.push(char.c);
    }
    // Keep char references
    wordChars.push(char);
    lineChars.push(char);

    // 2) Merge rectangles
    if (Array.isArray(char.rect) && char.rect.length === 4) {
      if (!wordRect) {
        wordRect = [...char.rect];
      } else {
        wordRect[0] = Math.min(wordRect[0], char.rect[0]); // x1
        wordRect[1] = Math.min(wordRect[1], char.rect[1]); // y1
        wordRect[2] = Math.max(wordRect[2], char.rect[2]); // x2
        wordRect[3] = Math.max(wordRect[3], char.rect[3]); // y2
      }

      if (!lineRect) {
        lineRect = [...char.rect];
      } else {
        lineRect[0] = Math.min(lineRect[0], char.rect[0]); // x1
        lineRect[1] = Math.min(lineRect[1], char.rect[1]); // y1
        lineRect[2] = Math.max(lineRect[2], char.rect[2]); // x2
        lineRect[3] = Math.max(lineRect[3], char.rect[3]); // y2
      }
    }

    // 3) End-of-word/line?
    if (char.spaceAfter || char.lineBreakAfter) {
      pushWord();
    }
    if (char.lineBreakAfter) {
      pushLine();
    }
  }

  // Flush any trailing word/line
  pushWord();
  pushLine();

  return lines;
}

function getLayoutObjectScore(object, pageRect) {
	if (!Array.isArray(object?.rect) || object.rect.length !== 4) {
		return { perimeter: 0, area: 0 };
	}
	const pageWidth = Math.max(Math.abs((pageRect?.[2] ?? 1) - (pageRect?.[0] ?? 0)), 1);
	const pageHeight = Math.max(Math.abs((pageRect?.[3] ?? 1) - (pageRect?.[1] ?? 0)), 1);
	const width = Math.max(0, Math.abs(object.rect[2] - object.rect[0]) / pageWidth);
	const height = Math.max(0, Math.abs(object.rect[3] - object.rect[1]) / pageHeight);
	return {
		perimeter: width + height,
		area: width * height,
	};
}

function filterLayoutObjects(objects, pageRect) {
	if (!Array.isArray(objects)) {
		return [];
	}
	if (objects.length <= MAX_LAYOUT_OBJECTS_PER_PAGE) {
		return objects;
	}
	return objects
		.map((object, index) => ({
			object,
			index,
			...getLayoutObjectScore(object, pageRect),
		}))
		.sort((a, b) => b.perimeter - a.perimeter || b.area - a.area || a.index - b.index)
		.slice(0, MAX_LAYOUT_OBJECTS_PER_PAGE)
		.sort((a, b) => a.index - b.index)
		.map(item => item.object);
}

export function prepareBlockSegPageInput(pageDataItem) {
	const textLines = getLines(pageDataItem?.chars || []);
	let objectLines = [];
	const rawObjects = filterLayoutObjects(pageDataItem?.objects, pageDataItem?.viewBox);

	if (rawObjects.length) {
		objectLines = rawObjects.map(object => ({
			type: 'object',
			subtype: object.type,
			rect: object.rect,
			...(Number.isFinite(object.seq) ? { seq: object.seq } : {}),
		}));
	}

	const lineFeatures = getPageLines({
		viewport: pageDataItem?.viewBox,
		lines: textLines,
	}).lines;
	const objectFeatures = getPageLines({
		viewport: pageDataItem?.viewBox,
		lines: objectLines,
	}).lines;

	return { textLines, objectLines, lineFeatures, objectFeatures };
}

// ─────────────────── Preformatted (monospace code) detection ───────────────────

const MONO_LINE_THRESHOLD = 0.6;
const MIN_PREFORMATTED_LINES = 3;
const MAX_GAP_LINES = 0;
const GRID_FIT_CHAR_THRESHOLD = 0.75;
const GRID_RESIDUAL_LIMIT = 0.2;

function getMonoCharWidth(chars) {
	const widthCounts = new Map();
	for (const ch of chars) {
		if (ch.monospace && ch.rect && ch.c && ch.c.trim()) {
			const w = Math.round((ch.rect[2] - ch.rect[0]) * 100) / 100;
			if (w > 0) widthCounts.set(w, (widthCounts.get(w) || 0) + 1);
		}
	}
	let best = 0, bestCount = 0;
	for (const [w, count] of widthCounts) {
		if (count > bestCount) { best = w; bestCount = count; }
	}
	return best;
}

function isLineMonospace(line) {
	if (line.type === 'object') return false;
	const chars = line.chars;
	if (!chars || !chars.length) return false;
	let mono = 0, total = 0;
	for (const ch of chars) {
		if (ch.c && ch.c.trim()) {
			total++;
			if (ch.monospace) mono++;
		}
	}
	return total > 0 && mono / total >= MONO_LINE_THRESHOLD;
}

function getFirstNonWsCharX(line) {
	if (!line.chars) return null;
	for (const ch of line.chars) {
		if (ch.rect && ch.c && ch.c.trim()) return ch.rect[0];
	}
	return null;
}

function computeBBoxFromLineIds(lineIds, lines) {
	let bbox = null;
	for (const id of lineIds) {
		const line = lines[id];
		if (!line || !line.rect) continue;
		if (!bbox) {
			bbox = line.rect.slice(0, 4);
		} else {
			bbox[0] = Math.min(bbox[0], line.rect[0]);
			bbox[1] = Math.min(bbox[1], line.rect[1]);
			bbox[2] = Math.max(bbox[2], line.rect[2]);
			bbox[3] = Math.max(bbox[3], line.rect[3]);
		}
	}
	return bbox || [0, 0, 0, 0];
}

// Phase 1: Find candidate regions of consecutive monospace lines
function findMonospaceRegions(lines) {
	let regions = [];
	let startLi = -1, lastMonoLi = -1, monoCount = 0, gap = 0;

	const flush = () => {
		if (startLi !== -1 && monoCount >= MIN_PREFORMATTED_LINES) {
			regions.push({ startLi, endLi: lastMonoLi });
		}
		startLi = -1; lastMonoLi = -1; monoCount = 0; gap = 0;
	};

	for (let li = 0; li < lines.length; li++) {
		if (lines[li].type === 'object') continue;

		if (isLineMonospace(lines[li])) {
			if (startLi === -1) startLi = li;
			lastMonoLi = li;
			monoCount++;
			gap = 0;
		} else if (startLi !== -1) {
			if (++gap > MAX_GAP_LINES) flush();
		}
	}
	flush();
	return regions;
}

// Phase 2: Validate a candidate region with holistic grid-fit analysis
function validateWithGrid(candidate, lines) {
	let { startLi, endLi } = candidate;

	let textLineIndices = [];
	let allChars = [];
	for (let li = startLi; li <= endLi; li++) {
		if (lines[li].type === 'object' || !lines[li].chars?.length) continue;
		textLineIndices.push(li);
		for (let ch of lines[li].chars) allChars.push(ch);
	}

	let monoCharWidth = getMonoCharWidth(allChars);
	if (monoCharWidth <= 0) return null;

	let columnZeroX = Infinity;
	for (let li of textLineIndices) {
		let x = getFirstNonWsCharX(lines[li]);
		if (x !== null && x < columnZeroX) columnZeroX = x;
	}
	if (!isFinite(columnZeroX)) return null;

	let onGrid = 0, total = 0;
	for (let ch of allChars) {
		if (!ch.rect || !ch.c || !ch.c.trim() || !ch.monospace) continue;
		total++;
		let col = (ch.rect[0] - columnZeroX) / monoCharWidth;
		if (Math.abs(col - Math.round(col)) < GRID_RESIDUAL_LIMIT) onGrid++;
	}
	if (total > 0 && onGrid / total < GRID_FIT_CHAR_THRESHOLD) return null;

	let lineIds = textLineIndices.map(li => lines[li].id);
	return {
		startOffset: lines[startLi].startOffset,
		endOffset: lines[endLi].endOffset,
		lineIds,
		bbox: computeBBoxFromLineIds(lineIds, lines),
	};
}

// Phase 3: Overlay validated regions onto ML blocks
function overlayRegions(blocks, regions) {
	let result = [];
	let ri = 0;

	for (let block of blocks) {
		while (ri < regions.length && regions[ri].endOffset < block.startOffset) ri++;

		if (ri >= regions.length || regions[ri].startOffset > block.endOffset) {
			result.push(block);
			continue;
		}

		let region = regions[ri];

		if (block.startOffset < region.startOffset) {
			result.push({ ...block, endOffset: region.startOffset - 1, bbox: block.bbox.slice() });
		}

		if (!region._emitted) {
			result.push({
				type: 'preformatted',
				...(block.flowClass && { flowClass: block.flowClass }),
				startOffset: region.startOffset,
				endOffset: region.endOffset,
				bbox: region.bbox,
				lines: region.lineIds,
			});
			region._emitted = true;
		}

		if (block.endOffset > region.endOffset) {
			result.push({ ...block, startOffset: region.endOffset + 1, bbox: block.bbox.slice() });
		}
	}
	return result;
}

export function detectPreformattedBlocks(blocks, lines) {
	let candidates = findMonospaceRegions(lines);
	let regions = candidates.map(c => validateWithGrid(c, lines)).filter(Boolean);
	if (!regions.length) return blocks;
	return overlayRegions(blocks, regions);
}

const MAX_FALLBACK_BLOCKS_PER_PAGE = 200;

function getPageNumber(pageDataItem) {
	return Number.isInteger(pageDataItem?.pageIndex) ? pageDataItem.pageIndex + 1 : '?';
}

function recordLayoutFallback(pageDataItem, val, fallback) {
	const pageIndex = Number.isInteger(pageDataItem?.pageIndex) ? pageDataItem.pageIndex : null;
	const pageNumber = getPageNumber(pageDataItem);
	const record = {
		type: 'text_only_layout',
		pageIndex,
		pageNumber,
		...fallback,
	};

	if (val) {
		val.layoutFallbacks ||= [];
		val.layoutFallbacks.push(record);
	}

	return record;
}

function unionLineBbox(lines) {
	let bbox = null;
	for (const line of lines) {
		if (!Array.isArray(line?.rect) || line.rect.length !== 4) continue;
		if (!bbox) {
			bbox = line.rect.slice(0, 4);
		}
		else {
			bbox[0] = Math.min(bbox[0], line.rect[0]);
			bbox[1] = Math.min(bbox[1], line.rect[1]);
			bbox[2] = Math.max(bbox[2], line.rect[2]);
			bbox[3] = Math.max(bbox[3], line.rect[3]);
		}
	}
	return bbox || [0, 0, 0, 0];
}

function hasParagraphBreakAfter(line) {
	return Array.isArray(line?.chars) && line.chars.some(char => char?.paragraphBreakAfter);
}

function createParagraphFallbackBlock(lines) {
	let startOffset = null;
	let endOffset = null;
	for (const line of lines) {
		if (Number.isInteger(line.startOffset)) {
			startOffset = startOffset === null ? line.startOffset : Math.min(startOffset, line.startOffset);
		}
		if (Number.isInteger(line.endOffset)) {
			endOffset = endOffset === null ? line.endOffset : Math.max(endOffset, line.endOffset);
		}
	}
	return {
		type: 'body',
		bbox: unionLineBbox(lines),
		lines: lines.map(line => line.id),
		startOffset: startOffset ?? 0,
		endOffset: endOffset ?? startOffset ?? 0,
		text: lines.map(line => line.text).join(' '),
	};
}

function unionBlockBbox(blocks) {
	let bbox = null;
	for (const block of blocks) {
		if (!Array.isArray(block?.bbox) || block.bbox.length !== 4) continue;
		if (!bbox) {
			bbox = block.bbox.slice(0, 4);
		}
		else {
			bbox[0] = Math.min(bbox[0], block.bbox[0]);
			bbox[1] = Math.min(bbox[1], block.bbox[1]);
			bbox[2] = Math.max(bbox[2], block.bbox[2]);
			bbox[3] = Math.max(bbox[3], block.bbox[3]);
		}
	}
	return bbox || [0, 0, 0, 0];
}

function mergeParagraphFallbackBlocks(blocks) {
	let startOffset = null;
	let endOffset = null;
	for (const block of blocks) {
		if (Number.isInteger(block.startOffset)) {
			startOffset = startOffset === null ? block.startOffset : Math.min(startOffset, block.startOffset);
		}
		if (Number.isInteger(block.endOffset)) {
			endOffset = endOffset === null ? block.endOffset : Math.max(endOffset, block.endOffset);
		}
	}
	return {
		type: 'body',
		bbox: unionBlockBbox(blocks),
		lines: blocks.flatMap(block => block.lines),
		startOffset: startOffset ?? 0,
		endOffset: endOffset ?? startOffset ?? 0,
		text: blocks.map(block => block.text).join(' '),
	};
}

function coalesceParagraphFallbackBlocks(blocks, maxBlocks) {
	const blockCount = blocks.length;
	if (blockCount <= maxBlocks) return blocks;

	const coalesced = [];
	for (let i = 0; i < maxBlocks; i++) {
		const start = Math.floor(i * blockCount / maxBlocks);
		const end = Math.floor((i + 1) * blockCount / maxBlocks);
		coalesced.push(mergeParagraphFallbackBlocks(blocks.slice(start, end)));
	}
	return coalesced;
}

export function buildParagraphFallbackBlocks(pageDataItem, val) {
	const lines = getLines(pageDataItem?.chars || []).filter(line => line.type !== 'object');
	const blocks = [];
	let currentLines = [];

	const flush = () => {
		if (!currentLines.length) return;
		blocks.push(createParagraphFallbackBlock(currentLines));
		currentLines = [];
	};

	for (const line of lines) {
		currentLines.push(line);
		if (hasParagraphBreakAfter(line)) {
			flush();
		}
	}
	flush();

	const coalescedBlocks = coalesceParagraphFallbackBlocks(blocks, MAX_FALLBACK_BLOCKS_PER_PAGE);
	if (coalescedBlocks.length !== blocks.length) {
		recordLayoutFallback(pageDataItem, val, {
			reason: 'fallback_blocks_coalesced',
			blockCount: blocks.length,
			coalescedBlockCount: coalescedBlocks.length,
			limit: MAX_FALLBACK_BLOCKS_PER_PAGE,
		});
	}

	return coalescedBlocks;
}

function buildRecordedParagraphFallback(pageDataItem, val, reason, details = {}) {
	const fallback = recordLayoutFallback(pageDataItem, val, {
		reason,
		...details,
	});

	return { blocks: buildParagraphFallbackBlocks(pageDataItem, val), fallback };
}

export function buildInferenceErrorFallbackBlocks(pageDataItem, val, error, details = {}) {
	return buildRecordedParagraphFallback(pageDataItem, val, 'inference_error', {
		...details,
		errorName: error?.name || 'Error',
		errorMessage: error?.message || String(error),
	}).blocks;
}

import { initModel, runInference } from "./model.js";

// Hash functions for first-3-word features
const HASH_MOD = 32768; // produces 0..32767

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

function tokenizeForFirst3(text) {
	if (!text) return [];
	const s = text.normalize("NFKC");

	// 1) Words (unicode letters), 2) numbers, 3) punctuation of interest as standalone tokens
	const raw = s.match(/[\p{L}]+|\d+|[.:]/gu) || [];

	return raw
	.map(t => {
		const x = t.toLowerCase();

		// Normalize all numbers (years, figure indices, ref numbers)
		if (/^\d+$/.test(x)) return "<NUM>";

		// Keep selected punctuation tokens as-is
		// (Everything matched by the punctuation class is 1 char, so this is safe.)
		if (x.length === 1 && /[()[\]{}.,:;!?'"""''\-–—=+×*/<>≤≥#%@&]/u.test(x)) return x;

		// Otherwise it's a word token
		return x;
	})
	 .filter(Boolean);
}

function first3HashesFigureStyle(text) {
	const toks = tokenizeForFirst3(text);
	const out = [0, 0, 0];
	for (let i = 0; i < 3; i++) {
		if (!toks[i]) break;
		out[i] = hashToBucket(toks[i]);
	}
	return { tokens: toks.slice(0, 3), hashes: out };
}

function getPageLines(pdfData) {
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
		const toks = text.toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, '').split(' ');
		return toks.length >= 2
			&& toks[0].length >= 3
			&& text[0].toUpperCase() === text[0]
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
		let uppercaseCount = 0;
		for (const char of text) {
			if (char === char.toUpperCase()) uppercaseCount++;
		}
		return Number((uppercaseCount / text.length).toFixed(2));
	}
	function getFontMatchRatioWithPrev(currentLine, prevLine) {
		if (!currentLine || !prevLine) return 0;
		const currChars = Array.isArray(currentLine.chars) ? currentLine.chars : [];
		const prevChars = Array.isArray(prevLine.chars) ? prevLine.chars : [];
		if (!currChars.length || !prevChars.length) return 0;
		const prevSet = new Set(
			prevChars
			.filter(ch => ch && ch.fontName != null && ch.fontSize != null)
			 .map(ch => `${ch.fontName}::${ch.fontSize}`)
		);
		if (prevSet.size === 0) return 0;
		const currValid = currChars.filter(ch => ch && ch.fontName != null && ch.fontSize != null);
		if (currValid.length === 0) return 0;
		let matchCount = 0;
		for (const ch of currValid) {
			if (prevSet.has(`${ch.fontName}::${ch.fontSize}`)) matchCount++;
		}
		return round(matchCount / currValid.length);
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
	function getBoldCharFraction(line) {
		const chars = Array.isArray(line?.chars) ? line.chars : [];
		if (!chars.length) return 0;
		let total = 0;
		let bold = 0;
		for (const ch of chars) {
			if (!ch) continue;
			total++;
			if (isBoldFontName(ch.fontName) || isItalicFontName(ch.fontName)) bold++;
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
		let deltaYToPrev = 0;
		if (prevLine) {
			const pr = safeRect(prevLine);
			const px1 = clamped01(pr[0] / w1);
			deltaXToPrev = round(px1 - x1);

			const prevHeight = Math.max(0, pr[3] - pr[1]);
			const currHeight = Math.max(0, r[3] - r[1]);
			const denom = Math.max(prevHeight, currHeight) || 1;
			const rawGap = r[1] - pr[3];
			const gap = Math.max(0, rawGap);
			deltaYToPrev = round(gap / denom);
		}

		const lineText = obj ? '' : (line.text || '');

		const startClass = obj ? 0 : lineStartClass(lineText);
		const endClass = obj ? 0 : lineEndClass(lineText);
		const uppercasePct = obj ? 0 : round(getUppercasePercentage(lineText));
		const captionFlag = obj ? 0 : (isCaptionStart(lineText) ? 1 : 0);
		const boldFrac = obj ? 0 : getBoldCharFraction(line);

		let f3 = first3HashesFigureStyle(lineText);

		const vec = [
			...normalizedLine,
			round(lineWidth / w1),
			round(lineHeight / h1),
			round((lineWidth * lineHeight) / (w1 * h1)),
			round(textWidth / ((lineWidth * lineHeight) || 1)),
			uppercasePct,
			startClass,
			endClass,
			fontShareWithPrev,
			deltaXToPrev,
			deltaYToPrev,
			captionFlag,
			boldFrac,

			// NEW required features:
			obj ? 1 : 0,         // lineType: 0=line, 1=object
			getSubtypeCode(line), // subtype: lines always 0; objects 0/1/2
			f3.hashes[0],
			f3.hashes[1],
			f3.hashes[2]
		];

		outLines.push(vec);
	}

	return { lines: outLines };
}

function getLines(chars) {
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


export function buildBlocks(lines, results) {
  // console.log({ lines, results });

	// Must match gentrain5.js BLOCK_TYPES order (10 types)
	const BLOCK_TYPES = ['title', 'body', 'caption', 'image', 'table', 'footnote', 'list_item', 'equation', 'frame', 'ignore'];
	const IGNORE_IDX = BLOCK_TYPES.indexOf('ignore');
	const FRAME_IDX = BLOCK_TYPES.indexOf('frame');

	const normalizeClassIndex = (value) => {
		const n = Number(value);
		if (!Number.isFinite(n)) return null;
		return Math.trunc(n);
	};

	// gentrain5.js encodes labels as:
	// - START/SINGLE classes: 0..9
	// - CONT classes: 10..17 (for base 0..7)
	// We derive base type from the class (not res.type) to stay consistent with training.
	const baseTypeFromClass = (classIndex) => {
		if (classIndex == null) return IGNORE_IDX;
		if (classIndex >= 0 && classIndex < BLOCK_TYPES.length) return classIndex;
		const cont = classIndex - BLOCK_TYPES.length;
		if (cont >= 0 && cont < BLOCK_TYPES.length) return cont;
		return IGNORE_IDX;
	};

	if (!Array.isArray(lines) || !Array.isArray(results) || lines.length !== results.length) {
    throw new Error('lines and results must be arrays of equal length');
  }

  const blocks = [];

  let currentBlock = null;

  const expandBbox = (bbox, rect) => {
    if (!bbox) return rect.slice(0, 4);
    return [
      Math.min(bbox[0], rect[0]),
      Math.min(bbox[1], rect[1]),
      Math.max(bbox[2], rect[2]),
      Math.max(bbox[3], rect[3]),
    ];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const res = results[i];
    // res.class is the raw class: 0-9 = START/SINGLE, 10-17 = CONT
    // (Frame/ignore are trained as always-start segments.)
    const classIndex = normalizeClassIndex(res?.class);
    const baseType = baseTypeFromClass(classIndex);
    let isFirstLine = classIndex == null ? true : classIndex < BLOCK_TYPES.length;
    if (baseType === FRAME_IDX || baseType === IGNORE_IDX) isFirstLine = true;

    const startNewBlock = () => {
      if (currentBlock) blocks.push(currentBlock);
      currentBlock = {
        type: baseType,              // base type (e.g., 2 for paragraph)
        bbox: line.rect.slice(0, 4), // initialize bbox with this line's rect
        lines: [line.id],            // keep line ids for traceability
        startOffset: line.startOffset, // inclusive start in chars
        endOffset: line.endOffset,     // inclusive end in chars
      };
    };

    if (!currentBlock) {
      // No current block yet: start one
      startNewBlock();
    } else {
      // Decide whether to continue current block or start a new one
      if (isFirstLine || currentBlock.type !== baseType) {
        startNewBlock();
      } else {
        // Continue current block
        currentBlock.bbox = expandBbox(currentBlock.bbox, line.rect);
        currentBlock.lines.push(line.id);
        // Update offsets to span the whole block
        if (Number.isInteger(line.startOffset)) {
          currentBlock.startOffset = Number.isInteger(currentBlock.startOffset)
            ? Math.min(currentBlock.startOffset, line.startOffset)
            : line.startOffset;
        }
        if (Number.isInteger(line.endOffset)) {
          currentBlock.endOffset = Number.isInteger(currentBlock.endOffset)
            ? Math.max(currentBlock.endOffset, line.endOffset)
            : line.endOffset;
        }
      }
    }

    // If we just started a new block above for this line, ensure bbox includes it
    if (currentBlock.lines[currentBlock.lines.length - 1] !== line.id) {
      // this branch occurs only when we didn't push the line yet (i.e., startNewBlock was called)
      currentBlock.bbox = expandBbox(currentBlock.bbox, line.rect);
      currentBlock.lines.push(line.id);
    }
  }

  if (currentBlock) blocks.push(currentBlock);

  blocks.forEach(block => block.type = BLOCK_TYPES[block.type]);

  return blocks;
}

export async function inference(pageDataList, onnxRuntimeProvider, val) {

	let model = await initModel(onnxRuntimeProvider);

	let pageDataList2 = [];
	for (let pageDataItem of pageDataList) {
		let lines = getLines(pageDataItem.chars);

		// Append objects as line entries (matching gentrain5.js format)
		// Each object needs an `id` equal to its index in the lines array
		if (Array.isArray(pageDataItem.objects)) {
			for (let object of pageDataItem.objects) {
				lines.push({
					id: lines.length,  // IMPORTANT: id must equal index
					type: 'object',
					subtype: object.type,
					rect: object.rect,
				});
			}
		}

		pageDataList2.push({
			viewport: pageDataItem.viewBox,
			lines: lines
		});
	}

	let inferenceLines = getPageLines(pageDataList2[0]).lines;


		let lines = pageDataList2[0].lines;

		let infms = Date.now();

		const { predictions, logitsShape } = await runInference({
			...model,
			records: [
				{ lines: inferenceLines }
			],
			shape: { T: inferenceLines.length }
		});

		infms = Date.now() - infms;
		val.inferenceTime = infms;


		let result = predictions[0];
		let blocks = buildBlocks(lines, result);
		for (let block of blocks) {
			block.text = block.lines
				.map(l => lines[l])
				.filter(line => line.type !== 'object')
				.map(line => line.text)
				.join(' ');
		}

		return blocks;
}

let promise;

export async function processPages() {
	if (promise) {
		return promise;
	}
	promise = new Promise(async (resolve, reject) => {

		let pageDataList = [];
		for (let i = 0; i < window.PDFViewerApplication.pdfDocument.numPages; i++) {
			let pageData = await window.PDFViewerApplication.pdfDocument.getPageData({ pageIndex: i });
			pageDataList.push(pageData);
		}

		resolve(await inference(pageDataList));

	});

	return promise;
}

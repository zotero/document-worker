
// Split reference.text into words with their start offsets
export function tokenizeReferenceText(text) {
	const punctuation = '?.,;!¡¿。、·(){}[]/$:';
	const separators = new Set([...punctuation, ' ']);

	const tokens = [];
	let start = -1;

	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		const isSeparator = separators.has(ch);

		if (isSeparator) {
			if (start !== -1) {
				tokens.push({
					text: text.slice(start, i),
					offset: start,
				});
				start = -1;
			}
		}
		else if (start === -1) {
			start = i;
		}
	}

	// Final token at end of string
	if (start !== -1) {
		tokens.push({
			text: text.slice(start),
			offset: start,
		});
	}

	return tokens;
}

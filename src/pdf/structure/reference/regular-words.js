
export function updateRegularWordsSet(chars, existingSet) {
	let word = [];
	let wordOffsetFrom = 0;
	for (let i = 0; i < chars.length; i++) {
		let char = chars[i];
		word.push(char);
		if (char.wordBreakAfter) {
			let text = word.map(x => x.c).join('');
			let lower = text.toLowerCase();
			let upper = text.toUpperCase();

			if (lower !== upper && text === lower) {
				existingSet.add(text);
			}

			word = [];
			wordOffsetFrom = i + 1;
		}
	}
	return existingSet;
}

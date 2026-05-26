
export function updateRegularWordsSet(chars, existingSet) {
	let word = '';
	for (let i = 0; i < chars.length; i++) {
		let char = chars[i];
		word += char.c ?? '';
		if (char.wordBreakAfter) {
			let lower = word.toLowerCase();
			let upper = word.toUpperCase();

			if (lower !== upper && word === lower) {
				existingSet.add(word);
			}

			word = '';
		}
	}
	return existingSet;
}

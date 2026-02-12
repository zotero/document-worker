
export function getFigures(structure) {
	let figures = new Map();
	for (let i = 0; i < structure.content.length; i++) {
		const block = structure.content[i];
		if (block?.type !== 'title') continue;

		const raw = block.text;
		if (!raw) continue;

		const text = raw.trim();
		if (!text) continue;

		// Take the first two whitespace-delimited tokens
		const tokens = text.split(' ');
		if (tokens.length < 2) continue;

		let name = tokens[0];
		const numberToken = tokens[1];

		// First word must start with an uppercase letter
		if (name[0].toUpperCase() !== name[0]) {
			continue;
		}
		name = name.toLowerCase();
		// Second word must start with a number; capture leading digits only
		if (!(numberToken[0] >= '0' && numberToken[0] <= '9')) continue;
		const number = (numberToken.match(/^\d+/) || [])[0];
		if (!number) continue;

		if (!figures.has(name)) {
			// initialize nested map for this figure name
			figures.set(name, new Map());
		}
		const mapForName = figures.get(name);
		if (!mapForName.has(number)) {
			mapForName.set(number, { src: { blockRef: [i]} });
		}
	}
	return figures;
}

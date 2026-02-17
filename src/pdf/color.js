export function arrayColorToHex(color) {
	if (!color || color.length !== 3) return '';

	let result = '#';
	for (let c of color) {
		let hex = c.toString(16);
		result += hex.length === 1 ? '0' + hex : hex;
	}

	return result;
}

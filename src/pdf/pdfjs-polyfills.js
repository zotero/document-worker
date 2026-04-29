if (typeof Math.sumPrecise !== 'function') {
	Math.sumPrecise = function (numbers) {
		return numbers.reduce((sum, value) => sum + value, 0);
	};
}

if (typeof Uint8Array.prototype.toHex !== 'function') {
	Object.defineProperty(Uint8Array.prototype, 'toHex', {
		value() {
			let hex = '';
			for (let byte of this) {
				hex += byte.toString(16).padStart(2, '0');
			}
			return hex;
		},
		configurable: true,
		writable: true
	});
}

if (typeof Uint8Array.prototype.toBase64 !== 'function') {
	Object.defineProperty(Uint8Array.prototype, 'toBase64', {
		value() {
			if (typeof Buffer !== 'undefined') {
				return Buffer.from(this).toString('base64');
			}
			let binary = '';
			for (let i = 0; i < this.length; i += 0x8000) {
				binary += String.fromCharCode(...this.subarray(i, i + 0x8000));
			}
			return btoa(binary);
		},
		configurable: true,
		writable: true
	});
}

if (typeof Uint8Array.fromBase64 !== 'function') {
	Object.defineProperty(Uint8Array, 'fromBase64', {
		value(base64) {
			if (typeof Buffer !== 'undefined') {
				return new Uint8Array(Buffer.from(base64, 'base64'));
			}
			let binary = atob(base64);
			let bytes = new Uint8Array(binary.length);
			for (let i = 0; i < binary.length; i++) {
				bytes[i] = binary.charCodeAt(i);
			}
			return bytes;
		},
		configurable: true,
		writable: true
	});
}

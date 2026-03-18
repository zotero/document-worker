import { unzipSync } from 'fflate';

const TEXT_EXTENSIONS = new Set([
	'.xhtml', '.html', '.htm', '.xml', '.opf', '.ncx',
]);

/**
 * Extract text entries from an EPUB (ZIP) ArrayBuffer.
 * Only decompresses entries with text-like extensions to avoid
 * wasting memory on images, fonts, and other binary content.
 */
export function readZipEntries(arrayBuffer: ArrayBuffer): Map<string, Uint8Array> {
	let data = new Uint8Array(arrayBuffer);
	let entries = unzipSync(data, {
		filter(file) {
			let dot = file.name.lastIndexOf('.');
			if (dot < 0) return true; // extensionless files (e.g. mimetype)
			let ext = file.name.slice(dot).toLowerCase();
			return TEXT_EXTENSIONS.has(ext);
		},
	});
	let map = new Map<string, Uint8Array>();
	for (let path in entries) {
		map.set(path, entries[path]);
	}
	return map;
}

import '../../scripts/pdfjs-setup.js';

import { createCanvas } from '@napi-rs/canvas';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { deflate } from 'pako';

import { BaseStream } from '../../pdf.js/src/core/base_stream.js';
import { PDFAssembler } from '../../src/pdf/pdfassembler.js';
import {
	deletePages,
	importAnnotations,
	rotatePages,
	writeAnnotations,
} from '../../src/pdf/index.js';


const note = {
	id: 'TEST0001',
	type: 'note',
	color: '#ffd400',
	position: { pageIndex: 0, rects: [[20, 20, 42, 42]] },
	authorName: 'Test',
	comment: 'Test note',
	dateModified: '2026-09-03T00:00:00.000Z',
	tags: [],
};

function makeJpeg() {
	let canvas = createCanvas(8, 8);
	let context = canvas.getContext('2d');
	context.fillStyle = '#c30';
	context.fillRect(0, 0, canvas.width, canvas.height);
	return canvas.toBuffer('image/jpeg');
}

async function makeNestedFilterImagePDF() {
	let encodedImage = deflate(makeJpeg());
	let image = {
		'/Type': '/XObject',
		'/Subtype': '/Image',
		'/Width': 8,
		'/Height': 8,
		'/ColorSpace': '/DeviceRGB',
		'/BitsPerComponent': 8,
		'/Filter': ['/FlateDecode', '/DCTDecode'],
		stream: encodedImage,
	};
	let externalNote = {
		'/Type': '/Annot',
		'/Subtype': '/Text',
		'/Rect': [20, 20, 42, 42],
		'/M': '(D:20260903000000Z)',
		'/Contents': '(Transfer test)',
		'/C': [1, 0.83, 0],
		'/NM': '(external-note)',
	};
	let structure = {
		'/Info': {},
		'/Root': {
			'/Type': '/Catalog',
			'/Pages': {
				'/Type': '/Pages',
				'/Count': 2,
				'/Kids': [{
					'/Type': '/Page',
					'/MediaBox': [0, 0, 300, 300],
					'/Resources': { '/XObject': { '/Im0': image } },
					'/Contents': { stream: 'q\n160 0 0 160 70 70 cm\n/Im0 Do\nQ' },
					'/Annots': [externalNote],
				}, {
					'/Type': '/Page',
					'/MediaBox': [0, 0, 300, 300],
					'/Resources': {},
					'/Contents': [],
				}],
			},
		},
	};
	let pdf = new PDFAssembler();
	await pdf.init(structure);
	return {
		buf: pdf.assemblePdf('ArrayBuffer'),
		encodedImage,
	};
}

async function getFirstImage(buf) {
	let pdf = new PDFAssembler();
	await pdf.init(buf);
	return pdf.getPDFStructure()
		['/Root']['/Pages']['/Kids'][0]
		['/Resources']['/XObject']['/Im0'];
}

function encodePredictorRows(decoded, rowLength) {
	assert.equal(decoded.length % rowLength, 0);
	let encoded = new Uint8Array(decoded.length + decoded.length / rowLength);
	let sourceOffset = 0;
	let targetOffset = 0;
	while (sourceOffset < decoded.length) {
		// PNG predictor 12 uses a per-row filter byte; zero means no prediction.
		encoded[targetOffset++] = 0;
		encoded.set(decoded.subarray(sourceOffset, sourceOffset + rowLength), targetOffset);
		sourceOffset += rowLength;
		targetOffset += rowLength;
	}
	return encoded;
}

async function makePredictorContentPDF(decodeParmsKey) {
	let line = '% Predictor parameters must not survive decoding.\n';
	let decoded = new TextEncoder().encode(line.repeat(200).slice(0, 8192));
	let rowLength = 64;
	let contents = {
		'/Filter': '/FlateDecode',
		[decodeParmsKey]: {
			'/Predictor': 12,
			'/Colors': 1,
			'/BitsPerComponent': 8,
			'/Columns': rowLength,
		},
		stream: deflate(encodePredictorRows(decoded, rowLength)),
	};
	let structure = {
		'/Info': {},
		'/Root': {
			'/Type': '/Catalog',
			'/Pages': {
				'/Type': '/Pages',
				'/Count': 1,
				'/Kids': [{
					'/Type': '/Page',
					'/MediaBox': [0, 0, 300, 300],
					'/Resources': {},
					'/Contents': contents,
				}],
			},
		},
	};
	let pdf = new PDFAssembler();
	await pdf.init(structure);
	return {
		buf: pdf.assemblePdf('ArrayBuffer'),
		decoded,
	};
}

async function getFirstPageContents(buf) {
	let pdf = new PDFAssembler();
	await pdf.init(buf);
	return pdf.getPDFStructure()['/Root']['/Pages']['/Kids'][0]['/Contents'];
}

describe('PDF assembler', function () {
	it('should preserve nested-filter image streams through PDF rewrites', async function (t) {
		let operations = {
			'write annotations': buf => writeAnnotations(buf, [note]),
			'rotate pages': buf => rotatePages(buf, [0], 90),
			'delete pages': buf => deletePages(buf, [1]),
			'transfer annotations': async (buf) => {
				let result = await importAnnotations(
					buf,
					[],
					'',
					true,
					path => Promise.reject(new Error(`Unexpected data request: ${path}`))
				);
				assert.equal(result.imported.length, 1);
				return result.buf;
			},
		};

		for (let [name, operation] of Object.entries(operations)) {
			await t.test(name, async function () {
				let { buf, encodedImage } = await makeNestedFilterImagePDF();
				let image = await getFirstImage(await operation(buf));
				assert.deepEqual(image['/Filter'], ['/FlateDecode', '/DCTDecode']);
				assert.ok(image.stream instanceof Uint8Array);
				assert.deepEqual(image.stream, encodedImage);
			});
		}
	});

	for (let decodeParmsKey of ['/DecodeParms', '/DP']) {
		it(`should remove ${decodeParmsKey} when decoding a stream`, async function () {
			let { buf, decoded } = await makePredictorContentPDF(decodeParmsKey);
			let output = await writeAnnotations(buf, [note]);
			let contents = await getFirstPageContents(output);
			assert.equal(contents[decodeParmsKey], undefined);
			assert.equal(contents.stream, new TextDecoder().decode(decoded));
		});
	}

	it('should fail rather than omit an unresolved stream', function () {
		class UnresolvedStream extends BaseStream {
			getOriginalStream() {
				return null;
			}
		}
		let pdf = new PDFAssembler();
		assert.throws(
			() => pdf.resolveNodeRefs(new UnresolvedStream()),
			/Unable to resolve original PDF stream/
		);
	});
});

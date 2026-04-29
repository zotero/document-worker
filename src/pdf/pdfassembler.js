/*
	MIT License

	Copyright (c) 2018 David Schnell-Davis

	Permission is hereby granted, free of charge, to any person obtaining a copy
	of this software and associated documentation files (the "Software"), to deal
	in the Software without restriction, including without limitation the rights
	to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
	copies of the Software, and to permit persons to whom the Software is
	furnished to do so, subject to the following conditions:

	The above copyright notice and this permission notice shall be included in all
	copies or substantial portions of the Software.

	THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
	IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
	FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
	AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
	LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
	OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
	SOFTWARE.
 */

// Slightly modified version of https://github.com/DevelopingMagic/pdfassembler

import { LocalPdfManager } from '../../pdf.js/src/core/pdf_manager.js';
import { Dict, Name, Ref } from '../../pdf.js/src/core/primitives.js';

import { BaseStream } from '../../pdf.js/src/core/base_stream.js';
import { Ascii85Stream } from '../../pdf.js/src/core/ascii_85_stream.js';
import { AsciiHexStream } from '../../pdf.js/src/core/ascii_hex_stream.js';
import { CCITTFaxStream } from '../../pdf.js/src/core/ccitt_stream.js';
import { FlateStream } from '../../pdf.js/src/core/flate_stream.js';
import { Jbig2Stream } from '../../pdf.js/src/core/jbig2_stream.js';
import { JpegStream } from '../../pdf.js/src/core/jpeg_stream.js';
import { JpxStream } from '../../pdf.js/src/core/jpx_stream.js';
import { LZWStream } from '../../pdf.js/src/core/lzw_stream.js';
import { NullStream, Stream } from '../../pdf.js/src/core/stream.js';
import { PredictorStream } from '../../pdf.js/src/core/predictor_stream.js';
import { RunLengthStream } from '../../pdf.js/src/core/run_length_stream.js';
import { DecodeStream } from '../../pdf.js/src/core/decode_stream.js';
import { DecryptStream } from '../../pdf.js/src/core/decrypt_stream.js';

import { XRefParseException } from '../../pdf.js/src/core/core_utils.js';
import { bytesToString, stringToBytes } from '../../pdf.js/src/shared/util.js';
import { deflate } from 'pako';

/**
 * Gets length of the array (Array, Uint8Array, or string) in bytes.
 * @param {Array<any>|Uint8Array|string} arr
 * @returns {number}
 */
// eslint-disable-next-line consistent-return
function arrayByteLength(arr) {
	if (arr.length !== undefined) {
		return arr.length;
	}
	if (arr.byteLength !== undefined) {
		return arr.byteLength;
	}
	throw new Error("Invalid argument for arrayByteLength");
}

/**
 * Combines array items (arrays) into single Uint8Array object.
 * @param {Array<Array<any>|Uint8Array|string>} arr - the array of the arrays
 *   (Array, Uint8Array, or string).
 * @returns {Uint8Array}
 */
function arraysToBytes(arr) {
	const length = arr.length;
	// Shortcut: if first and only item is Uint8Array, return it.
	if (length === 1 && arr[0] instanceof Uint8Array) {
		return arr[0];
	}
	let resultLength = 0;
	for (let i = 0; i < length; i++) {
		resultLength += arrayByteLength(arr[i]);
	}
	let pos = 0;
	const data = new Uint8Array(resultLength);
	for (let i = 0; i < length; i++) {
		let item = arr[i];
		if (!(item instanceof Uint8Array)) {
			if (typeof item === "string") {
				item = stringToBytes(item);
			} else {
				item = new Uint8Array(item);
			}
		}
		const itemLength = item.byteLength;
		data.set(item, pos);
		pos += itemLength;
	}
	return data;
}

function setDictEntries(dict, entries) {
	for (let [key, value] of Object.entries(entries)) {
		if (value !== undefined) {
			dict.set(key, value);
		}
	}
}

function getDictRawEntries(dict) {
	if (dict?.getRawEntries) {
		return dict.getRawEntries();
	}
	return null;
}

export class PDFAssembler {
	constructor() {
		this.pdfManager = null;
		this.userPassword = '';
		this.ownerPassword = '';
		this.nextNodeNum = 1;
		this.pdfTree = Object.create(null);
		this.recoveryMode = false;
		this.objCache = Object.create(null);
		this.objCacheQueue = Object.create(null);
		this.pdfManagerArrays = new Map();
		this.pdfAssemblerArrays = [];
		this.indent = false;
		this.compress = true;
		this.encrypt = false;
		this.groupPages = true;
		this.pageGroupSize = 16;
		this.pdfVersion = '1.7';
	}

	async init(inputData, userPassword = '') {
		if (userPassword.length) {
			this.userPassword = userPassword;
		}
		if (typeof inputData === 'object') {
			if (inputData instanceof ArrayBuffer || inputData instanceof Uint8Array) {
				let arrayBuffer = await this.toArrayBuffer(inputData);
				const pdfManagerArgs = {
					source: arrayBuffer,
					evaluatorOptions: {
						cMapUrl: null,
						cMapPacked: true,
						standardFontDataUrl: null,
						ignoreErrors: true
					},
					password: userPassword
				};
				this.pdfManager = new LocalPdfManager(pdfManagerArgs);
				await this.pdfManager.ensureDoc('checkHeader', []);
				await this.pdfManager.ensureDoc('parseStartXRef', []);
				// Enter into recovery mode if the initial parse fails
				try {
					await this.pdfManager.ensureDoc('parse', [this.recoveryMode]);
				}
				catch (e) {
					if (!(e instanceof XRefParseException) && !this.recoveryMode) {
						throw e;
					}
					this.recoveryMode = true;
					await this.pdfManager.ensureDoc('parse', [this.recoveryMode]);
				}
				await this.pdfManager.ensureDoc('numPages');
				await this.pdfManager.ensureDoc('fingerprint');

				this.pdfTree['/Root'] = this.resolveNodeRefs();
				const infoDict = new Dict();
				setDictEntries(infoDict, this.pdfManager.pdfDocument.documentInfo);
				this.pdfTree['/Info'] = this.resolveNodeRefs(infoDict) || {};
				delete this.pdfTree['/Info']['/PDFFormatVersion'];
				delete this.pdfTree['/Info']['/Language'];
				delete this.pdfTree['/Info']['/EncryptFilterName'];
				delete this.pdfTree['/Info']['/IsLinearized'];
				delete this.pdfTree['/Info']['/IsAcroFormPresent'];
				delete this.pdfTree['/Info']['/IsXFAPresent'];
				delete this.pdfTree['/Info']['/IsCollectionPresent'];
				delete this.pdfTree['/Info']['/IsSignaturesPresent'];

				if (this.pdfManager.pdfDocument.documentInfo['Custom']) {
					delete this.pdfTree['/Info']['/Custom'];
					let customDict = new Dict();
					setDictEntries(customDict, this.pdfManager.pdfDocument.documentInfo['Custom']);
					this.pdfTree['/Info'] = { ...this.pdfTree['/Info'], ...(this.resolveNodeRefs(customDict) || {}) };
				}

				let producer = this.pdfManager.pdfDocument.documentInfo.Producer;
				if (producer) {
					if (!producer.includes('Zotero')) {
						producer = `Zotero (${producer})`;
					}
				}
				else {
					producer = 'Zotero';
				}
				this.pdfTree['/Info']['/Producer'] = '(' + producer + ')';

				this.pdfTree['/Info']['/ModDate'] = '(' + this.toPdfDate() + ')';
				this.flattenPageTree();
			}
			else {
				this.pdfTree = inputData;
			}
		}
		else {
			this.pdfTree = {
				'documentInfo': {},
				'/Info': {
					'/Producer': '(PDF Assembler)',
					'/CreationDate': '(' + this.toPdfDate() + ')',
					'/ModDate': '(' + this.toPdfDate() + ')'
				},
				'/Root': {
					'/Type': '/Catalog',
					'/Pages': {
						'/Type': '/Pages',
						'/Count': 1,
						'/Kids': [{
							'/Type': '/Page',
							'/MediaBox': [0, 0, 612, 792],
							'/Contents': [],
							'/Resources': {}
						}]
					}
				}
			};
		}
	}

	getPDFDocument() {
		return this.pdfManager && this.pdfManager.pdfDocument;
	}

	countPages() {
		this.flattenPageTree();
		return this.pdfTree['/Root']['/Pages']['/Count'];
	}

	getPDFStructure() {
		return this.pdfTree;
	}

	async toArrayBuffer(file) {
		const typedArrays = [
			Int8Array, Uint8Array, Int16Array, Uint16Array, Int32Array,
			Uint32Array, Uint8ClampedArray, Float32Array, Float64Array
		];
		return file instanceof ArrayBuffer ? file :
			typedArrays.some(typedArray => file instanceof typedArray) ?
				file.buffer : new ArrayBuffer(0);
	}

	resolveNodeRefs(node = this.pdfManager.pdfDocument.catalog.xref.root, name, parent, contents = false) {
		if (node instanceof Ref) {
			const refKey = `${node.num}-${node.gen}`;
			if (this.objCache[refKey] === undefined) {
				this.objCache[refKey] = null;
				let refNode;
				try {
					refNode = this.pdfManager.pdfDocument.xref.fetch(node);
				} catch (e) {
					console.error(e);
				}
				if (refNode) {
					this.objCache[refKey] = this.resolveNodeRefs(refNode, name, parent, contents);
					if (typeof this.objCache[refKey] === 'object' &&
						this.objCache[refKey] !== null &&
						!(this.objCache[refKey] instanceof Array)) {
						Object.assign(this.objCache[refKey], { num: 0, gen: 0 });
					}
					if (this.objCacheQueue[refKey] !== undefined) {
						Object.keys(this.objCacheQueue[refKey]).forEach(fixName => this.objCacheQueue[refKey][fixName].forEach(fixParent => fixParent[fixName] = this.objCache[refKey]));
						delete this.objCacheQueue[refKey];
					}
				}
			}
			else if (this.objCache[refKey] === null) {
				if (this.objCacheQueue[refKey] === undefined) {
					this.objCacheQueue[refKey] = Object.create(null);
				}
				if (this.objCacheQueue[refKey][name] === undefined) {
					this.objCacheQueue[refKey][name] = [];
				}
				this.objCacheQueue[refKey][name].push(parent);
				return node;
			}
			return this.objCache[refKey];
		}
		else if (node instanceof Name) {
			return '/' + node.name;
		}
		else if (typeof node === 'string') {
			return `(${node})`;
		}
		else if (node instanceof Array) {
			const existingArrayIndex = this.pdfManagerArrays.get(node);
			if (existingArrayIndex) {
				return existingArrayIndex;
			}
			else {
				const newArrayNode = [];
				this.pdfManagerArrays.set(node, newArrayNode);
				// this.pdfAssemblerArrays.push(newArrayNode);
				for (let i = 0; i < node.length; i++) {
					let element = node[i];
					newArrayNode.push(this.resolveNodeRefs(element, i, newArrayNode, contents));
				}
				return newArrayNode;
			}
		}
		else if (typeof node === 'object' && node !== null) {
			const objectNode = Object.create(null);
			let source = null;
			let nodeDict = node.dict instanceof Dict ? node.dict : node instanceof Dict ? node : null;
			let nodeEntries = getDictRawEntries(nodeDict);
			if (nodeEntries) {
				let hasContents = !!nodeDict.getRaw?.('Contents');
				for (let [key, value] of nodeEntries) {
					objectNode[`/${key}`] = this.resolveNodeRefs(value, `/${key}`, objectNode, hasContents);
				}
			}
			if (node instanceof DecodeStream || node instanceof Stream) {
				const streamsToDecode = [FlateStream, PredictorStream, DecryptStream, Ascii85Stream, RunLengthStream, LZWStream];
				// Filters from PDF.js Parser.filter()
				const standardFilters = [
					'LZWDecode', 'DCTDecode', 'JPXDecode', 'ASCII85Decode', 'ASCIIHexDecode', 'CCITTFaxDecode', 'RunLengthDecode', 'JBIG2Decode',
					'LZW', 'DCT', 'JPX', 'A85', 'AHx', 'CCF', 'RL'
				];
				if (objectNode['/Subtype'] !== '/Image'
					&& streamsToDecode.some(streamToDecode => node instanceof streamToDecode)
					// Decode stream if all filters are standard
					&& (
						!objectNode['/Filter']
						|| typeof objectNode['/Filter'] === 'string'
						|| (
							Array.isArray(objectNode['/Filter'])
							// At this point everything is flattened therefore we're just looking for a filter string, we can't use .name property here
							&& objectNode['/Filter'].every(f => standardFilters.some(sf => f.includes(sf)))
						)
					)
				) {
					objectNode.stream = node.getBytes();
					delete objectNode['/Filter'];
				}
				if (!objectNode.stream) {
					for (const checkSource of [
						node, node.stream, node.stream && node.stream.str,
						node.str, node.str && node.str.str
					]) {
						if (checkSource instanceof Stream || checkSource instanceof DecryptStream) {
							source = checkSource;
							break;
						}
					}
					if (source) {
						source.reset();
						objectNode.stream = source.getBytes();
					}
				}
			}
			if (objectNode.stream) {
				if (contents || objectNode['/Subtype'] === '/XML' ||
					(objectNode.stream && objectNode.stream.every(byte => byte < 128))) {
					objectNode.stream = bytesToString(objectNode.stream);
				}
				delete objectNode['/Length'];
			}
			if (node === this.pdfManager.pdfDocument.catalog._catDict) {
				const catKey = node.objId.slice(0, -1) + '-0';
				this.objCache[catKey] = Object.assign(objectNode, {
					num: this.nextNodeNum++,
					gen: 0
				});
			}
			return objectNode;
		}
		else {
			return node;
		}
	}

	pad(number, digits) {
		return ('0'.repeat(digits - 1) + parseInt(number, 10)).slice(-digits);
	}

	toPdfDate(jsDate = new Date()) {
		if (!(jsDate instanceof Date)) {
			return null;
		}
		const timezoneOffset = jsDate.getTimezoneOffset();
		return 'D:' +
			jsDate.getFullYear() +
			this.pad(jsDate.getMonth() + 1, 2) +
			this.pad(jsDate.getDate(), 2) +
			this.pad(jsDate.getHours(), 2) +
			this.pad(jsDate.getMinutes(), 2) +
			this.pad(jsDate.getSeconds(), 2) +
			(timezoneOffset < 0 ? '+' : '-') +
			this.pad(Math.abs(Math.trunc(timezoneOffset / 60)), 2) + '\'' +
			this.pad(Math.abs(timezoneOffset % 60), 2) + '\'';
	}

	fromPdfDate(pdfDate) {
		if (typeof pdfDate !== 'string') {
			return null;
		}
		if (pdfDate[0] === '(' && pdfDate[pdfDate.length - 1] === ')') {
			pdfDate = pdfDate.slice(1, -1);
		}
		if (pdfDate.slice(0, 2) !== 'D:') {
			return null;
		}
		const part = (start, end, offset = 0) => parseInt(pdfDate.slice(start, end), 10) + offset;
		return new Date(part(2, 6), part(6, 8, -1), part(8, 10), part(10, 12), part(12, 14), part(14, 16), 0);
	}

	removeRootEntries(entries) {
		return this.pdfObject.then(tree => {
			Object.keys(tree['/Root'])
			.filter(key => entries && entries.length ?
				entries.includes(key) :
				!['/Type', '/Pages', 'num', 'gen'].includes(key))
			.forEach(key => delete tree['/Root'][key]);
			return tree;
		});
	}

	flattenPageTree(pageTree = this.pdfTree['/Root']['/Pages']['/Kids'], parent = this.pdfTree['/Root']['/Pages']) {
		let flatPageTree = [];
		pageTree.forEach((page) => flatPageTree = (page && page['/Kids']) ?
			[...flatPageTree, ...this.flattenPageTree(page['/Kids'], page)] :
			[...flatPageTree, page]);
		['/Resources', '/MediaBox', '/CropBox', '/Rotate']
		.filter(attribute => parent[attribute])
		.forEach(attribute => {
			flatPageTree
			.filter(page => !page[attribute])
			.forEach(page => page[attribute] = parent[attribute]);
			delete parent[attribute];
		});
		if (pageTree === this.pdfTree['/Root']['/Pages']['/Kids']) {
			this.pdfTree['/Root']['/Pages']['/Count'] = flatPageTree.length;
			this.pdfTree['/Root']['/Pages']['/Kids'] = flatPageTree;
		}
		else {
			return flatPageTree;
		}
	}

	groupPageTree(pageTree = this.pdfTree['/Root']['/Pages']['/Kids'], parent = this.pdfTree['/Root']['/Pages'], groupSize = this.pageGroupSize) {
		let groupedPageTree = [];
		if (pageTree.length <= groupSize) {
			groupedPageTree = pageTree.map(page => Object.assign(page, { 'num': 0, '/Parent': parent }));
		}
		else {
			let branchSize = groupSize, branches = Math.ceil(pageTree.length / branchSize);
			if (pageTree.length > groupSize * groupSize) {
				[branchSize, branches] = [branches, branchSize];
			}
			for (let i = 0; i < branches; i++) {
				const branchPages = pageTree.slice(branchSize * i, branchSize * (i + 1));
				if (branchPages.length === 1) {
					groupedPageTree.push(Object.assign(branchPages[0], { 'num': 0, '/Parent': parent }));
				}
				else if (branchPages.length > 1) {
					const pagesObject = {};
					groupedPageTree.push(Object.assign(pagesObject, {
						'num': 0, '/Type': '/Pages', '/Parent': parent, '/Count': branchPages.length,
						'/Kids': this.groupPageTree(branchPages, pagesObject, groupSize)
					}));
				}
			}
		}
		if (pageTree === this.pdfTree['/Root']['/Pages']['/Kids']) {
			this.pdfTree['/Root']['/Pages']['/Count'] = pageTree.length;
			this.pdfTree['/Root']['/Pages']['/Kids'] = groupedPageTree;
		}
		else {
			return groupedPageTree;
		}
	}

	resetObjectIds(node = this.pdfTree['/Root']) {
		if (node === this.pdfTree['/Root']) {
			this.nextNodeNum = 1;
			this.objCache = new Set();
		}
		if (!this.objCache.has(node)) {
			this.objCache.add(node);
			const toReset = (item) => typeof item === 'object' && item !== null && !this.objCache.has(item);
			if (node instanceof Array) {
				node.filter(toReset).forEach(item => this.resetObjectIds(item));
			}
			else {
				const makeIndirect = [
					'/AcroForm', '/MarkInfo', '/Metadata', '/Names', '/Outlines', '/StructTreeRoot',
					'/ViewerPreferences', '/Catalog', '/Pages', '/OCG'
				];
				if (typeof node.num === 'number' || node.stream || makeIndirect.includes(node['/Type'])) {
					Object.assign(node, { num: this.nextNodeNum++, gen: 0 });
				}
				Object.keys(node)
				.filter(key => toReset(node[key]))
				.forEach(key => this.resetObjectIds(node[key]));
			}
		}
	}

	assemblePdf(nameOrOutputFormat = 'output.pdf') {
		const stringByteMap = [
			'\\000', '\\001', '\\002', '\\003', '\\004', '\\005', '\\006', '\\007',
			'\\b', '\\t', '\\n', '\\013', '\\f', '\\r', '\\016', '\\017',
			'\\020', '\\021', '\\022', '\\023', '\\024', '\\025', '\\026', '\\027',
			'\\030', '\\031', '\\032', '\\033', '\\034', '\\035', '\\036', '\\037',
			' ', '!', '"', '#', '$', '%', '&', '\'', '\\(', '\\)', '*', '+', ',', '-', '.', '/',
			'0', '1', '2', '3', '4', '5', '6', '7', '8', '9', ':', ';', '<', '=', '>', '?',
			'@', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O',
			'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z', '[', '\\\\', ']', '^', '_',
			'`', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o',
			'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z', '{', '|', '}', '~', '\\177',
			'\\200', '\\201', '\\202', '\\203', '\\204', '\\205', '\\206', '\\207',
			'\\210', '\\211', '\\212', '\\213', '\\214', '\\215', '\\216', '\\217',
			'\\220', '\\221', '\\222', '\\223', '\\224', '\\225', '\\226', '\\227',
			'\\230', '\\231', '\\232', '\\233', '\\234', '\\235', '\\236', '\\237',
			'\\240', '¡', '¢', '£', '¤', '¥', '¦', '§', '¨', '©', 'ª', '«', '¬', '­', '®', '¯',
			'°', '±', '²', '³', '´', 'µ', '¶', '·', '¸', '¹', 'º', '»', '¼', '½', '¾', '¿',
			'À', 'Á', 'Â', 'Ã', 'Ä', 'Å', 'Æ', 'Ç', 'È', 'É', 'Ê', 'Ë', 'Ì', 'Í', 'Î', 'Ï',
			'Ð', 'Ñ', 'Ò', 'Ó', 'Ô', 'Õ', 'Ö', '×', 'Ø', 'Ù', 'Ú', 'Û', 'Ü', 'Ý', 'Þ', 'ß',
			'à', 'á', 'â', 'ã', 'ä', 'å', 'æ', 'ç', 'è', 'é', 'ê', 'ë', 'ì', 'í', 'î', 'ï',
			'ð', 'ñ', 'ò', 'ó', 'ô', 'õ', 'ö', '÷', 'ø', 'ù', 'ú', 'û', 'ü', 'ý', 'þ', 'ÿ'
		];
		const space = !this.indent ? '' :
			typeof this.indent === 'number' ? ' '.repeat(this.indent) :
				typeof this.indent === 'string' ? this.indent :
					'\t';
		const newline = !this.indent ? '' : '\n';
		this.flattenPageTree();
		this.groupPageTree();
		this.resetObjectIds();
		this.pdfTree['/Root']['/Version'] = `/${this.pdfVersion}`;
		const indirectObjects = [];
		const newPdfObject = (jsObject, depth = 0, nextIndent = true) => {
			if (nextIndent === true) {
				nextIndent = newline + space.repeat(depth);
			}
			let pdfObject = '';
			if (typeof jsObject === 'string') {
				const firstChar = jsObject[0], lastChar = jsObject[jsObject.length - 1];
				if (firstChar === '/') {
					const encodeChar = (char) => '\0\t\n\f\r #%()/<>[]{}'.indexOf(char) === -1 ?
						char : `#${`0${char.charCodeAt(0).toString(16)}`.slice(-2)}`;
					pdfObject = `/${jsObject.slice(1).replace(/./g, encodeChar)}`;
				}
				else if (firstChar === '(' && lastChar === ')') {
					const byteArray = Array.from(arraysToBytes(jsObject.slice(1, -1)));
					const stringEncode = byteArray.map((byte) => stringByteMap[byte]).join('');
					if (stringEncode.length < byteArray.length * 2) {
						pdfObject = `(${stringEncode})`;
					}
					else {
						const hexEncode = byteArray.map((byte) => `0${byte.toString(16)}`.slice(-2)).join('');
						pdfObject = `<${hexEncode}>`;
					}
				}
				else {
					pdfObject = jsObject;
				}
			}
			else if (typeof jsObject !== 'object' || jsObject === null) {
				pdfObject = jsObject === null || jsObject === undefined ? 'null' :
					jsObject === true ? 'true' :
						jsObject === false ? 'false' :
							jsObject + '';
			}
			else if (jsObject instanceof Array) {
				const arrayItems = jsObject
				.map((item, index) => newPdfObject(item, depth + 1, !!space || !!index))
				.join('');
				pdfObject = `[${arrayItems}${newline}${space.repeat(depth)}]`;
			}
			else if (typeof jsObject.num === 'number' && indirectObjects[jsObject.num] !== undefined) {
				pdfObject = `${jsObject.num} ${jsObject.gen} R`;
			}
			else {
				if (typeof jsObject.num === 'number') {
					indirectObjects[jsObject.num] = null;
					pdfObject = `${jsObject.num} ${jsObject.gen} obj${newline}`;
					depth = 0;
					if (typeof jsObject.stream !== 'undefined') {
						if (jsObject.stream.length) {
							if (this.compress && !jsObject['/Filter']) {
								const compressedStream = deflate(arraysToBytes([jsObject.stream]));
								if (compressedStream.length + 19 < jsObject.stream.length) {
									jsObject.stream = compressedStream;
									jsObject['/Filter'] = '/FlateDecode';
								}
							}
						}
						jsObject['/Length'] = jsObject.stream.length;
					}
				}
				const dictItems = Object.keys(jsObject)
				.filter((key) => key[0] === '/')
				.map(key => newPdfObject(key, depth + 1) +
					newPdfObject(jsObject[key], depth + 1, !!space ? ' ' : ''))
				.join('');
				pdfObject += `<<${dictItems}${newline}${space.repeat(depth)}>>`;
				if (typeof jsObject.num === 'number') {
					if (typeof jsObject.stream !== 'undefined') {
						if (jsObject.stream.length) {
							const streamPrefix = `${pdfObject}${newline}stream\n`;
							const streamSuffix = `${newline}endstream\nendobj\n`;
							pdfObject = arraysToBytes([streamPrefix, jsObject.stream, streamSuffix]);
						}
						else {
							pdfObject += `${newline}stream\nendstream\nendobj\n`;
						}
					}
					else {
						pdfObject += `${newline}endobj\n`;
					}
					indirectObjects[jsObject.num] = pdfObject;
					pdfObject = `${jsObject.num} ${jsObject.gen} R`;
				}
			}
			const prefix = nextIndent ? nextIndent :
				nextIndent === false || ['/', '[', '(', '<'].includes(pdfObject[0]) ? '' : ' ';
			return prefix + pdfObject;
		};
		const rootRef = newPdfObject(this.pdfTree['/Root'], 0, false);
		this.pdfTree['/Info'].gen = 0;
		this.pdfTree['/Info'].num = this.nextNodeNum++;
		const infoRef = this.pdfTree['/Info'] && Object.keys(this.pdfTree['/Info']).length ?
			newPdfObject(this.pdfTree['/Info'], 0, false) : null;
		const header = `%PDF-${this.pdfVersion}\n` +
			`%âãÏÓ\n`;
		let offset = 0;
		const xref = `xref\n` +
			`0 ${indirectObjects.length}\n` +
			`0000000000 65535 f \n` +
			[header, ...indirectObjects]
			.filter(o => o)
			.map(o => (`0000000000${offset += o.length} 00000 n \n`).slice(-20))
			.slice(0, -1)
			.join('');
		const trailer = `trailer\n` +
			`<<${newline}` +
			`${space}/Root ${rootRef}${newline}` +
			(infoRef ? `${space}/Info ${infoRef}${newline}` : '') +
			`${space}/Size ${indirectObjects.length}${newline}` +
			`>>\n` +
			`startxref\n` +
			`${offset}\n` +
			`%%EOF\n`;
		const pdfData = arraysToBytes([header, ...indirectObjects.filter(o => o), xref, trailer]);
		switch (nameOrOutputFormat) {
			case 'ArrayBuffer':
				return pdfData.buffer;
				break;
			case 'Uint8Array':
				return pdfData;
				break;
			default:
				if (nameOrOutputFormat.slice(-4) !== '.pdf') {
					nameOrOutputFormat += '.pdf';
				}
				return pdfData;
		}

	}

	arraysToBytes(arrays) {
		return arraysToBytes(arrays);
	}

	bytesToString(bytes) {
		return bytesToString(bytes);
	}
}

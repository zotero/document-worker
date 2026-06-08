import {
	writeAnnotations,
	importAnnotations,
	deletePages,
	rotatePages,
	getFulltext,
	getRecognizerData,
	getStructure as pdfGetStructure,
	importCitaviAnnotations,
	importMendeleyAnnotations,
	hasAnnotations,
	renderAnnotations,
	renderArea
} from './pdf/index.js';
import { canvasToPNGArrayBuffer } from './pdf/render-runtime.js';
import { getEpubStructure } from './dom/epub/index';
import { getSnapshotStructure } from './dom/snapshot/index';
import { packStructuredDocumentText } from '../structured-document-text/src/pack/writer.js';
import { deflateSync } from 'fflate';

const EPUB_CONTENT_TYPE = 'application/epub+zip';
const SOURCE_HASH_RE = /^[0-9a-f]{32}$/u;

function isEpub(contentType) {
	return contentType === EPUB_CONTENT_TYPE;
}

function isSnapshot(contentType) {
	return contentType === 'application/xhtml+xml' || contentType?.endsWith('html');
}

function assertSourceHash(value) {
	if (typeof value !== 'string' || !SOURCE_HASH_RE.test(value)) {
		throw new Error('options.sourceHash must be a 32-character lowercase MD5 hex string');
	}
}

async function createStructuredDocumentText(buf, options = {}) {
	let {
		contentType,
		password,
		dataProvider,
		sourceHash,
	} = options;
	assertSourceHash(sourceHash);

	if (isEpub(contentType) || isSnapshot(contentType)) {
		return isEpub(contentType)
			? await getEpubStructure(buf, { sourceHash })
			: await getSnapshotStructure(buf, contentType, { sourceHash });
	}
	return await pdfGetStructure(buf, password, dataProvider, {
		sourceHash,
	});
}

async function getStructuredDocumentText(buf, options = {}) {
	let structure = await createStructuredDocumentText(buf, {
		contentType: options.contentType,
		password: options.password,
		dataProvider: options.dataProvider,
		sourceHash: options.sourceHash,
	});
	let buffer = packStructuredDocumentText(structure, {
		destructive: true,
		deflate: bytes => deflateSync(bytes),
	});
	return { buf: buffer };
}

const pdf = {
	writeAnnotations,
	importAnnotations,
	deletePages,
	rotatePages,
	getFulltext,
	getRecognizerData,
	importCitaviAnnotations,
	importMendeleyAnnotations,
	hasAnnotations,
	renderAnnotations,
	renderArea,
};

export {
	pdf,
	getStructuredDocumentText,
};

function errObject(err) {
	return JSON.parse(JSON.stringify(err, Object.getOwnPropertyNames(err)));
}

let dataCache = {};
async function fetchData(path) {
	if (dataCache[path]) {
		return dataCache[path];
	}
	let data = await query('FetchData', path);
	dataCache[path] = data;
	return data;
}

async function renderedAnnotationSaver(libraryID, annotationKey, buf) {
	return await query('SaveRenderedAnnotation', { libraryID, annotationKey, buf }, [buf]);
}

if (typeof self !== 'undefined') {
	let promiseID = 0;
	let waitingPromises = {};

	self.query = async function (action, data, transfer) {
		return new Promise(function (resolve) {
			promiseID++;
			waitingPromises[promiseID] = resolve;
			self.postMessage({ id: promiseID, action, data }, transfer);
		});
	};

	self.onmessage = async function (e) {
		let message = e.data;

		if (message.responseID) {
			let resolve = waitingPromises[message.responseID];
			if (resolve) {
				resolve(message.data);
			}
			return;
		}

		if (message.action === 'pdf.writeAnnotations') {
			let buf;
			try {
				buf = await writeAnnotations(
					message.data.buf,
					message.data.annotations,
					message.data.password,
					fetchData
				);
				self.postMessage({ responseID: message.id, data: { buf } }, [buf]);
			}
			catch (e) {
				console.log(e);
				self.postMessage({
					responseID: message.id,
					error: errObject(e)
				}, []);
			}
		}
		else if (message.action === 'pdf.importAnnotations') {
			try {
				let { buf, existingAnnotations, password, transfer } = message.data;
				let data = await importAnnotations(
					buf,
					existingAnnotations,
					password,
					transfer,
					fetchData
				);
				self.postMessage({ responseID: message.id, data }, data.buf ? [data.buf] : []);
			}
			catch (e) {
				self.postMessage({
					responseID: message.id,
					error: errObject(e)
				}, []);
			}
		}
		else if (message.action === 'pdf.importMendeleyAnnotations') {
			try {
				let annotations = await importMendeleyAnnotations(
					message.data.buf,
					message.data.mendeleyAnnotations,
					message.data.password,
					fetchData
				);
				self.postMessage({
					responseID: message.id,
					data: annotations
				}, []);
			}
			catch (e) {
				self.postMessage({
					responseID: message.id,
					error: errObject(e)
				}, []);
			}
		}
		else if (message.action === 'pdf.importCitaviAnnotations') {
			try {
				let annotations = await importCitaviAnnotations(
					message.data.buf,
					message.data.citaviAnnotations,
					message.data.password,
					fetchData
				);
				self.postMessage({
					responseID: message.id,
					data: annotations
				}, []);
			}
			catch (e) {
				self.postMessage({
					responseID: message.id,
					error: errObject(e)
				}, []);
			}
		}
		else if (message.action === 'pdf.deletePages') {
			try {
				let buf = await deletePages(message.data.buf, message.data.pageIndexes, message.data.password);
				self.postMessage({ responseID: message.id, data: { buf } }, [buf]);
			}
			catch (e) {
				self.postMessage({
					responseID: message.id,
					error: errObject(e)
				}, []);
			}
		}
		else if (message.action === 'pdf.rotatePages') {
			try {
				let buf = await rotatePages(
					message.data.buf,
					message.data.pageIndexes,
					message.data.degrees,
					message.data.password
				);
				self.postMessage({ responseID: message.id, data: { buf } }, [buf]);
			}
			catch (e) {
				self.postMessage({
					responseID: message.id,
					error: errObject(e)
				}, []);
			}
		}
		else if (message.action === 'pdf.getFulltext') {
			try {
				let data = await getFulltext(
					message.data.buf,
					message.data.maxPages || message.data.pageIndexes,
					message.data.password,
					fetchData
				);
				self.postMessage({ responseID: message.id, data }, []);
			}
			catch (e) {
				self.postMessage({
					responseID: message.id,
					error: errObject(e)
				}, []);
			}
		}
		else if (message.action === 'pdf.getRecognizerData') {
			try {
				let data = await getRecognizerData(
					message.data.buf,
					message.data.password,
					fetchData
				);
				self.postMessage({ responseID: message.id, data }, []);
			}
			catch (e) {
				self.postMessage({
					responseID: message.id,
					error: errObject(e)
				}, []);
			}
		}
		else if (message.action === 'getStructuredDocumentText') {
			try {
				let data = await getStructuredDocumentText(message.data.buf, {
					contentType: message.data.contentType,
					password: message.data.password,
					dataProvider: fetchData,
					sourceHash: message.data.sourceHash,
				});
				self.postMessage({
					responseID: message.id,
					data
				}, [data.buf]);
			}
			catch (e) {
				self.postMessage({
					responseID: message.id,
					error: errObject(e)
				}, []);
			}
		}
		else if (message.action === 'pdf.renderAnnotations') {
			try {
				let data = await renderAnnotations(
					message.data.libraryID,
					message.data.buf,
					message.data.annotations,
					message.data.password,
					fetchData,
					renderedAnnotationSaver
				);
				self.postMessage({ responseID: message.id, data }, []);
			}
			catch (e) {
				self.postMessage({
					responseID: message.id,
					error: errObject(e)
				}, []);
			}
		}
		else if (message.action === 'pdf.renderArea') {
			try {
				let canvas = await renderArea(
					message.data.buf,
					message.data.pageIndex,
					message.data.rect,
					{
						password: message.data.password,
						scale: message.data.scale,
						dataProvider: fetchData
					}
				);
				if (!canvas) {
					self.postMessage({ responseID: message.id, data: { buf: null } }, []);
					return;
				}
				let buf = await canvasToPNGArrayBuffer(canvas);
				self.postMessage({ responseID: message.id, data: { buf } }, [buf]);
			}
			catch (e) {
				self.postMessage({
					responseID: message.id,
					error: errObject(e)
				}, []);
			}
		}
		else if (message.action === 'pdf.hasAnnotations') {
			try {
				let data = {
					hasAnnotations: await hasAnnotations(
						message.data.buf,
						message.data.password
					)
				};
				self.postMessage({ responseID: message.id, data }, []);
			}
			catch (e) {
				self.postMessage({
					responseID: message.id,
					error: errObject(e)
				}, []);
			}
		}
	};
}

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
	renderAnnotations
} from './pdf/index.js';
import { getEpubStructure } from './dom/epub/index';
import { getSnapshotStructure } from './dom/snapshot/index';

const EPUB_CONTENT_TYPE = 'application/epub+zip';

function isEpub(contentType) {
	return contentType === EPUB_CONTENT_TYPE;
}

function isSnapshot(contentType) {
	return contentType && contentType.endsWith('html');
}

async function getStructuredDocumentText(buf, options = {}) {
	let {
		contentType,
		password,
		dataProvider,
	} = options;

	if (isEpub(contentType)) {
		return getEpubStructure(buf);
	}
	if (isSnapshot(contentType)) {
		return getSnapshotStructure(buf, contentType);
	}
	return await pdfGetStructure(buf, password, dataProvider);
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
				});
				self.postMessage({ responseID: message.id, data }, []);
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

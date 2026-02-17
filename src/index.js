import {
	writeAnnotations,
	importAnnotations,
	deletePages,
	rotatePages,
	getFulltext,
	getRecognizerData,
	getOutline,
	getProcessedData,
	getStructure,
	getPdfManager,
	importCitaviAnnotations,
	importMendeleyAnnotations,
	hasAnnotations,
	renderAnnotations
} from './pdf/index.js';

export {
	writeAnnotations,
	importAnnotations,
	deletePages,
	rotatePages,
	getFulltext,
	getRecognizerData,
	getOutline,
	getProcessedData,
	getStructure,
	getPdfManager,
	importCitaviAnnotations,
	importMendeleyAnnotations,
	hasAnnotations,
	renderAnnotations
};

// Re-export getPages (exported inline in pdf/index.js)
export { getPages } from './pdf/index.js';

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

		if (message.action === 'export') {
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
		else if (message.action === 'import') {
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
		else if (message.action === 'importMendeley') {
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
		else if (message.action === 'importCitavi') {
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
		else if (message.action === 'deletePages') {
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
		else if (message.action === 'rotatePages') {
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
		else if (message.action === 'getFulltext') {
			try {
				let data = await getFulltext(
					message.data.buf,
					message.data.maxPages || message.data.pageIndexes,
					message.data.password,
					fetchData,
					{ structure: message.data.structure }
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
		else if (message.action === 'getRecognizerData') {
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
		else if (message.action === 'getStructuredData') {
			try {
				let data = await getStructure(
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
		else if (message.action === 'renderAnnotations') {
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
		else if (message.action === 'hasAnnotations') {
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

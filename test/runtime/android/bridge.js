/*
    ***** BEGIN LICENSE BLOCK *****

    Copyright © 2025 Corporation for Digital Scholarship
                     Vienna, Virginia, USA
                     https://www.zotero.org

    This file is part of Zotero.

    Zotero is free software: you can redistribute it and/or modify
    it under the terms of the GNU Affero General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    Zotero is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU Affero General Public License for more details.

    You should have received a copy of the GNU Affero General Public License
    along with Zotero.  If not, see <http://www.gnu.org/licenses/>.

    ***** END LICENSE BLOCK *****
*/

var documentWorker;
var assetBaseURL;

var hostPromiseID = 0;
var hostWaitingPromises = {};

function initDocumentWorker(isDebug) {
	assetBaseURL = isDebug
		? "file:///data/data/org.zotero.android.debug/files/document-worker/"
		: "file:///data/data/org.zotero.android/files/document-worker/";

	documentWorker = new Worker(assetBaseURL + "worker.js");
	documentWorker.onmessage = handleWorkerMessage;
	documentWorker.onerror = function (e) {
		sendToPort("documentWorkerError", { message: e.message || String(e) });
	};
	sendToPort("documentWorkerReady", {});
}

function hostQuery(action, data, transfer, onProgress) {
	return new Promise(function (resolve, reject) {
		hostPromiseID++;
		var id = hostPromiseID;
		hostWaitingPromises[id] = { resolve: resolve, reject: reject, onProgress: onProgress };
		documentWorker.postMessage({ id: id, action: action, data: data }, transfer || []);
	});
}

function handleWorkerMessage(e) {
	var message = e.data;

	// A response to a request we (the host) sent to the worker
	if (message.responseID) {
		var waiting = hostWaitingPromises[message.responseID];
		if (waiting) {
			delete hostWaitingPromises[message.responseID];
			if (message.error) {
				waiting.reject(message.error);
			} else {
				waiting.resolve(message.data);
			}
		}
		return;
	}

	if (message.progressID) {
		var progressWaiting = hostWaitingPromises[message.progressID];
		if (progressWaiting && progressWaiting.onProgress) {
			progressWaiting.onProgress(message.data.progress);
		}
		return;
	}

	if (message.action === 'FetchData') {
		fetchLocal(assetBaseURL + message.data).then(function (buf) {
			documentWorker.postMessage({ responseID: message.id, data: new Uint8Array(buf) }, [buf]);
		}).catch(function (err) {
			documentWorker.postMessage({ responseID: message.id, error: { message: String(err) } });
		});
		return;
	}
	if (message.action === 'SaveRenderedAnnotation') {
		documentWorker.postMessage({ responseID: message.id, data: null });
		return;
	}
	if (message.action === 'NativeONNXRun') {
		documentWorker.postMessage({ responseID: message.id, error: { message: 'NativeONNXRun not supported' } });
		return;
	}

	log("Unhandled document worker message: " + JSON.stringify(message));
}

function log(data) {
	sendToPort("logHandler", data);
}

window.generateSDT = function (requestId, pdfFileUrl, contentType, sourceHash, password) {
	(async function () {
		try {
			var buf = await fetchLocal(pdfFileUrl);
			var result = await hostQuery('getStructuredDocumentText', {
				buf: buf,
				contentType: contentType,
				password: password || null,
				sourceHash: sourceHash,
				reportProgress: true,
			}, [buf], function (progress) {
				sendToPort('sdtProgress', { requestId: requestId, progress: progress });
			});
			var bytes = arrayBufferToBase64(result.buf);
			sendToPort('sdtResult', { requestId: requestId, bytes: bytes });
		} catch (error) {
			sendToPort('sdtError', { requestId: requestId, message: (error && error.message) || String(error) });
		}
	})();
};

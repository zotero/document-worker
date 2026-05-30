import * as pdfjsWorker from '../../pdf.js/src/pdf.worker.js';
import * as pdfjs from '../../pdf.js/src/pdf.js';
import {
	canvasToPNGArrayBuffer,
	createCanvas,
	createCanvasFactory,
	createOwnerDocument,
} from './render-runtime.js';

globalThis.pdfjsWorker = pdfjsWorker;

const SCALE = 4;
const PATH_BOX_PADDING = 10; // pt
const MIN_PATH_BOX_SIZE = 30; // pt
const MAX_CANVAS_PIXELS = 16777216; // 16 megapixels

function p2v(position, viewport) {
	if (position.rects) {
		return {
			pageIndex: position.pageIndex,
			rects: position.rects.map((rect) => {
				let [x1, y2] = viewport.convertToViewportPoint(rect[0], rect[1]);
				let [x2, y1] = viewport.convertToViewportPoint(rect[2], rect[3]);
				return [
					Math.min(x1, x2),
					Math.min(y1, y2),
					Math.max(x1, x2),
					Math.max(y1, y2)
				];
			})
		};
	}
	else if (position.paths) {
		return {
			pageIndex: position.pageIndex,
			width: position.width * viewport.scale,
			paths: position.paths.map((path) => {
				let vpath = [];
				for (let i = 0; i < path.length - 1; i += 2) {
					let x = path[i];
					let y = path[i + 1];
					vpath.push(...viewport.convertToViewportPoint(x, y));
				}
				return vpath;
			})
		};
	}
}

function fitRectIntoRect(rect, containingRect) {
	return [
		Math.max(rect[0], containingRect[0]),
		Math.max(rect[1], containingRect[1]),
		Math.min(rect[2], containingRect[2]),
		Math.min(rect[3], containingRect[3])
	];
}

function getPositionBoundingRect(position) {
	if (position.rects) {
		return [
			Math.min(...position.rects.map(x => x[0])),
			Math.min(...position.rects.map(x => x[1])),
			Math.max(...position.rects.map(x => x[2])),
			Math.max(...position.rects.map(x => x[3]))
		];
	}
	else if (position.paths) {
		let x = position.paths[0][0];
		let y = position.paths[0][1];
		let rect = [x, y, x, y];
		for (let path of position.paths) {
			for (let i = 0; i < path.length - 1; i += 2) {
				let x = path[i];
				let y = path[i + 1];
				rect[0] = Math.min(rect[0], x);
				rect[1] = Math.min(rect[1], y);
				rect[2] = Math.max(rect[2], x);
				rect[3] = Math.max(rect[3], y);
			}
		}
		return rect;
	}
}

async function getRenderablePdfDocument(source, password, dataProvider, pdfOptions = {}) {
	if (source?.getPage) {
		return {
			pdfDocument: source,
			cleanup: async () => {},
		};
	}

	let document = await createOwnerDocument();
	let CanvasFactory = await createCanvasFactory();
	let options = {
		data: new Uint8Array(source).buffer,
		ownerDocument: document,
		CanvasFactory,
		cMapUrl: pdfOptions.cMapUrl || null,
		cMapPacked: true,
		standardFontDataUrl: pdfOptions.standardFontDataUrl || null,
		wasmUrl: pdfOptions.wasmUrl || null,
		useWorkerFetch: false,
		disableFontFace: false,
		password,
	};

	if (dataProvider) {
		options.CMapReaderFactory = function () {
			this.fetch = async ({ name }) => {
				let raw = await dataProvider('cmaps/' + name + '.bcmap');
				return { cMapData: raw, isCompressed: true };
			};
		};
		options.StandardFontDataFactory = function () {
			this.fetch = async ({ filename }) => dataProvider('standard_fonts/' + filename);
		};
		options.WasmFactory = function () {
			this.fetch = async ({ filename }) => dataProvider('wasm/' + filename);
		};
	}

	let pdfDocument = await pdfjs.getDocument(options).promise;
	return {
		pdfDocument,
		cleanup: async () => {
			await pdfDocument.destroy?.();
			document.releaseNodeFonts?.();
		},
	};
}

export async function openRenderablePdfDocument(source, password, dataProvider, pdfOptions = {}) {
	return getRenderablePdfDocument(source, password, dataProvider, pdfOptions);
}

async function renderImage(pdfDocument, annotation) {
	let { position, color } = annotation;

	let page = await pdfDocument.getPage(position.pageIndex + 1);

	// Create a new position that just contains single rect that is a bounding
	// box of image or ink annotations
	let expandedPosition = { pageIndex: position.pageIndex };
	if (position.rects) {
		// Image annotations have only one rect
		expandedPosition.rects = position.rects;
	}
	// paths
	else {
		let rect = getPositionBoundingRect(position);
		rect = [
			rect[0] - PATH_BOX_PADDING,
			rect[1] - PATH_BOX_PADDING,
			rect[2] + PATH_BOX_PADDING,
			rect[3] + PATH_BOX_PADDING
		];

		if (rect[2] - rect[0] < MIN_PATH_BOX_SIZE) {
			let x = rect[0] + (rect[2] - rect[0]) / 2;
			rect[0] = x - MIN_PATH_BOX_SIZE;
			rect[2] = x + MIN_PATH_BOX_SIZE;
		}

		if (rect[3] - rect[1] < MIN_PATH_BOX_SIZE) {
			let y = rect[1] + (rect[3] - rect[1]) / 2;
			rect[1] = y - MIN_PATH_BOX_SIZE;
			rect[3] = y + MIN_PATH_BOX_SIZE;
		}

		expandedPosition.rects = [fitRectIntoRect(rect, page.view)];
	}

	let rect = expandedPosition.rects[0];
	let maxScale = Math.sqrt(
		MAX_CANVAS_PIXELS
		/ ((rect[2] - rect[0]) * (rect[3] - rect[1]))
	);
	let scale = Math.min(SCALE, maxScale);

	expandedPosition = p2v(expandedPosition, page.getViewport({ scale }));
	rect = expandedPosition.rects[0];

	let viewport = page.getViewport({ scale, offsetX: -rect[0], offsetY: -rect[1] });
	position = p2v(position, viewport);

	let canvasWidth = (rect[2] - rect[0]);
	let canvasHeight = (rect[3] - rect[1]);

	if (!canvasWidth || !canvasHeight) {
		return null;
	}

	let canvas = await createCanvas(canvasWidth, canvasHeight);
	let ctx = canvas.getContext('2d', { alpha: false });

	let renderContext = {
		canvasContext: ctx,
		viewport: viewport
	};

	await page.render(renderContext).promise;

	if (position.paths) {
		ctx.lineCap = 'round';
		ctx.lineJoin = 'round';
		ctx.lineWidth = position.width;
		ctx.beginPath();
		ctx.strokeStyle = color;
		for (let path of position.paths) {
			for (let i = 0; i < path.length - 1; i += 2) {
				let x = path[i];
				let y = path[i + 1];

				if (i === 0) {
					ctx.moveTo(x, y);
				}
				ctx.lineTo(x, y);
			}
		}
		ctx.stroke();
	}

	return canvas;
}

export async function renderArea(pdfDocument, pageIndex, rect, options = {}) {
	let scale = options.scale || SCALE;
	let renderablePdf = await getRenderablePdfDocument(
		pdfDocument,
		options.password,
		options.dataProvider,
		options
	);
	pdfDocument = renderablePdf.pdfDocument;

	try {
		let page = await pdfDocument.getPage(pageIndex + 1);
		rect = fitRectIntoRect(rect, page.view);

		let width = rect[2] - rect[0];
		let height = rect[3] - rect[1];
		if (!width || !height) {
			return null;
		}

		let maxScale = Math.sqrt(MAX_CANVAS_PIXELS / (width * height));
		scale = Math.min(scale, maxScale);

		let position = { pageIndex, rects: [rect] };
		let viewport = page.getViewport({ scale });
		position = p2v(position, viewport);
		let vRect = position.rects[0];

		let offsetViewport = page.getViewport({ scale, offsetX: -vRect[0], offsetY: -vRect[1] });

		let canvasWidth = vRect[2] - vRect[0];
		let canvasHeight = vRect[3] - vRect[1];
		if (!canvasWidth || !canvasHeight) {
			return null;
		}

		let canvas = await createCanvas(canvasWidth, canvasHeight);
		let ctx = canvas.getContext('2d', { alpha: false });
		await page.render({ canvasContext: ctx, viewport: offsetViewport }).promise;

		return canvas;
	}
	finally {
		await renderablePdf.cleanup();
	}
}

export async function renderAnnotations(libraryID, buf, annotations, password, dataProvider, renderedAnnotationSaver) {
	let renderablePdf = await getRenderablePdfDocument(buf, password, dataProvider);
	let pdfDocument = renderablePdf.pdfDocument;

	try {
		let num = 0;
		for (let annotation of annotations) {
			let canvas = await renderImage(pdfDocument, annotation);
			let image = await canvasToPNGArrayBuffer(canvas);
			if (!await renderedAnnotationSaver(libraryID, annotation.id, image)) {
				throw new Error('Failed to save rendered annotation');
			}
			num++;
		}
		return num;
	}
	finally {
		await renderablePdf.cleanup();
	}
}

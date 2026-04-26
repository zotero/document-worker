const PNG_TYPE = 'image/png';

let nodeCanvasModulePromise;
let nodeRuntimeModulesPromise;

function dynamicImport(specifier) {
	return new Function('specifier', 'return import(specifier)')(specifier);
}

function isNodeRuntime() {
	return typeof process !== 'undefined' && !!process.versions?.node;
}

async function loadNodeCanvasModule() {
	if (!nodeCanvasModulePromise) {
		nodeCanvasModulePromise = dynamicImport('canvas').catch((err) => {
			throw new Error('PDF rendering in Node.js requires the canvas package', { cause: err });
		});
	}
	return nodeCanvasModulePromise;
}

async function loadNodeRuntimeModules() {
	if (!nodeRuntimeModulesPromise) {
		nodeRuntimeModulesPromise = Promise.all([
			dynamicImport('node:fs'),
			dynamicImport('node:os'),
			dynamicImport('node:path'),
		]).then(([fs, os, path]) => ({ fs, os, path }));
	}
	return nodeRuntimeModulesPromise;
}

function patchNodeCanvas(canvas) {
	if (!canvas.convertToBlob && typeof canvas.toBuffer === 'function') {
		canvas.convertToBlob = async (options = {}) => {
			let type = options.type || PNG_TYPE;
			return new Blob([canvas.toBuffer(type)], { type });
		};
	}
	return canvas;
}

function createBrowserCanvas(width, height, ownerDocument) {
	let canvas;
	if (typeof OffscreenCanvas !== 'undefined') {
		canvas = new OffscreenCanvas(width, height);
	}
	else {
		let doc = ownerDocument || globalThis.document;
		if (!doc?.createElement) {
			return null;
		}
		canvas = doc.createElement('canvas');
		canvas.width = width;
		canvas.height = height;
	}
	return canvas;
}

function createNodeCanvas(width, height, nodeCanvasModule) {
	return patchNodeCanvas(nodeCanvasModule.createCanvas(width, height));
}

function createNodeElement(name) {
	return {
		nodeName: name.toUpperCase(),
		style: {},
		children: [],
		append(...nodes) {
			this.children.push(...nodes);
		},
		remove() {},
		set textContent(value) {
			this._textContent = value;
		},
		get textContent() {
			return this._textContent || '';
		},
	};
}

function parseFontFaceRule(rule) {
	let family = rule.match(/font-family:\s*"([^"]+)"/u)?.[1];
	let source = rule.match(/src:\s*url\(data:([^;,]+);base64,([^)]*)\)/u);
	if (!family || !source) {
		return null;
	}
	return {
		family,
		mimeType: source[1],
		data: source[2],
		weight: rule.match(/font-weight:\s*([^;]+);/u)?.[1],
		style: rule.match(/font-style:\s*([^;]+);/u)?.[1],
	};
}

function getFontExtension(mimeType) {
	if (mimeType.includes('truetype')) {
		return '.ttf';
	}
	if (mimeType.includes('opentype')) {
		return '.otf';
	}
	return '.font';
}

function normalizeFontStyle(style) {
	if (!style) {
		return 'normal';
	}
	if (style.startsWith('italic')) {
		return 'italic';
	}
	if (style.startsWith('oblique')) {
		return 'oblique';
	}
	return style;
}

function createNodeFontStore(nodeRuntimeModules) {
	let { fs, os, path } = nodeRuntimeModules;
	return {
		fs,
		path,
		dir: fs.mkdtempSync(path.join(os.tmpdir(), 'document-worker-fonts-')),
		index: 0,
	};
}

function releaseNodeFontStore(fontStore) {
	fontStore.fs.rmSync(fontStore.dir, { force: true, recursive: true });
}

function registerNodeFont(rule, nodeCanvasModule, fontStore) {
	let font = parseFontFaceRule(rule);
	if (!font) {
		return;
	}

	let filePath = fontStore.path.join(fontStore.dir, `${fontStore.index++}${getFontExtension(font.mimeType)}`);
	fontStore.fs.writeFileSync(filePath, Buffer.from(font.data, 'base64'));
	nodeCanvasModule.registerFont(filePath, {
		family: font.family,
		weight: font.weight || 'normal',
		style: normalizeFontStyle(font.style),
	});
}

function createNodeStyleElement(nodeCanvasModule, getFontStore) {
	return {
		sheet: {
			cssRules: [],
			insertRule(rule, index) {
				registerNodeFont(rule, nodeCanvasModule, getFontStore());
				this.cssRules.splice(index, 0, rule);
			},
		},
		remove() {
			this.sheet.cssRules = [];
		},
	};
}

function createNodeOwnerDocument(nodeCanvasModule, nodeRuntimeModules) {
	let head = createNodeElement('head');
	let body = createNodeElement('body');
	let fontStore;
	let getFontStore = () => fontStore || (fontStore = createNodeFontStore(nodeRuntimeModules));
	return {
		fonts: undefined,
		body,
		releaseNodeFonts() {
			if (fontStore) {
				releaseNodeFontStore(fontStore);
				fontStore = null;
			}
		},
		documentElement: {
			getElementsByTagName(name) {
				return name === 'head' ? [head] : [];
			},
		},
		createElement(name) {
			if (name === 'canvas') {
				return createCanvasSync(1, 1, { nodeCanvasModule });
			}
			if (name === 'style') {
				return createNodeStyleElement(nodeCanvasModule, getFontStore);
			}
			return createNodeElement(name);
		},
	};
}

function createCanvasSync(width, height, { ownerDocument, nodeCanvasModule } = {}) {
	if (width <= 0 || height <= 0) {
		throw new Error('Invalid canvas size');
	}
	if (nodeCanvasModule) {
		return createNodeCanvas(width, height, nodeCanvasModule);
	}
	let canvas = createBrowserCanvas(width, height, ownerDocument);
	if (!canvas) {
		throw new Error('PDF rendering requires OffscreenCanvas, document.createElement("canvas"), or the canvas package');
	}
	return canvas;
}

export async function createCanvas(width, height, options = {}) {
	let nodeCanvasModule = isNodeRuntime() ? await loadNodeCanvasModule() : null;
	return createCanvasSync(width, height, { ...options, nodeCanvasModule });
}

export async function createOwnerDocument() {
	let nodeCanvasModule = isNodeRuntime() ? await loadNodeCanvasModule() : null;
	if (nodeCanvasModule) {
		let nodeRuntimeModules = await loadNodeRuntimeModules();
		return createNodeOwnerDocument(nodeCanvasModule, nodeRuntimeModules);
	}
	if (!nodeCanvasModule && typeof document !== 'undefined') {
		return document;
	}
	return {
		fonts: globalThis.fonts,
		createElement(name) {
			if (name === 'canvas') {
				return createCanvasSync(1, 1, { nodeCanvasModule });
			}
			throw new Error(`Unexpected element name "${name}"`);
		},
	};
}

export async function createCanvasFactory() {
	let nodeCanvasModule = isNodeRuntime() ? await loadNodeCanvasModule() : null;
	return class RuntimeCanvasFactory {
		#enableHWA;
		#ownerDocument;

		constructor({ ownerDocument, enableHWA = false } = {}) {
			this.#ownerDocument = ownerDocument;
			this.#enableHWA = enableHWA;
		}

		create(width, height) {
			let canvas = createCanvasSync(width, height, {
				ownerDocument: this.#ownerDocument,
				nodeCanvasModule,
			});
			return {
				canvas,
				context: canvas.getContext('2d', {
					willReadFrequently: !this.#enableHWA,
				}),
			};
		}

		reset(canvasAndContext, width, height) {
			if (!canvasAndContext.canvas) {
				throw new Error('Canvas is not specified');
			}
			if (width <= 0 || height <= 0) {
				throw new Error('Invalid canvas size');
			}
			canvasAndContext.canvas.width = width;
			canvasAndContext.canvas.height = height;
		}

		destroy(canvasAndContext) {
			if (!canvasAndContext.canvas) {
				throw new Error('Canvas is not specified');
			}
			canvasAndContext.canvas.width = 0;
			canvasAndContext.canvas.height = 0;
			canvasAndContext.canvas = null;
			canvasAndContext.context = null;
		}
	};
}

export async function canvasToPNGArrayBuffer(canvas) {
	if (typeof canvas.convertToBlob === 'function') {
		let blob = await canvas.convertToBlob({ type: PNG_TYPE });
		return blob.arrayBuffer();
	}
	if (typeof canvas.toBlob === 'function') {
		let blob = await new Promise((resolve, reject) => {
			canvas.toBlob((result) => result ? resolve(result) : reject(new Error('Failed to encode canvas')), PNG_TYPE);
		});
		return blob.arrayBuffer();
	}
	if (typeof canvas.toBuffer === 'function') {
		let buf = canvas.toBuffer(PNG_TYPE);
		return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
	}
	throw new Error('Canvas does not support PNG encoding');
}

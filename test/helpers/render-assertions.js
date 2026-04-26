import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createCanvas, loadImage } from 'canvas';

export const pdfTextCropRenderContract = {
	fixture: ['pdf', 'full', '1.pdf'],
	pageIndex: 0,
	rect: [231.284, 402.126, 293.107, 410.142],
	width: 247,
	height: 32,
	minDarkPixels: 100,
	maxEmptyColumnRatio: 1 / 3,
};

function assertPNGBuffer(buf) {
	let bytes = new Uint8Array(buf);
	assert.ok(bytes.length > 100);
	assert.deepEqual(Array.from(bytes.subarray(0, 8)), [137, 80, 78, 71, 13, 10, 26, 10]);
}

export function getDarkPixelStats({ data, width, height }) {
	let darkPixels = 0;
	let darkColumns = new Set();
	for (let i = 0; i < data.length; i += 4) {
		let alpha = data[i + 3];
		let luminance = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
		if (alpha > 0 && luminance < 245) {
			darkPixels++;
			darkColumns.add((i / 4) % width);
		}
	}
	return {
		width,
		height,
		darkPixels,
		emptyColumns: width - darkColumns.size,
	};
}

export function getCanvasDarkPixelStats(canvas) {
	let ctx = canvas.getContext('2d');
	let imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
	return getDarkPixelStats({
		data: imageData.data,
		width: canvas.width,
		height: canvas.height,
	});
}

export function assertRenderedTextCropStats(stats, contract = pdfTextCropRenderContract) {
	assert.equal(stats.width, contract.width);
	assert.equal(stats.height, contract.height);
	assert.ok(stats.darkPixels > contract.minDarkPixels);
	assert.ok(stats.emptyColumns < contract.width * contract.maxEmptyColumnRatio);
}

export function assertRenderedTextCropCanvas(canvas, contract = pdfTextCropRenderContract) {
	assertRenderedTextCropStats(getCanvasDarkPixelStats(canvas), contract);
}

export async function assertRenderedTextCropPNG(buf, contract = pdfTextCropRenderContract) {
	assertPNGBuffer(buf);
	let image = await loadImage(Buffer.from(buf));
	let canvas = createCanvas(image.width, image.height);
	let ctx = canvas.getContext('2d');
	ctx.drawImage(image, 0, 0);
	assertRenderedTextCropCanvas(canvas, contract);
}

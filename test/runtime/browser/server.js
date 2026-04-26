import fs from 'node:fs';
import http from 'node:http';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const repoDir = resolve(__dirname, '../../..');

const MIME_TYPES = {
	'.bcmap': 'application/octet-stream',
	'.html': 'text/html; charset=utf-8',
	'.js': 'application/javascript; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.onnx': 'application/octet-stream',
	'.pdf': 'application/pdf',
	'.wasm': 'application/wasm',
	'.epub': 'application/epub+zip',
};

export function createStaticServer() {
	return http.createServer((req, res) => {
		try {
			let url = new URL(req.url || '/', 'http://127.0.0.1');
			let pathname = decodeURIComponent(url.pathname);
			if (pathname === '/') {
				res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
				res.end('<!doctype html><meta charset="utf-8"><title>browser runtime</title>');
				return;
			}

			let filePath = resolve(repoDir, pathname.slice(1));
			if (filePath !== repoDir && !filePath.startsWith(repoDir + sep)) {
				res.writeHead(403);
				res.end('Forbidden');
				return;
			}

			let data = fs.readFileSync(filePath);
			res.writeHead(200, {
				'Content-Type': MIME_TYPES[extname(filePath)] || 'application/octet-stream',
			});
			res.end(data);
		}
		catch (err) {
			res.writeHead(err.code === 'ENOENT' ? 404 : 500);
			res.end(err.message);
		}
	});
}

export async function listen(server) {
	await new Promise((resolveListen, rejectListen) => {
		server.once('error', rejectListen);
		server.listen(0, '127.0.0.1', () => {
			server.off('error', rejectListen);
			resolveListen();
		});
	});
	let address = server.address();
	return `http://${address.address}:${address.port}`;
}

export async function close(server) {
	await new Promise((resolveClose, rejectClose) => {
		server.close((err) => err ? rejectClose(err) : resolveClose());
	});
}

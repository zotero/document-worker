import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import * as esbuild from 'esbuild';

const outfile = 'build/structured-document-text.js';

await mkdir(dirname(outfile), { recursive: true });

await esbuild.build({
	entryPoints: ['structured-document-text/src/read.js'],
	bundle: true,
	platform: 'browser',
	target: ['firefox140'],
	format: 'cjs',
	outfile,
});

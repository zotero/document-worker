import fs from 'node:fs';
import { resolve } from 'node:path';
import { repoRoot } from './fixtures.js';

export function dataProvider(path) {
	return fs.readFileSync(resolve(repoRoot, 'build', path));
}

export function trackingDataProvider(paths) {
	return (path) => {
		paths.push(path);
		return dataProvider(path);
	};
}

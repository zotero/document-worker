import { mkdir, writeFile } from 'node:fs/promises';

import {
	SDT_PACK_VERSION,
	SDT_PROCESSOR_VERSIONS,
	SDT_SCHEMA_VERSION,
} from '../src/versions.js';

let metadata = {
	SDT_SCHEMA_VERSION,
	SDT_PACK_VERSION,
	SDT_PROCESSOR_VERSIONS,
};

await mkdir('build', { recursive: true });
await writeFile('build/metadata.json', `${JSON.stringify(metadata, null, 2)}\n`);

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import stringify from 'json-stringify-pretty-compact';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

import { getSnapshotStructure, getSnapshotFulltext } from '../src/dom/snapshot/index';

function loadSnapshot(name) {
	let filePath = path.join(__dirname, 'snapshots', name);
	let buf = fs.readFileSync(filePath);
	return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

describe('Snapshot structure extraction', () => {
	let structure;

	it('should extract structure from basic HTML', () => {
		let buf = loadSnapshot('basic.html');
		structure = getSnapshotStructure(buf, 'text/html');
		assert.ok(structure);
		assert.equal(structure.processor.type, 'snapshot');
		assert.equal(structure.sourceContentType, 'text/html');
	});

	it('should extract metadata', () => {
		assert.equal(structure.metadata.title, 'Test Snapshot');
		assert.equal(structure.metadata.author, 'Test Author');
		assert.equal(structure.metadata.description, 'A test HTML snapshot');
	});

	it('should have a single page', () => {
		assert.equal(structure.pages.length, 1);
		assert.ok(structure.pages[0].contentRanges.length > 0);
	});

	it('should extract content blocks', () => {
		assert.ok(structure.content.length > 0);

		let headings = structure.content.filter(b => b.type === 'heading');
		assert.ok(headings.length >= 3); // h1, h2, h2, h3 (+ excluded ones still in content)

		let paragraphs = structure.content.filter(b => b.type === 'paragraph');
		assert.ok(paragraphs.length > 0);
	});

	it('should extract inline styles', () => {
		// First paragraph has bold and italic
		let firstPara = structure.content.find(
			b => b.type === 'paragraph' && b.content?.some(t => t.style?.bold)
		);
		assert.ok(firstPara, 'Should have a paragraph with bold text');

		let italicNode = firstPara.content.find(t => t.style?.italic);
		assert.ok(italicNode, 'Should have italic text');
	});

	it('should extract lists', () => {
		let lists = structure.content.filter(b => b.type === 'list');
		assert.ok(lists.length > 0);
		let ul = lists[0];
		assert.equal(ul.ordered, undefined);
		assert.equal(ul.content.length, 3);
		assert.equal(ul.content[0].type, 'listitem');
	});

	it('should extract tables', () => {
		let tables = structure.content.filter(b => b.type === 'table');
		assert.ok(tables.length > 0);
		let table = tables[0];
		assert.equal(table.content.length, 2); // 2 rows
		assert.equal(table.content[0].type, 'tablerow');
		// First row has header cells
		let headerCell = table.content[0].content[0];
		assert.equal(headerCell.header, true);
	});

	it('should extract blockquotes', () => {
		let quotes = structure.content.filter(b => b.type === 'blockquote');
		assert.ok(quotes.length > 0);
	});

	it('should extract preformatted text', () => {
		let pres = structure.content.filter(b => b.type === 'preformatted');
		assert.ok(pres.length > 0);
	});

	it('should extract external links', () => {
		let linkPara = structure.content.find(
			b => b.type === 'paragraph' && b.content?.some(t => t.target?.url)
		);
		assert.ok(linkPara, 'Should have paragraph with a link');
		let linkNode = linkPara.content.find(t => t.target?.url);
		assert.equal(linkNode.target.url, 'https://example.com');
	});

	it('should have character count', () => {
		assert.ok(structure.characterCount > 0);
	});

	it('should have file size', () => {
		assert.ok(structure.fileSize > 0);
	});
});

describe('Snapshot outline', () => {
	let structure;

	it('should build hierarchical outline from headings', () => {
		let buf = loadSnapshot('basic.html');
		structure = getSnapshotStructure(buf, 'text/html');
		assert.ok(structure.outline);
		assert.ok(structure.outline.length > 0);
	});

	it('should exclude headings in nav/aside/footer', () => {
		// The outline should have: Main Title, Section One, Section Two, Subsection
		// But NOT: Navigation Heading, Sidebar Heading, Footer Heading
		let allTitles = flattenOutlineTitles(structure.outline);
		assert.ok(allTitles.includes('Main Title'));
		assert.ok(allTitles.includes('Section One'));
		assert.ok(allTitles.includes('Section Two'));
		assert.ok(allTitles.includes('Subsection'));
		assert.ok(!allTitles.includes('Navigation Heading'), 'nav heading should be excluded');
		assert.ok(!allTitles.includes('Sidebar Heading'), 'aside heading should be excluded');
		assert.ok(!allTitles.includes('Footer Heading'), 'footer heading should be excluded');
	});

	it('should nest headings hierarchically', () => {
		// h1 "Main Title" should be top-level
		// h2 "Section One" and "Section Two" should be children of h1
		// h3 "Subsection" should be child of "Section Two"
		let mainTitle = structure.outline.find(item => item.title === 'Main Title');
		assert.ok(mainTitle);
		assert.ok(mainTitle.children);
		assert.ok(mainTitle.children.length >= 2);

		let sectionTwo = mainTitle.children.find(item => item.title === 'Section Two');
		assert.ok(sectionTwo);
		assert.ok(sectionTwo.children);
		let subsection = sectionTwo.children.find(item => item.title === 'Subsection');
		assert.ok(subsection);
	});

	it('should have ref pointing to block indices', () => {
		let mainTitle = structure.outline.find(item => item.title === 'Main Title');
		assert.ok(mainTitle.ref);
		assert.equal(mainTitle.ref.length, 1);
		assert.equal(typeof mainTitle.ref[0], 'number');
		// The ref should point to the heading block
		let block = structure.content[mainTitle.ref[0]];
		assert.equal(block.type, 'heading');
	});
});

describe('Snapshot fulltext extraction', () => {
	it('should extract fulltext', () => {
		let buf = loadSnapshot('basic.html');
		let result = getSnapshotFulltext(buf, 'text/html');
		assert.ok(result.text);
		assert.ok(result.text.includes('Main Title'));
		assert.ok(result.text.includes('bold'));
		assert.ok(result.text.includes('italic'));
		assert.equal(result.totalPages, 1);
	});

	it('should accept pre-computed structure', () => {
		let buf = loadSnapshot('basic.html');
		let structure = getSnapshotStructure(buf, 'text/html');
		let result = getSnapshotFulltext(buf, 'text/html', { structure });
		assert.ok(result.text.includes('Main Title'));
	});
});

describe('Snapshot content type handling', () => {
	it('should work with text/html', () => {
		let buf = loadSnapshot('basic.html');
		let structure = getSnapshotStructure(buf, 'text/html');
		assert.equal(structure.sourceContentType, 'text/html');
	});

	it('should work with application/xhtml+xml', () => {
		let buf = loadSnapshot('basic.html');
		let structure = getSnapshotStructure(buf, 'application/xhtml+xml');
		assert.equal(structure.sourceContentType, 'application/xhtml+xml');
	});
});

function flattenOutlineTitles(items) {
	let titles = [];
	for (let item of items) {
		titles.push(item.title);
		if (item.children) {
			titles.push(...flattenOutlineTitles(item.children));
		}
	}
	return titles;
}

// Auto-discover snapshot tests: each .html with a corresponding .json snapshot.
// Run with UPDATE_SNAPSHOTS=1 to create/update snapshot files.
let snapshotsDir = path.join(__dirname, 'snapshots');
let allHtmlFiles = fs.readdirSync(snapshotsDir).filter(f => f.endsWith('.html'));
let htmlWithSnapshots = allHtmlFiles.filter(
	f => fs.existsSync(path.join(snapshotsDir, f.replace('.html', '.json')))
);

describe('Snapshot structure snapshots', () => {
	if (htmlWithSnapshots.length === 0 && !process.env.UPDATE_SNAPSHOTS) {
		it('no snapshots found — run UPDATE_SNAPSHOTS=1 npm run test:snapshot to generate', () => {
			assert.fail('No .json snapshot files found next to .html files in test/snapshots/');
		});
	}

	for (let file of (process.env.UPDATE_SNAPSHOTS ? allHtmlFiles : htmlWithSnapshots)) {
		let name = file.replace('.html', '');
		let snapshotPath = path.join(snapshotsDir, name + '.json');

		it(file, () => {
			let result = getSnapshotStructure(loadSnapshot(file), 'text/html');

			// Strip non-deterministic fields
			delete result.dateCreated;

			let json = stringify(result, { indent: '\t', maxLength: 100 });

			if (process.env.UPDATE_SNAPSHOTS) {
				fs.writeFileSync(snapshotPath, json + '\n', 'utf8');
			}
			else {
				let expected = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
				assert.deepEqual(result, expected);
			}
		});
	}
});

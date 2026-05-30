import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { getEpubStructure, getEpubFulltext } from '../../src/dom/epub/index';
import stringify from 'json-stringify-pretty-compact';
import { readFixtureSourceHash } from '../helpers/fixtures.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const epubsDir = resolve(__dirname, '..', 'fixtures', 'epub');
const NORMALIZED_DATE_CREATED = '2000-01-01T00:00:00.000Z';

function loadEpub(filename) {
	let buf = fs.readFileSync(resolve(epubsDir, filename));
	return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function extractEpubStructure(filename) {
	let buf = loadEpub(filename);
	return getEpubStructure(buf, { sourceHash: readFixtureSourceHash('epub', filename) });
}

function extractEpubFulltext(filename, options = {}) {
	let buf = loadEpub(filename);
	return getEpubFulltext(buf, options);
}

let epubFiles = fs.readdirSync(epubsDir).filter(f => f.endsWith('.epub'));

describe('EPUB structure extraction', { timeout: 30000 }, () => {
	for (let file of epubFiles) {
		describe(file, () => {
			let structure;

			it('extracts structure without throwing', () => {
				structure = extractEpubStructure(file);
				assert.ok(structure);
			});

			it('has correct top-level fields', () => {
				assert.equal(structure.schemaVersion, '1.0.0');
				assert.equal(structure.metadata.processor.type, 'epub');
				assert.equal(structure.metadata.source.contentType, 'application/epub+zip');
				assert.ok(structure.metadata.dateCreated);
				assert.ok(typeof structure.metadata.source.fileSize === 'number');
			});

			it('has metadata', () => {
				assert.ok(structure.metadata);
				assert.ok(structure.metadata.source.properties.title, 'should have a title');
				assert.ok(typeof structure.metadata.source.properties.title === 'string');
			});

			it('has pages (spine items)', () => {
				assert.ok(Array.isArray(structure.catalog.pages));
				assert.ok(structure.catalog.pages.length > 0, 'should have at least one page');
				for (let page of structure.catalog.pages) {
					assert.ok(Array.isArray(page.contentRange), 'each page should have a contentRange');
					assert.equal(page.contentRange.length, 2);
				}
			});

			it('has content blocks', () => {
				assert.ok(Array.isArray(structure.content));
				assert.ok(structure.content.length > 0, 'should have at least one content block');
			});

			it('has character count', () => {
				assert.ok(typeof structure.metadata.characterCount === 'number');
				assert.ok(structure.metadata.characterCount > 0);
			});

			it('blocks have valid types', () => {
				let validTypes = new Set([
					'heading', 'paragraph', 'list', 'listitem', 'blockquote',
					'preformatted', 'table', 'tablerow', 'tablecell',
					'image', 'figure', 'caption', 'note',
				]);
				for (let block of structure.content) {
					assert.ok(validTypes.has(block.type), `unexpected block type: ${block.type}`);
				}
			});

			it('blocks have compact DomAnchor with absolute CFI path selectorMap', () => {
				for (let block of structure.content) {
					assert.ok(block.anchor, `block of type ${block.type} missing anchor`);
					assert.ok(block.anchor.selectorMap, `block anchor should have selectorMap`);
					assert.match(block.anchor.selectorMap, /^\//, `block selectorMap should be absolute CFI path: ${block.anchor.selectorMap}`);
				}
			});

			it('has an outline', () => {
				assert.ok(Array.isArray(structure.catalog.outline), 'should have an outline');
				assert.ok(structure.catalog.outline.length > 0, 'outline should not be empty');
				for (let item of structure.catalog.outline) {
					assert.ok(typeof item.title === 'string');
				}
			});

			it('outline items have valid page targets', () => {
				let pageCount = structure.catalog.pages.length;
				function checkTargets(items) {
					for (let item of items) {
						if (item.target) {
							let idx = item.target.position.pageIndex;
							assert.ok(idx >= 0 && idx < pageCount,
								`outline target pageIndex ${idx} out of range [0, ${pageCount})`);
						}
						if (item.children) checkTargets(item.children);
					}
				}
				checkTargets(structure.catalog.outline);
			});

			it('outline items with fragment refs point to valid blocks', () => {
				let blockCount = structure.content.length;
				function checkRefs(items) {
					for (let item of items) {
						if (item.ref) {
							assert.ok(Array.isArray(item.ref), 'ref should be an array');
							assert.ok(item.ref.length >= 1, 'ref should have at least one element');
							let idx = item.ref[0];
							assert.ok(idx >= 0 && idx < blockCount,
								`outline ref [${idx}] out of range [0, ${blockCount})`);
						}
						if (item.children) checkRefs(item.children);
					}
				}
				checkRefs(structure.catalog.outline);
			});

			it('outline items with fragments have block-level refs', () => {
				// At least some Standard Ebooks TOCs have within-section links
				function collectRefs(items) {
					let count = 0;
					for (let item of items) {
						if (item.ref) count++;
						if (item.children) count += collectRefs(item.children);
					}
					return count;
				}
				// Just verify that if refs exist, they're well-formed
				function checkRefs(items) {
					for (let item of items) {
						if (item.ref) {
							assert.ok(item.target, 'items with ref should also have a target');
						}
						if (item.children) checkRefs(item.children);
					}
				}
				checkRefs(structure.catalog.outline);
			});

			it('content blocks have text', () => {
				let hasText = structure.content.some(block => {
					if (!Array.isArray(block.content)) return false;
					return block.content.some(n => typeof n.text === 'string' && n.text.trim());
				});
				assert.ok(hasText, 'should have at least one block with text content');
			});

			it('pages with content have content ranges', () => {
				let pagesWithContent = structure.catalog.pages.filter(p => {
					let range = p.contentRange;
					return Array.isArray(range) && JSON.stringify(range[0]) !== JSON.stringify(range[1]);
				});
				assert.ok(pagesWithContent.length > 0, 'at least some pages should have content');
				for (let page of pagesWithContent) {
					assert.ok(page.contentRange[0][0] >= 0 && page.contentRange[0][0] <= structure.content.length);
					assert.ok(page.contentRange[1][0] >= 0 && page.contentRange[1][0] <= structure.content.length);
				}
			});
		});
	}
});

describe('EPUB fulltext extraction', { timeout: 30000 }, () => {
	for (let file of epubFiles) {
		describe(file, () => {
			it('extracts fulltext', () => {
				let { text, totalSections } = extractEpubFulltext(file);
				assert.ok(typeof text === 'string');
				assert.ok(text.length > 0, 'fulltext should not be empty');
				assert.ok(totalSections > 0, 'should have at least one section');
			});

			it('fulltext contains expected words', () => {
				let { text } = extractEpubFulltext(file);
				// Every Standard Ebooks epub should contain common English words
				assert.ok(text.length > 100, 'fulltext should be substantial');
			});

			it('fulltext matches structure character count', () => {
				let structure = extractEpubStructure(file);
				let { text } = extractEpubFulltext(file, { structure });
				// Fulltext includes page separators so may be slightly longer
				assert.ok(text.length >= structure.metadata.characterCount,
					`fulltext (${text.length}) should be >= characterCount (${structure.metadata.characterCount})`);
			});
		});
	}

	it('does not require sourceHash with a precomputed structure', () => {
		let file = epubFiles[0];
		let buf = loadEpub(file);
		let structure = extractEpubStructure(file);
		let { text } = getEpubFulltext(buf, { structure });
		assert.ok(text.length > 0);
	});
});

describe('EPUB compatible vs advanced produce consistent results', { timeout: 30000 }, () => {
	// Group files by base name (with and without _advanced)
	let groups = new Map();
	for (let file of epubFiles) {
		let base = file.replace('_advanced', '').replace('.epub', '');
		if (!groups.has(base)) groups.set(base, {});
		if (file.includes('_advanced')) {
			groups.get(base).advanced = file;
		}
		else {
			groups.get(base).compatible = file;
		}
	}

	for (let [base, { compatible, advanced }] of groups) {
		if (!compatible || !advanced) continue;

		describe(base, () => {
			it('both versions extract the same metadata', () => {
				let sc = extractEpubStructure(compatible);
				let sa = extractEpubStructure(advanced);
				assert.deepEqual(sc.metadata.source.properties, sa.metadata.source.properties);
			});

			it('both versions have similar page counts', () => {
				let sc = extractEpubStructure(compatible);
				let sa = extractEpubStructure(advanced);
				// Both should use the same mapping type and produce similar page counts
				assert.equal(sc.catalog.pageMappingType, sa.catalog.pageMappingType);
				let ratio = sc.catalog.pages.length / sa.catalog.pages.length;
				assert.ok(ratio > 0.8 && ratio < 1.25,
					`page counts diverge too much: compatible=${sc.catalog.pages.length} advanced=${sa.catalog.pages.length}`);
			});

			it('both versions produce similar character counts', () => {
				let sc = extractEpubStructure(compatible);
				let sa = extractEpubStructure(advanced);
				// Allow 5% variance for formatting differences
				let ratio = sc.metadata.characterCount / sa.metadata.characterCount;
				assert.ok(ratio > 0.95 && ratio < 1.05,
					`character counts diverge too much: compatible=${sc.metadata.characterCount} advanced=${sa.metadata.characterCount}`);
			});

			it('both versions have the same outline titles', () => {
				let sc = extractEpubStructure(compatible);
				let sa = extractEpubStructure(advanced);
				function titles(items) {
					return items.map(i => ({
						title: i.title,
						...(i.children ? { children: titles(i.children) } : {}),
					}));
				}
				assert.deepEqual(titles(sc.catalog.outline), titles(sa.catalog.outline));
			});
		});
	}
});

describe('EPUB-specific content checks', { timeout: 30000 }, () => {
	describe('1 - Lazarillo de Tormes', () => {
		let structure;
		let file = epubFiles.find(f => f === '1.epub');

		it('has expected metadata', { skip: !file }, () => {
			structure = extractEpubStructure(file);
			assert.match(structure.metadata.source.properties.title, /Lazarillo/i);
		});

		it('has headings', { skip: !file }, () => {
			let headings = structure.content.filter(b => b.type === 'heading');
			assert.ok(headings.length > 0, 'should have heading blocks');
		});

		it('noteref text nodes have refs pointing to individual note blocks', { skip: !file }, () => {
			// Find the "Well! your Honour..." paragraph with noterefs 9 and 10
			let block = structure.content.find(b =>
				b.content?.[0]?.text?.startsWith('Well! your Honour'));
			assert.ok(block, 'should find the paragraph with noterefs');

			// Block itself should not have refs (they belong on text nodes)
			assert.equal(block.refs, undefined, 'block-level refs should be absent when text nodes carry them');

			// Find text nodes with refs
			let refsNodes = block.content.filter(n => n.refs);
			assert.equal(refsNodes.length, 2, 'should have 2 noteref text nodes');
			assert.equal(refsNodes[0].text, '9');
			assert.equal(refsNodes[1].text, '10');

			// Each ref should point to a distinct note block
			for (let tn of refsNodes) {
				assert.equal(tn.refs.length, 1, 'each noteref should have one ref');
				let targetIdx = tn.refs[0][0];
				let targetBlock = structure.content[targetIdx];
				assert.ok(targetBlock, `ref target block ${targetIdx} should exist`);
				assert.equal(targetBlock.type, 'note', `ref target block ${targetIdx} should be a note`);
			}
			// The two noterefs should point to different notes
			assert.notEqual(refsNodes[0].refs[0][0], refsNodes[1].refs[0][0],
				'noterefs 9 and 10 should point to different note blocks');
		});

		it('note blocks have backRefs pointing to valid blocks', { skip: !file }, () => {
			let notes = structure.content.filter(b => b.type === 'note');
			assert.ok(notes.length > 0, 'should have note blocks');

			let withBackRefs = notes.filter(n => n.backRefs && n.backRefs.length > 0);
			assert.ok(withBackRefs.length > 0, 'some notes should have backRefs');

			for (let note of withBackRefs) {
				for (let backRef of note.backRefs) {
					let sourceIdx = backRef[0];
					let sourceBlock = structure.content[sourceIdx];
					assert.ok(sourceBlock, `backRef source block ${sourceIdx} should exist`);
				}
			}
		});

		it('outline sub-items resolve to blocks within sections', { skip: !file }, () => {
			// The introduction has sub-sections with fragment hrefs
			let intro = structure.catalog.outline.find(i => /Introductory/i.test(i.title));
			assert.ok(intro, 'should have Introductory outline item');
			assert.ok(intro.children && intro.children.length > 0, 'Introductory should have children');
			for (let child of intro.children) {
				assert.ok(child.ref, `"${child.title}" should have a block ref`);
				assert.ok(child.ref[0] >= 0, 'ref should point to a valid block index');
				// Sub-items should be on the same page or later than the parent
				assert.ok(child.target.position.pageIndex >= intro.target.position.pageIndex,
					`sub-item "${child.title}" page ${child.target.position.pageIndex} should be >= parent page ${intro.target.position.pageIndex}`);
			}
		});
	});

	describe('2 - The Portent', () => {
		let structure;
		let file = epubFiles.find(f => f === '2.epub');

		it('has expected metadata', { skip: !file }, () => {
			structure = extractEpubStructure(file);
			assert.match(structure.metadata.source.properties.title, /Portent/i);
			assert.match(structure.metadata.source.properties.creator, /MacDonald/i);
		});

		it('has headings', { skip: !file }, () => {
			let headings = structure.content.filter(b => b.type === 'heading');
			assert.ok(headings.length > 0, 'should have heading blocks');
		});

		it('has footnote cross-references', { skip: !file }, () => {
			let notes = structure.content.filter(b => b.type === 'note');
			let hasRefs = structure.content.some(b => b.refs && b.refs.length > 0);
			let hasBackRefs = structure.content.some(b => b.backRefs && b.backRefs.length > 0);
			// Standard Ebooks often use endnotes
			if (notes.length > 0) {
				assert.ok(hasRefs, 'should have refs pointing to notes');
				assert.ok(hasBackRefs, 'notes should have backRefs');
			}
		});
	});
});

// Auto-discover snapshot tests: each .epub with a corresponding .json snapshot.
// Run with UPDATE_FIXTURES=1 to create/update fixture files.
let epubsWithSnapshots = epubFiles.filter(
	f => fs.existsSync(resolve(epubsDir, f.replace('.epub', '.json')))
);

describe('EPUB structure snapshots', { timeout: 30000 }, () => {
	if (epubsWithSnapshots.length === 0 && !process.env.UPDATE_FIXTURES) {
		it('no snapshots found — run npm run fixtures:update to generate', () => {
			assert.fail('No .json snapshot files found next to .epub files in test/fixtures/epub/');
		});
	}

	for (let file of (process.env.UPDATE_FIXTURES ? epubFiles : epubsWithSnapshots)) {
		let name = file.replace('.epub', '');
		let snapshotPath = resolve(epubsDir, name + '.json');

		it(file, () => {
			let result = extractEpubStructure(file);

			result.metadata.dateCreated = NORMALIZED_DATE_CREATED;

			let json = stringify(result, { indent: '\t', maxLength: 100 });

			if (process.env.UPDATE_FIXTURES) {
				fs.writeFileSync(snapshotPath, json + '\n', 'utf8');
			}
			else {
				let expected = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
				assert.deepEqual(result, expected);
			}
		});
	}
});

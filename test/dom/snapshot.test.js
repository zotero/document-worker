import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import stringify from 'json-stringify-pretty-compact';
import { parseDocument } from 'htmlparser2';
import { getSnapshotStructure, getSnapshotFulltext } from '../../src/dom/snapshot/index';
import { readFixtureSourceHash } from '../helpers/fixtures.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const snapshotsDir = path.join(__dirname, '..', 'fixtures', 'snapshot');
const NORMALIZED_DATE_CREATED = '2000-01-01T00:00:00.000Z';

function load(name) {
	let filePath = path.join(snapshotsDir, name);
	let buf = fs.readFileSync(filePath);
	return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function extractSnapshotStructure(name, contentType = 'text/html') {
	let buf = load(name);
	return getSnapshotStructure(buf, contentType, { sourceHash: readFixtureSourceHash('snapshot', name) });
}

function extractSnapshotFulltext(name, contentType = 'text/html', options = {}) {
	let buf = load(name);
	return getSnapshotFulltext(buf, contentType, options);
}

// Flatten an outline tree into an array of titles (in pre-order).
function outlineTitles(items) {
	let out = [];
	for (let item of items) {
		out.push(item.title);
		if (item.children) out.push(...outlineTitles(item.children));
	}
	return out;
}

// Depth-first concatenation of every text fragment reachable from a block
// tree. Joined with newlines so negative-match assertions can anchor on
// line boundaries if needed.
function allText(blocks) {
	let parts = [];
	function walk(nodes) {
		for (let b of nodes || []) {
			if (typeof b.text === 'string') parts.push(b.text);
			if (Array.isArray(b.content)) walk(b.content);
		}
	}
	walk(blocks);
	return parts.join('\n');
}

// Parse the raw fixture into a domhandler tree and locate <body>.
function parseBody(name) {
	let html = fs.readFileSync(path.join(snapshotsDir, name), 'utf8');
	let doc = parseDocument(html, { xmlMode: false, recognizeSelfClosing: true });
	function findTag(node, tag) {
		for (let c of node.children || []) {
			if (c.type === 'tag' && c.name === tag) return c;
			if (c.type === 'tag') {
				let f = findTag(c, tag);
				if (f) return f;
			}
		}
		return null;
	}
	return findTag(doc, 'body');
}

// Resolve a snapshot-format selector ('tag[:pseudo]' joined by ' > ', or
// '#id' followed by a ' > ' chain) against a domhandler tree rooted at
// `root`. Supports exactly the pseudo classes the selector generator emits:
// :first-child, :last-child, :first-of-type, :last-of-type, :nth-child(N).
function resolveSelector(root, selector) {
	let parts = selector.split(/\s*>\s*/);
	let current = root;
	for (let i = 0; i < parts.length; i++) {
		if (!current) return null;
		let part = parts[i];
		if (part.startsWith('#')) {
			let id = part.slice(1).replace(/\\(.)/g, '$1');
			current = findById(root, id);
			continue;
		}
		let m = /^([a-z0-9]+)(.*)$/i.exec(part);
		if (!m) return null;
		let [, tag, pseudo] = m;
		let children = (current.children || []).filter(c => c.type === 'tag');
		let sameTag = children.filter(c => c.name === tag);
		if (!pseudo) {
			if (sameTag.length !== 1) return null;
			current = sameTag[0];
		}
		else if (pseudo === ':first-child') {
			current = children[0]?.name === tag ? children[0] : null;
		}
		else if (pseudo === ':last-child') {
			let last = children[children.length - 1];
			current = last?.name === tag ? last : null;
		}
		else if (pseudo === ':first-of-type') {
			current = sameTag[0] || null;
		}
		else if (pseudo === ':last-of-type') {
			current = sameTag[sameTag.length - 1] || null;
		}
		else {
			let n = /^:nth-child\((\d+)\)$/.exec(pseudo);
			if (!n) return null;
			let candidate = children[parseInt(n[1]) - 1];
			current = candidate?.name === tag ? candidate : null;
		}
	}
	return current;
}

function findById(root, id) {
	let found = null;
	function walk(node) {
		if (found) return;
		if (node.type === 'tag' && node.attribs?.id === id) { found = node; return; }
		for (let c of node.children || []) walk(c);
	}
	walk(root);
	return found;
}

// Walk every block in a structure and invoke `fn(block)`, including nested
// content arrays.
function forEachBlock(blocks, fn) {
	for (let b of blocks || []) {
		fn(b);
		if (Array.isArray(b.content)) forEachBlock(b.content, fn);
	}
}

describe('Snapshot SDT: document shape', () => {
	let structure;
	before(() => {
		structure = extractSnapshotStructure('2.html');
	});

	it('identifies as a snapshot processor result', () => {
		assert.equal(structure.metadata.processor.type, 'snapshot');
		assert.equal(Number.isInteger(structure.metadata.processor.version), true);
		assert.ok(structure.metadata.processor.version > 0);
	});

	it('records the source content type', () => {
		assert.equal(structure.metadata.source.contentType, 'text/html');
	});

	it('contains a single page with a content range', () => {
		assert.equal(structure.catalog.pages.length, 1);
		assert.deepEqual(structure.catalog.pages[0].contentRange, [[0], [structure.content.length]]);
	});

	it('reports file size and character count', () => {
		assert.ok(structure.metadata.source.fileSize > 0);
		assert.ok(structure.metadata.characterCount > 0);
	});

	it('extracts <title> and <meta name="author"> into metadata', () => {
		assert.equal(structure.metadata.source.properties.title, 'A Long-Form Article About Widgets');
		assert.equal(structure.metadata.source.properties.author, 'Jane Doe');
	});

	it('accepts application/xhtml+xml', () => {
		let xhtml = extractSnapshotStructure('2.html', 'application/xhtml+xml');
		assert.equal(xhtml.metadata.source.contentType, 'application/xhtml+xml');
	});
});

describe('Snapshot SDT: block types', () => {
	let structure;
	before(() => {
		structure = extractSnapshotStructure('1.html');
	});

	it('emits headings for h1-h6', () => {
		let text = allText(structure.content.filter(b => b.type === 'heading'));
		assert.match(text, /Main Title/);
		assert.match(text, /Section One/);
		assert.match(text, /Subsection/);
	});

	it('emits paragraphs', () => {
		assert.ok(structure.content.filter(b => b.type === 'paragraph').length >= 2);
	});

	it('emits unordered lists as list/listitem trees', () => {
		let ul = structure.content.find(b => b.type === 'list');
		assert.ok(ul);
		assert.equal(ul.ordered, undefined);
		assert.equal(ul.content[0].type, 'listitem');
		assert.match(allText([ul]), /Item one/);
	});

	it('emits tables as tablerow/tablecell trees', () => {
		let t = structure.content.find(b => b.type === 'table');
		assert.ok(t);
		assert.equal(t.content[0].type, 'tablerow');
		assert.equal(t.content[0].content[0].type, 'tablecell');
	});

	it('marks th cells with header=true', () => {
		let t = structure.content.find(b => b.type === 'table');
		let firstCell = t.content[0].content[0];
		assert.equal(firstCell.header, true);
	});

	it('emits blockquotes that contain nested blocks', () => {
		let q = structure.content.find(b => b.type === 'blockquote');
		assert.ok(q);
		assert.equal(q.content[0].type, 'paragraph');
	});

	it('emits preformatted blocks that preserve newlines', () => {
		let pre = structure.content.find(b => b.type === 'preformatted');
		assert.ok(pre);
		assert.match(allText([pre]), /\n/);
	});

	it('attaches bold and italic styles to inline text nodes', () => {
		let p = structure.content.find(
			b => b.type === 'paragraph' && b.content?.some(t => t.style?.bold)
		);
		assert.ok(p);
		assert.ok(p.content.some(t => t.style?.italic));
	});

	it('attaches external link URLs to enclosed text nodes', () => {
		let p = structure.content.find(
			b => b.type === 'paragraph' && b.content?.some(t => t.target?.url)
		);
		assert.ok(p);
		let link = p.content.find(t => t.target?.url);
		assert.equal(link.target.url, 'https://example.com');
	});

	it('normalizes decomposed Unicode text to NFC', () => {
		// Fixture contains "Cafe" + U+0301 (combining acute); expect "Café".
		assert.match(allText(structure.content), /Café latté/);
	});
});

describe('Snapshot SDT: outline', () => {
	let structure;
	before(() => {
		structure = extractSnapshotStructure('2.html');
	});

	it('builds a hierarchy from heading levels', () => {
		assert.equal(structure.catalog.outline[0].title, 'A Deep Dive Into Widgets');
		let h2s = structure.catalog.outline[0].children.map(c => c.title);
		assert.deepEqual(
			h2s,
			['The History of Widgets', 'Construction', 'Applications', 'Looking Forward'],
		);
		let construction = structure.catalog.outline[0].children.find(c => c.title === 'Construction');
		assert.equal(construction.children[0].title, 'Finishing and Quality Control');
		assert.equal(construction.children[0].level, 3);
	});

	it('points each outline entry at its heading block by index', () => {
		let top = structure.catalog.outline[0];
		let block = structure.content[top.ref[0]];
		assert.equal(block.type, 'heading');
		assert.equal(allText([block]).trim(), 'A Deep Dive Into Widgets');
	});

	it('omits headings that Readability filtered out of the article', () => {
		let titles = outlineTitles(structure.catalog.outline);
		// <aside class="related-posts"><h2>Related Articles</h2>
		assert.ok(!titles.includes('Related Articles'));
		// <section class="comments" id="comments"><h2>Comments (42)</h2>
		assert.ok(!titles.includes('Comments (42)'));
		// <header class="site-header"><nav class="main-nav"><h2>Main Navigation</h2>
		assert.ok(!titles.includes('Main Navigation'));
	});
});

describe('Snapshot SDT: Readability filtering', () => {
	let structure;
	before(() => {
		structure = extractSnapshotStructure('2.html');
	});

	it('preserves the entire article body verbatim', () => {
		let text = allText(structure.content);
		assert.match(text, /A Deep Dive Into Widgets/);
		assert.match(text, /The first widgets emerged in the late nineteenth century/);
		assert.match(text, /Recent advances in additive manufacturing/);
		assert.match(text, /future of widgets is bright/);
	});

	it('drops elements whose class or id matches Readability\'s unlikely-candidate regex', () => {
		let text = allText(structure.content);
		// <header class="site-header"> matches /header/
		assert.doesNotMatch(text, /Main Navigation/);
		// <div class="ad-banner"> matches /banner/
		assert.doesNotMatch(text, /SPONSORED/);
		// <section class="comments" id="comments"> matches /comment/
		assert.doesNotMatch(text, /Great article, thanks/);
		assert.doesNotMatch(text, /learned a lot about widgets/);
	});

	it('preserves elements whose class matches the "ok maybe" whitelist', () => {
		// <article class="post-content">: "content" is in the unlikely regex
		// as part of other words, but "content" is also in okMaybeItsACandidate.
		// The whitelist wins.
		let text = allText(structure.content);
		assert.match(text, /A Deep Dive Into Widgets/);
	});

	it('drops <aside> via the unconditional _clean pass', () => {
		let text = allText(structure.content);
		assert.doesNotMatch(text, /Everything you wanted to know about gears/);
		assert.doesNotMatch(text, /The bolt: a retrospective/);
	});

	it('drops <footer> via the unconditional _clean pass', () => {
		let text = allText(structure.content);
		assert.doesNotMatch(text, /All rights reserved/);
		assert.doesNotMatch(text, /Terms of Service/);
	});

	it('drops boilerplate elements even when they have their own block-level content', () => {
		// The site-footer contains a <ul> of links; Readability's filtering
		// cascades through entire subtrees so those links are gone too.
		let text = allText(structure.content);
		assert.doesNotMatch(text, /^\s*Privacy\s*$/m);
	});
});

describe('Snapshot SDT: selectors resolve against the original document', () => {
	let structure;
	let body;
	before(() => {
		structure = extractSnapshotStructure('2.html');
		body = parseBody('2.html');
	});

	it('emits a selector on every block anchor', () => {
		let count = 0;
		forEachBlock(structure.content, b => {
			if (b.anchor) {
				assert.equal(typeof b.anchor.selectorMap, 'string');
				count++;
			}
		});
		assert.ok(count > 5);
	});

	it('every block-level selector resolves to an element of the expected tag', () => {
		let tagExpectations = {
			heading: /^h[1-6]$/,
			paragraph: /^p$/,
			list: /^(ul|ol)$/,
			listitem: /^li$/,
			blockquote: /^blockquote$/,
			preformatted: /^pre$/,
			table: /^table$/,
			tablerow: /^tr$/,
			tablecell: /^(td|th)$/,
			image: /^img$/,
			figure: /^figure$/,
			caption: /^figcaption$/,
		};
		let checked = 0;
		forEachBlock(structure.content, b => {
			let expected = tagExpectations[b.type];
			if (!expected || !b.anchor?.selectorMap) return;
			let target = resolveSelector(body, b.anchor.selectorMap);
			assert.ok(target, `did not resolve: ${b.anchor.selectorMap}`);
			assert.match(
				target.name,
				expected,
				`${b.type} anchor "${b.anchor.selectorMap}" resolved to <${target.name}>`,
			);
			checked++;
		});
		assert.ok(checked > 5);
	});

	it('selectors walk back to the same kept subtree they came from', () => {
		// All block anchors for this fixture live under <article> in the
		// original document, since <article class="post-content"> is the sole
		// candidate Readability keeps. Confirm the selectors path through it.
		let article = resolveSelector(body, 'article');
		assert.ok(article);
		forEachBlock(structure.content, b => {
			if (!b.anchor?.selectorMap) return;
			let target = resolveSelector(body, b.anchor.selectorMap);
			assert.ok(target);
			let p = target;
			let reached = false;
			while (p) {
				if (p === article) { reached = true; break; }
				p = p.parent;
			}
			assert.ok(reached, `${b.anchor.selectorMap} does not descend from <article>`);
		});
	});
});

describe('Snapshot SDT: short document fallback', () => {
	// 1.html is short enough that Readability's char-threshold retries walk
	// through all three flag demotions before returning a best-effort result.
	// The tests below exercise what ships out of that path.
	let structure;
	before(() => {
		structure = extractSnapshotStructure('1.html');
	});

	it('still surfaces the article-level outline', () => {
		let titles = outlineTitles(structure.catalog.outline);
		assert.ok(titles.includes('Main Title'));
		assert.ok(titles.includes('Section One'));
		assert.ok(titles.includes('Section Two'));
		assert.ok(titles.includes('Subsection'));
	});

	it('still drops <aside> and <footer>', () => {
		// The _clean pass runs even when flag-gated scoring demotes down to
		// its weakest form, so aside/footer still disappear.
		let text = allText(structure.content);
		assert.doesNotMatch(text, /Sidebar Heading/);
		assert.doesNotMatch(text, /Footer Heading/);
	});

	it('keeps a class-less <nav> because no hint triggers exclusion', () => {
		// <nav> is not in Readability's unconditional _clean list, and the
		// fixture's <nav> carries no class/id that the unlikely-candidate
		// regex would match, so it makes it through.
		let text = allText(structure.content);
		assert.match(text, /Navigation Heading/);
	});
});

describe('Snapshot SDT: fulltext extraction', () => {
	it('concatenates article text', () => {
		let r = extractSnapshotFulltext('2.html');
		assert.match(r.text, /A Deep Dive Into Widgets/);
		assert.match(r.text, /The first widgets emerged/);
		assert.equal(r.totalPages, 1);
	});

	it('omits filtered-out boilerplate', () => {
		let r = extractSnapshotFulltext('2.html');
		assert.doesNotMatch(r.text, /SPONSORED/);
		assert.doesNotMatch(r.text, /All rights reserved/);
	});

	it('accepts a precomputed structure without sourceHash', () => {
		let buf = load('2.html');
		let s = extractSnapshotStructure('2.html');
		let r = getSnapshotFulltext(buf, 'text/html', { structure: s });
		assert.match(r.text, /A Deep Dive Into Widgets/);
	});
});

let allHtmlFiles = fs.readdirSync(snapshotsDir).filter(f => f.endsWith('.html'));
let htmlWithSnapshots = allHtmlFiles.filter(
	f => fs.existsSync(path.join(snapshotsDir, f.replace('.html', '.json')))
);

describe('Snapshot SDT: golden fixture comparison', () => {
	for (let file of (process.env.UPDATE_FIXTURES ? allHtmlFiles : htmlWithSnapshots)) {
		let name = file.replace('.html', '');
		let snapshotPath = path.join(snapshotsDir, name + '.json');

		it(file, () => {
			let result = extractSnapshotStructure(file);
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

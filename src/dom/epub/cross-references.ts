/**
 * Internal link and footnote resolution for EPUB structured text.
 *
 * Resolves internal <a href="..."> links into refs/backRefs between blocks,
 * with special handling for footnotes.
 */

import type { LinkRecord, IdInfo } from './epub-xhtml-to-blocks';
import type { ContentBlockNode } from '../../../structured-document-text/schema';

const NOTEREF_ROLES = new Set(['doc-noteref', 'doc-biblioref', 'doc-glossref']);

/**
 * Resolve internal links across all sections, mutating blocks to add
 * refs/backRefs and target positions.
 */
export function computeSectionOffsets(blocksBySection: ContentBlockNode[][]): number[] {
	let sectionOffsets = new Array<number>(blocksBySection.length);
	let offset = 0;
	for (let i = 0; i < blocksBySection.length; i++) {
		sectionOffsets[i] = offset;
		offset += (blocksBySection[i] || []).length;
	}
	return sectionOffsets;
}

export function resolveLinks(
	allLinks: LinkRecord[],
	globalIdMap: Map<string, IdInfo>,
	blocksBySection: ContentBlockNode[][],
	hrefToSpineIndex: Map<string, number>,
	sectionOffsets: number[],
): void {
	for (let link of allLinks) {
		let target = resolveTarget(link.href, link.sourceSpineIndex, globalIdMap, hrefToSpineIndex);
		if (!target) continue;

		let sourceBlocks = blocksBySection[link.sourceSpineIndex];
		if (!sourceBlocks) continue;

		let targetBlocks = blocksBySection[target.spineIndex];
		if (!targetBlocks) continue;

		let sourceBlock = sourceBlocks[link.sourceBlockIndex];
		let targetBlock = targetBlocks[target.blockIndex];
		if (!sourceBlock || !targetBlock) continue;

		let isFootnote = detectFootnoteLink(link, targetBlock);

		if (isFootnote) {
			let targetGlobalIdx = sectionOffsets[target.spineIndex] + target.blockIndex;
			let sourceGlobalIdx = sectionOffsets[link.sourceSpineIndex] + link.sourceBlockIndex;

			if (link.textNodes.length > 0) {
				for (let tn of link.textNodes) {
					if (!tn.refs) tn.refs = [];
					tn.refs.push([targetGlobalIdx]);
				}
			}
			else {
				if (!sourceBlock.refs) sourceBlock.refs = [];
				sourceBlock.refs.push([targetGlobalIdx]);
			}

			if (!targetBlock.backRefs) targetBlock.backRefs = [];
			targetBlock.backRefs.push([sourceGlobalIdx]);
		}
	}
}

interface ResolvedTarget {
	spineIndex: number;
	blockIndex: number;
}

function resolveTarget(
	href: string,
	_sourceSpineIndex: number,
	globalIdMap: Map<string, IdInfo>,
	hrefToSpineIndex: Map<string, number>,
): ResolvedTarget | null {
	let [filePart, hash] = splitHref(href);

	if (!hash) return null;

	let idInfo = globalIdMap.get(hash);
	if (!idInfo) return null;

	if (filePart) {
		let targetSpineIndex = hrefToSpineIndex.get(filePart);
		if (targetSpineIndex === undefined) {
			try {
				targetSpineIndex = hrefToSpineIndex.get(decodeURIComponent(filePart));
			}
			catch {
				// ignore
			}
		}
		if (targetSpineIndex !== undefined && targetSpineIndex !== idInfo.spineIndex) {
			return null;
		}
	}

	return { spineIndex: idInfo.spineIndex, blockIndex: idInfo.blockIndex };
}

export function splitHref(href: string): [string, string] {
	if (!href) return ['', ''];
	let hashIdx = href.indexOf('#');
	if (hashIdx < 0) return [href, ''];
	return [href.slice(0, hashIdx), href.slice(hashIdx + 1)];
}

function detectFootnoteLink(link: LinkRecord, targetBlock: ContentBlockNode): boolean {
	if (link.epubType) {
		let types = link.epubType.split(/\s+/);
		if (types.includes('noteref')) return true;
	}

	if (link.role) {
		if (link.role === 'doc-link') return false;
		if (NOTEREF_ROLES.has(link.role)) return true;
	}

	return targetBlock.type === 'note';
}

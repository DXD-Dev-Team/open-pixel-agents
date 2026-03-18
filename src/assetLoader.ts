/**
 * Asset Loader - Loads furniture assets from per-folder manifests.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { PNG } from 'pngjs';
import {
	PNG_ALPHA_THRESHOLD,
	WALL_PIECE_WIDTH,
	WALL_PIECE_HEIGHT,
	WALL_GRID_COLS,
	WALL_BITMASK_COUNT,
	FLOOR_TILE_SIZE,
	CHARACTER_DIRECTIONS,
	CHAR_FRAME_W,
	CHAR_FRAME_H,
	CHAR_FRAMES_PER_ROW,
	CHAR_COUNT,
} from './constants.js';

export interface FurnitureAsset {
	id: string;
	name: string;
	label: string;
	category: string;
	file: string;
	width: number;
	height: number;
	footprintW: number;
	footprintH: number;
	isDesk: boolean;
	canPlaceOnWalls: boolean;
	partOfGroup?: boolean;
	groupId?: string;
	canPlaceOnSurfaces?: boolean;
	backgroundTiles?: number;
	orientation?: string;
	state?: string;
	mirrorSide?: boolean;
	rotationScheme?: string;
	animationGroup?: string;
	frame?: number;
}

export interface LoadedAssets {
	catalog: FurnitureAsset[];
	sprites: Map<string, string[][]>; // assetId -> SpriteData
}

/**
 * Load furniture assets from disk
 */
export async function loadFurnitureAssets(
	workspaceRoot: string,
): Promise<LoadedAssets | null> {
	try {
		console.log(`[AssetLoader] workspaceRoot received: "${workspaceRoot}"`);
		const furnitureDir = path.join(workspaceRoot, 'assets', 'furniture');
		console.log(`[AssetLoader] Scanning furniture directory: ${furnitureDir}`);

		if (!fs.existsSync(furnitureDir)) {
			console.log('ℹ️  No furniture directory found at:', furnitureDir);
			return null;
		}

		const entries = fs.readdirSync(furnitureDir, { withFileTypes: true });
		const dirs = entries.filter((entry) => entry.isDirectory());
		if (dirs.length === 0) {
			console.log('ℹ️  No furniture subdirectories found');
			return null;
		}

		console.log(`📦 Found ${dirs.length} furniture folders`);

		const catalog: FurnitureAsset[] = [];

		const sprites = new Map<string, string[][]>();

		for (const dir of dirs) {
			try {
				const itemDir = path.join(furnitureDir, dir.name);
				const manifestPath = path.join(itemDir, 'manifest.json');
				if (!fs.existsSync(manifestPath)) {
					console.warn(`  ⚠️  No manifest.json in ${dir.name}`);
					continue;
				}

				const manifestContent = fs.readFileSync(manifestPath, 'utf-8');
				const manifest = JSON.parse(manifestContent) as FurnitureManifestFile;

				const assets = flattenManifest(manifest);

				for (const asset of assets) {
					const assetPath = path.join(itemDir, asset.file);

					if (!fs.existsSync(assetPath)) {
						console.warn(`  ⚠️  Asset file not found: ${asset.file} in ${dir.name}`);
						continue;
					}

					const pngBuffer = fs.readFileSync(assetPath);
					const spriteData = pngToSpriteData(pngBuffer, asset.width, asset.height);
					sprites.set(asset.id, spriteData);
				}

				catalog.push(...assets);
			} catch (err) {
				console.warn(`  ⚠️  Error processing ${dir.name}: ${err instanceof Error ? err.message : err}`);
			}
		}

		console.log(`  ✓ Loaded ${sprites.size} / ${catalog.length} assets`);
		console.log(`[AssetLoader] ✅ Successfully loaded ${sprites.size} furniture sprites`);

		return { catalog, sprites };
	} catch (err) {
		console.error(`[AssetLoader] ❌ Error loading furniture assets: ${err instanceof Error ? err.message : err}`);
		return null;
	}
}

/**
 * Convert PNG buffer to SpriteData (2D array of hex color strings)
 *
 * PNG format: RGBA
 * SpriteData format: string[][] where '' = transparent, '#RRGGBB' = opaque color
 */
function pngToSpriteData(pngBuffer: Buffer, width: number, height: number): string[][] {
	try {
		const png = PNG.sync.read(pngBuffer);

		if (png.width !== width || png.height !== height) {
			console.warn(
				`PNG dimensions mismatch: expected ${width}×${height}, got ${png.width}×${png.height}`,
			);
		}

		const sprite: string[][] = [];
		const data = png.data;

		for (let y = 0; y < height; y++) {
			const row: string[] = [];
			for (let x = 0; x < width; x++) {
				const pixelIndex = (y * png.width + x) * 4;

				const r = data[pixelIndex];
				const g = data[pixelIndex + 1];
				const b = data[pixelIndex + 2];
				const a = data[pixelIndex + 3];

				if (a < PNG_ALPHA_THRESHOLD) {
					row.push('');
				} else {
					const hex = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`.toUpperCase();
					row.push(hex);
				}
			}
			sprite.push(row);
		}

		return sprite;
	} catch (err) {
		console.warn(`Failed to parse PNG: ${err instanceof Error ? err.message : err}`);
		const sprite: string[][] = [];
		for (let y = 0; y < height; y++) {
			sprite.push(new Array(width).fill(''));
		}
		return sprite;
	}
}

// ── Default layout loading ───────────────────────────────────

/**
 * Load the bundled default layout with the highest available revision.
 */
export function loadDefaultLayout(assetsRoot: string): Record<string, unknown> | null {
	const assetsDir = path.join(assetsRoot, 'assets');
	try {
		let bestRevision = 0;
		let bestPath: string | null = null;

		if (fs.existsSync(assetsDir)) {
			for (const file of fs.readdirSync(assetsDir)) {
				const match = /^default-layout-(\d+)\.json$/.exec(file);
				if (!match) {
					continue;
				}
				const rev = parseInt(match[1], 10);
				if (rev > bestRevision) {
					bestRevision = rev;
					bestPath = path.join(assetsDir, file);
				}
			}
		}

		if (!bestPath) {
			const fallback = path.join(assetsDir, 'default-layout.json');
			if (fs.existsSync(fallback)) {
				bestPath = fallback;
			}
		}

		if (!bestPath) {
			console.log('[AssetLoader] No default layout found in:', assetsDir);
			return null;
		}

		const content = fs.readFileSync(bestPath, 'utf-8');
		const layout = JSON.parse(content) as Record<string, unknown>;
		if (bestRevision > 0 && layout.layoutRevision === undefined) {
			layout.layoutRevision = bestRevision;
		}
		console.log(`[AssetLoader] ✅ Loaded default layout (${layout.cols}×${layout.rows}) from ${path.basename(bestPath)}`);
		return layout;
	} catch (err) {
		console.error(`[AssetLoader] ❌ Error loading default layout: ${err instanceof Error ? err.message : err}`);
		return null;
	}
}

// ── Wall tile loading ────────────────────────────────────────

export interface LoadedWallTiles {
	/** 16 sprites indexed by bitmask (N=1,E=2,S=4,W=8), each 16×32 SpriteData */
	sprites: string[][][];
}

/**
 * Load wall tiles from assets/walls/wall_*.png.
 * Uses the first wall set for current frontend compatibility.
 */
export async function loadWallTiles(
	assetsRoot: string,
): Promise<LoadedWallTiles | null> {
	try {
		const wallsDir = path.join(assetsRoot, 'assets', 'walls');
		if (!fs.existsSync(wallsDir)) {
			console.log('[AssetLoader] No walls/ directory found at:', wallsDir);
			return null;
		}

		const entries = fs.readdirSync(wallsDir);
		const wallFiles = entries
			.map((entry) => ({ entry, match: /^wall_(\d+)\.png$/i.exec(entry) }))
			.filter((item): item is { entry: string; match: RegExpExecArray } => item.match !== null)
			.sort((a, b) => parseInt(a.match[1], 10) - parseInt(b.match[1], 10));

		if (wallFiles.length === 0) {
			console.log('[AssetLoader] No wall_N.png files found in walls/');
			return null;
		}

		const wallPath = path.join(wallsDir, wallFiles[0].entry);
		console.log('[AssetLoader] Loading wall tiles from:', wallPath);
		const pngBuffer = fs.readFileSync(wallPath);
		const png = PNG.sync.read(pngBuffer);

		const sprites: string[][][] = [];
		for (let mask = 0; mask < WALL_BITMASK_COUNT; mask++) {
			const ox = (mask % WALL_GRID_COLS) * WALL_PIECE_WIDTH;
			const oy = Math.floor(mask / WALL_GRID_COLS) * WALL_PIECE_HEIGHT;
			const sprite: string[][] = [];
			for (let r = 0; r < WALL_PIECE_HEIGHT; r++) {
				const row: string[] = [];
				for (let c = 0; c < WALL_PIECE_WIDTH; c++) {
					const idx = ((oy + r) * png.width + (ox + c)) * 4;
					const rv = png.data[idx];
					const gv = png.data[idx + 1];
					const bv = png.data[idx + 2];
					const av = png.data[idx + 3];
					if (av < PNG_ALPHA_THRESHOLD) {
						row.push('');
					} else {
						row.push(`#${rv.toString(16).padStart(2, '0')}${gv.toString(16).padStart(2, '0')}${bv.toString(16).padStart(2, '0')}`.toUpperCase());
					}
				}
				sprite.push(row);
			}
			sprites.push(sprite);
		}

		console.log(`[AssetLoader] ✅ Loaded ${sprites.length} wall tile pieces`);
		return { sprites };
	} catch (err) {
		console.error(`[AssetLoader] ❌ Error loading wall tiles: ${err instanceof Error ? err.message : err}`);
		return null;
	}
}

/**
 * Send wall tiles to webview
 */
export function sendWallTilesToWebview(
	webview: vscode.Webview,
	wallTiles: LoadedWallTiles,
): void {
	webview.postMessage({
		type: 'wallTilesLoaded',
		sprites: wallTiles.sprites,
	});
	console.log(`📤 Sent ${wallTiles.sprites.length} wall tile pieces to webview`);
}

export interface LoadedFloorTiles {
	sprites: string[][][]; // 7 sprites, each 16x16 SpriteData
}

/**
 * Load floor tile patterns from assets/floors/floor_*.png
 */
export async function loadFloorTiles(
	assetsRoot: string,
): Promise<LoadedFloorTiles | null> {
	try {
		const floorsDir = path.join(assetsRoot, 'assets', 'floors');
		if (!fs.existsSync(floorsDir)) {
			console.log('[AssetLoader] No floors/ directory found at:', floorsDir);
			return null;
		}

		const entries = fs.readdirSync(floorsDir);
		const floorFiles = entries
			.map((entry) => ({ entry, match: /^floor_(\d+)\.png$/i.exec(entry) }))
			.filter((item): item is { entry: string; match: RegExpExecArray } => item.match !== null)
			.sort((a, b) => parseInt(a.match[1], 10) - parseInt(b.match[1], 10));

		if (floorFiles.length === 0) {
			console.log('[AssetLoader] No floor_N.png files found in floors/');
			return null;
		}

		const sprites: string[][][] = [];
		for (const floorFile of floorFiles) {
			const floorPath = path.join(floorsDir, floorFile.entry);
			const pngBuffer = fs.readFileSync(floorPath);
			sprites.push(pngToSpriteData(pngBuffer, FLOOR_TILE_SIZE, FLOOR_TILE_SIZE));
		}

		console.log(`[AssetLoader] ✅ Loaded ${sprites.length} floor tile patterns`);
		return { sprites };
	} catch (err) {
		console.error(`[AssetLoader] ❌ Error loading floor tiles: ${err instanceof Error ? err.message : err}`);
		return null;
	}
}

/**
 * Send floor tiles to webview
 */
export function sendFloorTilesToWebview(
	webview: vscode.Webview,
	floorTiles: LoadedFloorTiles,
): void {
	webview.postMessage({
		type: 'floorTilesLoaded',
		sprites: floorTiles.sprites,
	});
	console.log(`📤 Sent ${floorTiles.sprites.length} floor tile patterns to webview`);
}

// ── Character sprite loading ────────────────────────────────

export interface CharacterDirectionSprites {
	down: string[][][];
	up: string[][][];
	right: string[][][];
}

export interface LoadedCharacterSprites {
	/** 6 pre-colored characters, each with 9 frames per direction */
	characters: CharacterDirectionSprites[];
}

/**
 * Load pre-colored character sprites from assets/characters/ (6 PNGs, each 112×96).
 * Each PNG has 3 direction rows (down, up, right) × 7 frames (16×32 each).
 */
export async function loadCharacterSprites(
	assetsRoot: string,
): Promise<LoadedCharacterSprites | null> {
	try {
		const charDir = path.join(assetsRoot, 'assets', 'characters');
		const characters: CharacterDirectionSprites[] = [];

		for (let ci = 0; ci < CHAR_COUNT; ci++) {
			const filePath = path.join(charDir, `char_${ci}.png`);
			if (!fs.existsSync(filePath)) {
				console.log(`[AssetLoader] No character sprite found at: ${filePath}`);
				return null;
			}

			const pngBuffer = fs.readFileSync(filePath);
			const png = PNG.sync.read(pngBuffer);

			const directions = CHARACTER_DIRECTIONS;
			const charData: CharacterDirectionSprites = { down: [], up: [], right: [] };

			for (let dirIdx = 0; dirIdx < directions.length; dirIdx++) {
				const dir = directions[dirIdx];
				const rowOffsetY = dirIdx * CHAR_FRAME_H;
				const frames: string[][][] = [];

				for (let f = 0; f < CHAR_FRAMES_PER_ROW; f++) {
					const sprite: string[][] = [];
					const frameOffsetX = f * CHAR_FRAME_W;
					for (let y = 0; y < CHAR_FRAME_H; y++) {
						const row: string[] = [];
						for (let x = 0; x < CHAR_FRAME_W; x++) {
							const idx = (((rowOffsetY + y) * png.width) + (frameOffsetX + x)) * 4;
							const r = png.data[idx];
							const g = png.data[idx + 1];
							const b = png.data[idx + 2];
							const a = png.data[idx + 3];
							if (a < PNG_ALPHA_THRESHOLD) {
								row.push('');
							} else {
								row.push(`#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`.toUpperCase());
							}
						}
						sprite.push(row);
					}
					frames.push(sprite);
				}
				charData[dir] = frames;
			}
			characters.push(charData);
		}

		console.log(`[AssetLoader] ✅ Loaded ${characters.length} character sprites (${CHAR_FRAMES_PER_ROW} frames × 3 directions each)`);
		return { characters };
	} catch (err) {
		console.error(`[AssetLoader] ❌ Error loading character sprites: ${err instanceof Error ? err.message : err}`);
		return null;
	}
}

/**
 * Send character sprites to webview
 */
export function sendCharacterSpritesToWebview(
	webview: vscode.Webview,
	charSprites: LoadedCharacterSprites,
): void {
	webview.postMessage({
		type: 'characterSpritesLoaded',
		characters: charSprites.characters,
	});
	console.log(`📤 Sent ${charSprites.characters.length} character sprites to webview`);
}

/**
 * Send loaded assets to webview
 */
export function sendAssetsToWebview(
	webview: vscode.Webview,
	assets: LoadedAssets,
): void {
	if (!assets) {
		console.log('[AssetLoader] ⚠️  No assets to send');
		return;
	}

	console.log('[AssetLoader] Converting sprites Map to object...');
	const spritesObj: Record<string, string[][]> = {};
	for (const [id, spriteData] of assets.sprites) {
		spritesObj[id] = spriteData;
	}

	console.log(`[AssetLoader] Posting furnitureAssetsLoaded message with ${assets.catalog.length} assets`);
	webview.postMessage({
		type: 'furnitureAssetsLoaded',
		catalog: assets.catalog,
		sprites: spritesObj,
	});

	console.log(`📤 Sent ${assets.catalog.length} furniture assets to webview`);
}

interface ManifestAssetNode {
	type: 'asset';
	id: string;
	file: string;
	width: number;
	height: number;
	footprintW: number;
	footprintH: number;
	orientation?: string;
	state?: string;
	frame?: number;
	mirrorSide?: boolean;
}

interface ManifestGroupNode {
	type: 'group';
	groupType: 'rotation' | 'state' | 'animation';
	rotationScheme?: string;
	orientation?: string;
	state?: string;
	members: ManifestNode[];
}

type ManifestNode = ManifestAssetNode | ManifestGroupNode;

interface FurnitureManifestFile {
	id: string;
	name: string;
	category: string;
	canPlaceOnWalls: boolean;
	canPlaceOnSurfaces: boolean;
	backgroundTiles: number;
	type: 'asset' | 'group';
	file?: string;
	width?: number;
	height?: number;
	footprintW?: number;
	footprintH?: number;
	groupType?: string;
	rotationScheme?: string;
	members?: ManifestNode[];
}

interface InheritedProps {
	groupId: string;
	name: string;
	category: string;
	canPlaceOnWalls: boolean;
	canPlaceOnSurfaces: boolean;
	backgroundTiles: number;
	orientation?: string;
	state?: string;
	rotationScheme?: string;
	animationGroup?: string;
}

function flattenManifest(manifest: FurnitureManifestFile): FurnitureAsset[] {
	const inherited: InheritedProps = {
		groupId: manifest.id,
		name: manifest.name,
		category: manifest.category,
		canPlaceOnWalls: manifest.canPlaceOnWalls,
		canPlaceOnSurfaces: manifest.canPlaceOnSurfaces,
		backgroundTiles: manifest.backgroundTiles,
	};

	if (manifest.type === 'asset') {
		return [{
			id: manifest.id,
			name: manifest.name,
			label: manifest.name,
			category: manifest.category,
			file: manifest.file ?? `${manifest.id}.png`,
			width: manifest.width!,
			height: manifest.height!,
			footprintW: manifest.footprintW!,
			footprintH: manifest.footprintH!,
			isDesk: manifest.category === 'desks',
			canPlaceOnWalls: manifest.canPlaceOnWalls,
			canPlaceOnSurfaces: manifest.canPlaceOnSurfaces,
			backgroundTiles: manifest.backgroundTiles,
			groupId: manifest.id,
		}];
	}

	const rootGroup: ManifestGroupNode = {
		type: 'group',
		groupType: manifest.groupType as 'rotation' | 'state' | 'animation',
		rotationScheme: manifest.rotationScheme,
		members: manifest.members || [],
	};
	if (manifest.rotationScheme) {
		inherited.rotationScheme = manifest.rotationScheme;
	}
	return flattenManifestNode(rootGroup, inherited);
}

function flattenManifestNode(node: ManifestNode, inherited: InheritedProps): FurnitureAsset[] {
	if (node.type === 'asset') {
		const orientation = node.orientation ?? inherited.orientation;
		const state = node.state ?? inherited.state;
		return [{
			id: node.id,
			name: inherited.name,
			label: inherited.name,
			category: inherited.category,
			file: node.file,
			width: node.width,
			height: node.height,
			footprintW: node.footprintW,
			footprintH: node.footprintH,
			isDesk: inherited.category === 'desks',
			canPlaceOnWalls: inherited.canPlaceOnWalls,
			canPlaceOnSurfaces: inherited.canPlaceOnSurfaces,
			backgroundTiles: inherited.backgroundTiles,
			groupId: inherited.groupId,
			...(orientation ? { orientation } : {}),
			...(state ? { state } : {}),
			...(node.mirrorSide ? { mirrorSide: true } : {}),
			...(inherited.rotationScheme ? { rotationScheme: inherited.rotationScheme } : {}),
			...(inherited.animationGroup ? { animationGroup: inherited.animationGroup } : {}),
			...(node.frame !== undefined ? { frame: node.frame } : {}),
		}];
	}

	const results: FurnitureAsset[] = [];
	for (const member of node.members) {
		const childProps: InheritedProps = { ...inherited };
		if (node.groupType === 'rotation' && node.rotationScheme) {
			childProps.rotationScheme = node.rotationScheme;
		}
		if (node.groupType === 'state') {
			if (node.orientation) {
				childProps.orientation = node.orientation;
			}
			if (node.state) {
				childProps.state = node.state;
			}
		}
		if (node.groupType === 'animation') {
			const orient = node.orientation ?? inherited.orientation ?? '';
			const state = node.state ?? inherited.state ?? '';
			childProps.animationGroup = `${inherited.groupId}_${orient}_${state}`.toUpperCase();
			if (node.state) {
				childProps.state = node.state;
			}
		}
		if (node.orientation && !childProps.orientation) {
			childProps.orientation = node.orientation;
		}
		results.push(...flattenManifestNode(member, childProps));
	}
	return results;
}

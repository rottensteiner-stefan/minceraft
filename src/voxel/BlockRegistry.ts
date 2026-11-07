/**
 * Single source of truth for block semantics (dossier §3.2 / Dave-Report "BlockRegistry").
 * The mesher, the terrain generator, the player collision sweep and the block shader all read
 * block behaviour HERE -- never from duplicated switch statements.
 *
 * `id`, `transparent` and `faceLayers` drive the mesher (naive + AO + transparent-face rules)
 * and the atlas texture per face. `collidable` is used by the voxel-grid player collision
 * resolver and by the block editor's placement guard. Layer indices are opaque integers into
 * the app's `TextureArray` palette (see `BlockTextureFactory`); the registry must stay in sync
 * with that palette -- M2: `AtlasPixels` layer names vs `BLOCK_TEX_LAYER` keys are pinned by
 * the palette sync test.
 */

/** Texture-layer indices must match the palette built by `BlockTextureFactory`. */
export const BLOCK_TEX_LAYER = {
  GRASS_TOP: 0,
  DIRT: 1,
  STONE: 2,
  GRASS_SIDE: 3,
  WOOD_LOG_SIDE: 4,
  WOOD_LOG_TOP: 5,
  WOOD_PLANKS: 6,
  WATER: 7,
} as const;

export const BLOCK_AIR = 0;
export const BLOCK_GRASS = 1;
export const BLOCK_DIRT = 2;
export const BLOCK_STONE = 3;
export const BLOCK_WOOD = 4;
export const BLOCK_WATER = 5;

/** Which atlas layer a block uses per face axis. `+Y` = top, `-Y` = bottom, else = side. */
export interface BlockFaceLayers {
  top: number;
  bottom: number;
  side: number;
}

export interface BlockDefinition {
  /** Numeric id stored in `Chunk.voxels`. Must be unique and stable across sessions. */
  id: number;
  /** Stable display name (identifier-safe, no spaces). */
  name: string;
  /** Whether the block lets light pass / lets a mesh neighbor show through. */
  transparent: boolean;
  /** Whether a player AABB can collide with it (reserved for M1). */
  collidable: boolean;
  /** Atlas layers per face axis. */
  faceLayers: BlockFaceLayers;
}

/** Face-axis buckets for atlas layer selection -- frozen const object (repo avoids `const enum`;
 * the union type below keeps `switch` exhaustive without runtime enum objects). */
export const FACE_AXIS = {
  UP: 0,
  DOWN: 1,
  SIDE: 2,
} as const;

export type FaceAxis = (typeof FACE_AXIS)[keyof typeof FACE_AXIS];

/**
 * Returns the `FaceAxis` bucket a world-space unit normal (axis-aligned, from
 * `NaiveMesher.FACES`) maps to -- `+Y → top`, `-Y → bottom`, any horizontal → side.
 * `ny` is the Y component of the face normal.
 */
export function faceAxisForNormal(ny: number): FaceAxis {
  if (ny > 0) return FACE_AXIS.UP;
  if (ny < 0) return FACE_AXIS.DOWN;
  return FACE_AXIS.SIDE;
}

/**
 * Block registry -- not a singleton (no-global-singleton law). Construct one per engine
 * instance / app and pass it to every consumer (mesher, later generator/collision).
 */
export class BlockRegistry {
  private readonly _blocks: Map<number, BlockDefinition> = new Map();

  public register(def: BlockDefinition): void {
    if (this._blocks.has(def.id)) {
      throw new Error(`[BlockRegistry] Duplicate block id ${def.id} (${def.name})`);
    }
    this._blocks.set(def.id, def);
  }

  public get(id: number): BlockDefinition | undefined {
    return this._blocks.get(id);
  }

  /**
   * All registered definitions in insertion order (M1: the pure mesher needs the registry as a
   * serializable descriptor so the worker can cull/layer without importing this class -- a
   * `Map<number, ...>` survives structured clone, but a plain array is the robust, transferable
   * shape both the node tests and the worker consume).
   */
  public definitions(): BlockDefinition[] {
    return Array.from(this._blocks.values());
  }

  /** Whether a block id is solid for meshing (opaque and present). */
  public isOpaque(id: number): boolean {
    return id !== BLOCK_AIR && !(this._blocks.get(id)?.transparent ?? true);
  }

  /** The atlas layer for a block on a given face axis. `AIR` never reaches here. */
  public faceLayer(id: number, axis: FaceAxis): number {
    const def = this._blocks.get(id);
    if (!def) {
      throw new Error(`[BlockRegistry] faceLayer for unknown block id ${id}`);
    }
    switch (axis) {
      case FACE_AXIS.UP:
        return def.faceLayers.top;
      case FACE_AXIS.DOWN:
        return def.faceLayers.bottom;
      case FACE_AXIS.SIDE:
        return def.faceLayers.side;
    }
  }

  /**
   * The minimal M0 block set. Registered explicitly (not in the constructor) so tests and
   * the app can seed a registry the same way and so future milestones can extend it.
   */
  public static seed(registry: BlockRegistry): void {
    registry.register({
      id: BLOCK_GRASS,
      name: "grass",
      transparent: false,
      collidable: true,
      faceLayers: {
        top: BLOCK_TEX_LAYER.GRASS_TOP,
        bottom: BLOCK_TEX_LAYER.DIRT,
        side: BLOCK_TEX_LAYER.GRASS_SIDE,
      },
    });
    registry.register({
      id: BLOCK_DIRT,
      name: "dirt",
      transparent: false,
      collidable: true,
      faceLayers: {
        top: BLOCK_TEX_LAYER.DIRT,
        bottom: BLOCK_TEX_LAYER.DIRT,
        side: BLOCK_TEX_LAYER.DIRT,
      },
    });
    registry.register({
      id: BLOCK_STONE,
      name: "stone",
      transparent: false,
      collidable: true,
      faceLayers: {
        top: BLOCK_TEX_LAYER.STONE,
        bottom: BLOCK_TEX_LAYER.STONE,
        side: BLOCK_TEX_LAYER.STONE,
      },
    });
    registry.register({
      id: BLOCK_WOOD,
      name: "wood",
      transparent: false,
      collidable: true,
      faceLayers: {
        top: BLOCK_TEX_LAYER.WOOD_LOG_TOP,
        bottom: BLOCK_TEX_LAYER.WOOD_LOG_TOP,
        side: BLOCK_TEX_LAYER.WOOD_LOG_SIDE,
      },
    });
    // M2 (D3): Wasser ist NICHT kollidierbar (Sweep läuft durch, kein Schwimmen — M4) und für
    // den Mesher transparent (nur Faces gegen AIR werden gezeichnet, s. NaiveMesher).
    registry.register({
      id: BLOCK_WATER,
      name: "water",
      transparent: true,
      collidable: false,
      faceLayers: {
        top: BLOCK_TEX_LAYER.WATER,
        bottom: BLOCK_TEX_LAYER.WATER,
        side: BLOCK_TEX_LAYER.WATER,
      },
    });
  }
}

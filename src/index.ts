// Test-visible export barrel (mirrors the other sample apps -- `App.ts` is the HTML entry,
// this barrel is what unit tests import and what a future M1+ exports to consumers).
export { App } from "./App.js";
export {
  BlockRegistry,
  BLOCK_AIR,
  BLOCK_GRASS,
  BLOCK_DIRT,
  BLOCK_STONE,
} from "./voxel/BlockRegistry.js";
export { Chunk } from "./voxel/Chunk.js";
export { NaiveMesher } from "./voxel/mesh/NaiveMesher.js";
export { VoxelChunkGeometry } from "./voxel/mesh/VoxelChunkGeometry.js";
export { BlockMaterial } from "./voxel/material/BlockMaterial.js";
export { createBlockPalette } from "./voxel/BlockTextureFactory.js";

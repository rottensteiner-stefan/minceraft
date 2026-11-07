/// <reference types="vite/client" />

declare module "*.glsl?raw" {
  const content: string;
  export default content;
}

declare module "*.wgsl?raw" {
  const content: string;
  export default content;
}

declare module "*.glsl100?raw" {
  const content: string;
  export default content;
}

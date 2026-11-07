[BASE_VERTEX_HEADER]
// Voxel sky dome (M6): a unit cube around the viewer whose vertex position is the view direction.
// Same trick as the engine's skybox: only the model's linear part is applied, the camera position
// is added, and the depth is pinned just below the far plane so the sky never clips against a
// short far plane and every terrain pixel still wins the depth test.
out vec3 v_dir;

void main() {
  v_dir = a_position;
  vec4 clip = u_vp * (u_model * vec4(a_position, 0.0) + vec4(u_viewPos, 1.0));
  gl_Position = vec4(clip.xy, clip.w * 0.99999, clip.w);
}

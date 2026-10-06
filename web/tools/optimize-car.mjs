// Optimise the F1 car model for the web and strip all team/sponsor branding.
// Source: "Ferrari F1-75" by Sketcher (sketchfab.com/sketcher987654321), CC-BY-NC-4.0.
// Usage: node tools/optimize-car.mjs <in.gltf> <out.glb>   (needs @gltf-transform/*, meshoptimizer, sharp)
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { dedup, prune, weld, simplify, textureCompress, meshopt, instance, palette } from "@gltf-transform/functions";
import { MeshoptEncoder, MeshoptSimplifier } from "meshoptimizer";
import sharp from "sharp";

const [, , src, out] = process.argv;
await MeshoptEncoder.ready;
await MeshoptSimplifier.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "meshopt.encoder": MeshoptEncoder });
const doc = await io.read(src);

// branding lives in these textures: livery, sponsor decals, steering-wheel badges, tyre sidewall print
const BRANDED = new Set(["car_chassis", "decals", "sf21_sw_badges", "Wheels"]);
for (const mat of doc.getRoot().listMaterials()) {
  if (BRANDED.has(mat.getName())) {
    mat.setBaseColorTexture(null).setNormalTexture(null).setEmissiveTexture(null).setMetallicRoughnessTexture(null);
  }
}
// sponsor decal geometry is not needed at all
for (const mesh of doc.getRoot().listMeshes()) {
  for (const prim of mesh.listPrimitives()) {
    if (prim.getMaterial()?.getName() === "decals") prim.dispose();
  }
  if (mesh.listPrimitives().length === 0) mesh.dispose();
}

await doc.transform(
  dedup(),
  instance({ min: 2 }),
  weld(),
  simplify({ simplifier: MeshoptSimplifier, ratio: 0.45, error: 0.0006 }),
  prune(),
  textureCompress({ encoder: sharp, targetFormat: "webp", resize: [1024, 1024], quality: 82 }),
  meshopt({ encoder: MeshoptEncoder, level: "medium" }),
);
await io.write(out, doc);
const tris = doc.getRoot().listMeshes().flatMap((m) => m.listPrimitives()).reduce((a, p) => a + (p.getIndices()?.getCount() ?? 0) / 3, 0);
console.log(`wrote ${out}: ${Math.round(tris)} triangles, ${doc.getRoot().listTextures().length} textures`);

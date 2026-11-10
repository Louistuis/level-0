# Model pack pipeline

Builds `dist/assets/pack/*.glb` from the original Sketchfab downloads (CC BY 4.0, see `/CREDITS.md`).
The originals are **not** in the repository; keep them somewhere else and point the script at that folder.

## Rebuild

```sh
mkdir -p /tmp/l0-assets && cd /tmp/l0-assets
npm init -y >/dev/null
npm i @gltf-transform/core@4 @gltf-transform/extensions@4 @gltf-transform/functions@4 meshoptimizer sharp
node <repo>/tools/assets/build-pack.mjs <folder with the .glb files> <repo>/dist/assets/pack
```

Modules are resolved from the current directory, so nothing is installed into the repo. The script only
parses the glTF files and decodes their images (no code from the pack runs). It looks for these files
anywhere under the source folder:

| File | sha256 (the version this was built from) |
|---|---|
| `backrooms_vr.glb` | `f8f81dfa8a64a2afe51f0b2f31e6c596fcae196924beedc0f87258344a1ec7bf` |
| `hazmat_suit.glb` | `36bbe8368fb360d1cdc95f1f2944b39d34e6d1bbd270fd7f92fabd3eb29f6c76` |
| `charlie.glb` | `3d7c7117e78033769c5f6e5c0ec2a1aa8a3241950cf04cf0534017358642c5cf` |

The run prints a table and writes it to `last-build.json` (triangles before/after, size in metres, mount,
texture packing). It takes a few seconds. Validate with `npx @gltf-transform/cli validate <file>`.

## What it does

**Props (Backrooms VR).** That file is one scene where every material is a single mesh holding all
copies of an object (all armchairs in one mesh, and so on). The script splits each mesh into spatial
clusters, picks one clean copy by its world position (`PROPS` table in the script), turns it so the front
faces -Z, centres it, puts the mount plane at 0, and decimates with meshoptimizer only where it is over
budget. The textures are whole-scene bake atlases, so only the UV islands a prop uses are cut out and
re-packed into a new atlas (the gaps filled with the mean colour), scaled to a power of two and stored as
WebP (`EXT_texture_webp`). Geometry is `KHR_mesh_quantization` (three's GLTFLoader reads both natively).

Mounts: `floor` = base at y=0, centred in x/z. `ceiling` = mounting face at y=0, hangs into -y.
`wall` = base at y=0, centred in x, back face at z=0, sticks out towards -z. Each file's root node has
`extras: { mount, size, source }`; parts that should glow have material `extras.emissive`.

**Suits.** Both suits are one fused mesh. They are decimated to 15k triangles, scaled to 1.9 m, turned to
face -Z, then cut into `torso, head, armL, armR, legL, legR` by the per-model lines in `suit-cuts.json`
(metres; tuned from horizontal-slice histograms, run with `SEGDEBUG=1` to print them). Each part is a node
with `extras.pivot` (its joint), its own triangles (material `suit`) and a thin overlap skirt into the
neighbour (material `suit-skirt`, `extras.skirt`) so a rigidly swung limb does not open a hole. Every
vertex also carries `_SKINW` (uint8 vec2: bone index, weight*255; the rest of the weight goes to the
torso), from which `assets.js` builds a seamless skinned variant. "Left"/"right" are the suit's own.

## Surface textures

There are none in this pack that tile. Every Backrooms VR surface (Wall_1-4, Moquette_1-4 carpet,
Ceiling_1-4) is a lightmapped bake (`KHR_materials_unlit`) of a whole room at about 2 cm per pixel with
the light pools painted in, so it cannot repeat across a procedural world. `loadPack().textures` returns
null for wallpaper, carpet and ceiling and the game keeps its procedural ones.

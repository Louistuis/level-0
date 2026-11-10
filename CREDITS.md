# Credits

## 3D models

The files in `dist/assets/pack/` are converted (cut out, decimated, re-textured as WebP) from these Sketchfab models.

| Used for | Model | Author | Licence | Source |
|---|---|---|---|---|
| armchair, bookshelf, exit door, exit sign, ceiling lamp, troffer, ceiling vent, smoke detector, wall socket, window | Backrooms VR | [carlcapu9](https://sketchfab.com/carlcapu9) | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | <https://sketchfab.com/3d-models/backrooms-vr-d9b98eca8d064d0eafcd7f5484bb61ed> |
| yellow hazmat suit (players, the Hollow) | Hazmat Suit | [Cj.savage](https://sketchfab.com/Cj.savage) | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | <https://sketchfab.com/3d-models/hazmat-suit-2819a9b345fb44958fc025fb52610526> |
| dark operator suit (players) | Elite Hazmat Operator | [SKP_GAMES](https://sketchfab.com/SKP_GAMES) | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | <https://sketchfab.com/3d-models/elite-hazmat-operator-4d722398711c474cbbc393b117d4e668> |

Changes made: single objects were cut out of the scene, re-centred and scaled to metres, decimated, the
suits were split into body parts and given skin weights, and the textures were re-packed and re-encoded.
The same list is exported as `CREDITS` from `dist/js/assets.js` for the in-game credits.

These model files are licensed under CC BY 4.0 by their authors and are **not** covered by this repository's MIT licence.

## Typeface

Troffer (`dist/assets/troffer-*.woff2`) is licensed under the SIL Open Font License 1.1.

## Code

`dist/js/three.module.min.js` and `dist/js/vendor/` (GLTFLoader, BufferGeometryUtils) are from three.js r160, MIT licence, © 2010-2023 three.js authors.

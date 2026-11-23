# Third-party notices: gosidian-office

gosidian-office is MIT-licensed (the `LICENSE` at the root of this
repository). Its image holds one binary, compiled from this folder with
the Go modules it links, the page (built from `web/` with three.js), the
3D models the page draws, and an Alpine Linux base.

## In the page

- **[three.js](https://threejs.org)** 0.187.0, © 2010-2026 three.js
  authors: MIT. The page bundles it, with its glTF loader and skeleton
  utilities (`three/addons`).

The tools of the build (Vite, TypeScript, Vitest and what they bring) are
not in the image. `web/scripts/licenses.mjs` copies the license file of
each package the page bundles to `/licenses/web/<package>/` and lists them
in `/licenses/web/INDEX`; a package without a license file stops the
build.

## The 3D models

All in the public domain, [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/).
None imitates an existing character. Each was adapted for the office by
`scripts/assets.py` (standard library Python, no other tool); the
characters' shirts are drawn in the color of their role.
`assets/ASSETS.tsv`, which the references' page reads, lists them too,
with the SHA-256 of each model's source as downloaded.

| File in `web/public/models/` | Model | Author | Pack | Downloaded from | License |
|---|---|---|---|---|---|
| `character-female-b.glb` | character-female-b | [Kenney](https://www.kenney.nl) | [Mini Characters 2.0](https://kenney.nl/assets/mini-characters) | <https://kenney.nl/assets/mini-characters>, `kenney_mini-characters.zip` (in a browser: the site refuses scripts), `Models/GLB format/` | CC0 1.0 |
| `character-female-c.glb` | character-female-c | Kenney | Mini Characters 2.0 | the same | CC0 1.0 |
| `character-female-d.glb` | character-female-d | Kenney | Mini Characters 2.0 | the same | CC0 1.0 |
| `character-male-a.glb` | character-male-a | Kenney | Mini Characters 2.0 | the same | CC0 1.0 |
| `character-male-b.glb` | character-male-b | Kenney | Mini Characters 2.0 | the same | CC0 1.0 |
| `character-male-d.glb` | character-male-d | Kenney | Mini Characters 2.0 | the same | CC0 1.0 |
| `table_medium_long.glb` | table_medium_long | [Kay Lousberg](https://www.kaylousberg.com) | [KayKit Furniture Bits 1.0](https://github.com/KayKit-Game-Assets/KayKit-Furniture-Bits-1.0) | GitHub, commit `96d5930a8dbdb363409bbc2d3341718b00e17c9c`, `addons/kaykit_furniture_bits/Assets/gltf/` | CC0 1.0 |
| `chair_A.glb` | chair_A | Kay Lousberg | KayKit Furniture Bits 1.0 | the same | CC0 1.0 |
| `rug_rectangle_A.glb` | rug_rectangle_A | Kay Lousberg | KayKit Furniture Bits 1.0 | the same | CC0 1.0 |
| `cactus_small_A.glb` | cactus_small_A | Kay Lousberg | KayKit Furniture Bits 1.0 | the same | CC0 1.0 |
| `book_set.glb` | book_set | Kay Lousberg | KayKit Furniture Bits 1.0 | the same | CC0 1.0 |

- **KayKit**: the pack's `LICENSE.txt` says *Creative Commons Zero, CC0*;
  it is kept in `assets/LICENSE-KayKit-Furniture-Bits.txt` and in the
  image under `/licenses/assets/`. Each model came as `.gltf`, `.bin` and
  the pack's texture (`furniturebits_texture.png`), and is packed into one
  GLB with the texture inside (`assets.py pack`).
- **Kenney**: the pack's `License.txt` says *Creative Commons Zero, CC0*;
  it is kept in `assets/LICENSE-Kenney-Mini-Characters.txt` and in the
  image under `/licenses/assets/`. Each character came as a GLB pointing at
  the pack's `Textures/colormap.png`, and keeps its meshes, skeleton and
  four of its animations: `idle`, `interact-right`, `emote-yes` and
  `interact-left`, renamed Idle, Ask, Yes and Left (the page plays Left
  then Ask as the work at the desk), the texture inside and no tangents
  (`assets.py trim`). Its shirt, the triangles of the torso and the arms in
  one cell of the atlas, moves to a material of its own, Main, on the
  atlas's white gradient, which the page tints with the role's color
  (`--shirt`): 3.1 for female-b, 1.1 for female-c, 3.3 for female-d, 2.9
  for male-a, 2.15 for male-b, 3.7 for male-d.
- The credit is not required by CC0; the references' page gives it.

The SHA-256 of the files as downloaded (2026-11-18):

```
add348e98ab9e23d9973c4740ef2c5cceb229c742106aca2d56b30a8f1241bb7  kenney_mini-characters.zip
92aba6c40f4d09ea7c637c50b36147946632e5ade3c0296ca78be1effcd81661  License.txt (Mini Characters)
3aba07b39c13e9fa9a02cba6246fdd9d711bb15702e00e10ad84595b25452f95  Textures/colormap.png (Mini Characters)
3a0e6c3e431ae9d2016c2c9a91ec3abe8bb45243016a5cae80cbde0b61f8f2a9  character-female-b.glb
163ed5cb5b130177a64724efd9cf4f681fd73d7072f4f9b83ed584307dad870a  character-female-c.glb
788767a12ed89cea1c6b2617be1a9b7ddd999e9ed283baaac7cddfbe69720ccf  character-female-d.glb
c1cba637e1d946822df07385fabf9d1bc55255ce19e0e8f7124d767e03987126  character-male-a.glb
81464391ab3291bc78d23c33d5a5313cfab43469285a8e1f02b974aecbd4f943  character-male-b.glb
bded80fb516310186bf151b040696295395043b520a77d09533e20445dd4c02a  character-male-d.glb
e3ba8f08ce5964d602cde13ecba2b837f90b3ed22d092e28fa489f3c216e2488  table_medium_long.gltf
b436c4b982a7defac5310f6ca17bf387f24c8c9b843e035c09d23094ace9b788  table_medium_long.bin
fdc71044f23c89c5cff9093cff18bac295c9b750e73daf3cbd8ee6ca9e930dbb  chair_A.gltf
8db53212634ccc983dc0e9940f2809b3951abe91d0cc8ad040cf74d7100f19a8  chair_A.bin
892417306a01eac711c6af97b148fc152d375940ec3660964b36e10ea2a8cfda  rug_rectangle_A.gltf
10eb71fc2b20b056b6186526d451ee0a560c425495402d7818f4413795aba506  rug_rectangle_A.bin
4e2d93fb22b7f6097f3726b1fc513647873428224c01b17abdbe79c01c1e959b  cactus_small_A.gltf
43dae3699635f54fb84199b7a998c1144690c3e54d6c3fc3c045c38aa54f7fdc  cactus_small_A.bin
437bfaba3f3413a0b825627a1cb905765a191f4708be51838c9b60c8132cbe61  book_set.gltf
3aa3fcc774b46c7ffe2b1a3109bf006749163bbb392cfca930b34bfba4b67853  book_set.bin
de62db37a80d1801c3d9eb674890ae04b04469e0c149481a51fa250562c628dc  furniturebits_texture.png
```

The floor is not a model: the page draws it, in the colors of the theme.

## In the binary

- **Go**, its standard library: BSD-3-Clause.
- **[mcp-go](https://github.com/mark3labs/mcp-go)**: MIT; and the few
  modules it brings (`google/uuid`, `spf13/cast`, `yosida95/uritemplate`,
  the JSON Schema libraries, `golang.org/x/text`): BSD-3-Clause, MIT,
  Apache-2.0.

The image carries the license file of each module, as the build found it,
under `/licenses/go-modules/<module path>/`, and
`/licenses/go-modules/INDEX` lists them with their versions.
`scripts/licenses.sh` makes them at each build, and stops the build if a
module has no license file.

## The base

The Alpine base: musl (MIT), busybox (GPL-2.0-only), apk-tools
(GPL-2.0-only), OpenSSL (Apache-2.0), at the versions `/licenses/PROGRAMS`
names; their sources are in Alpine's
[aports](https://gitlab.alpinelinux.org/alpine/aports).

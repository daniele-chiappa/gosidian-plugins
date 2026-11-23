"""assets.py: the 3D models of the office, made from the CC0 packs.

Usage (standard library only; run it with python3 -I, the packs are
downloaded data):

  python3 -I scripts/assets.py pack <in.gltf> <out.glb>
      a glTF with its .bin and texture beside it, as one GLB with the
      texture inside (KayKit's packs ship .gltf + .bin + .png);
  python3 -I scripts/assets.py trim <in.glb> <out.glb> <old=new,...> [--shirt <row.col>]
      a GLB with only the animations named (renamed old -> new), its
      texture inside when it was a file beside it (Kenney's characters
      point at Textures/colormap.png), and its buffer rewritten with only
      the data something still uses. With --shirt, for Kenney's Mini
      Characters: the triangles of body-mesh on the torso and the arms
      whose texture is the atlas cell <row.col> (the atlas is 16 columns
      by 4 rows of gradients) move to a material of their own, named Main,
      their texture moved to the white gradient (3.15): the page tints Main
      with the role's color, and the shirt keeps its shading.

THIRD_PARTY_NOTICES.md says where each source came from and which
command made each model of web/public/models/.
"""

import copy
import json
import os
import struct
import sys

GLB_MAGIC = 0x46546C67
CHUNK_JSON = 0x4E4F534A
CHUNK_BIN = 0x004E4942

# The component types of glTF accessors, and their sizes.
FORMATS = {5120: "b", 5121: "B", 5122: "h", 5123: "H", 5125: "I", 5126: "f"}
COMPONENTS = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}

# Kenney's atlas: 16 columns by 4 rows, each cell a gradient; 3.15 is the
# white one.
ATLAS_COLS, ATLAS_ROWS = 16, 4
WHITE_CELL = (3, 15)
SHIRT_JOINTS = {"torso", "arm-left", "arm-right"}


def fail(msg):
    sys.stderr.write("assets.py: " + msg + "\n")
    sys.exit(1)


def inside(base, uri):
    """A file under base, by a relative URI: never a path out of the
    folder, an absolute one or a data: URI."""
    if not uri or "\\" in uri or ":" in uri or uri.startswith("/") or ".." in uri.split("/"):
        fail("refusing the URI %r: only a file under the model's folder" % uri)
    path = os.path.realpath(os.path.join(base, uri))
    if os.path.commonpath([path, os.path.realpath(base)]) != os.path.realpath(base):
        fail("refusing the URI %r: it leads out of the model's folder" % uri)
    with open(path, "rb") as f:
        return f.read()


def embed_images(doc, base):
    for img in doc.get("images", []):
        if "uri" in img:
            img["_bytes"] = inside(base, img.pop("uri"))
            img.setdefault("mimeType", "image/png")


def read_glb(path):
    with open(path, "rb") as f:
        b = f.read()
    if len(b) < 20:
        fail(path + ": too short for a GLB")
    magic, version, length = struct.unpack_from("<III", b, 0)
    if magic != GLB_MAGIC or version != 2 or length > len(b):
        fail(path + ": not a GLB 2.0")
    off, doc, binary = 12, None, b""
    while off + 8 <= length:
        clen, ctype = struct.unpack_from("<II", b, off)
        off += 8
        chunk = b[off:off + clen]
        off += clen
        if ctype == CHUNK_JSON and doc is None:
            doc = json.loads(chunk.decode("utf-8"))
        elif ctype == CHUNK_BIN and not binary:
            binary = chunk
    if doc is None:
        fail(path + ": no JSON chunk")
    embed_images(doc, os.path.dirname(os.path.abspath(path)))
    return doc, [binary]


def read_gltf(path):
    with open(path, "rb") as f:
        doc = json.loads(f.read().decode("utf-8"))
    base = os.path.dirname(os.path.abspath(path))
    buffers = [inside(base, buf.get("uri", "")) for buf in doc.get("buffers", [])]
    embed_images(doc, base)
    return doc, buffers


def read_accessor(doc, buffers, i):
    """The values of accessor i, one tuple per element."""
    a = doc["accessors"][i]
    bv = doc["bufferViews"][a["bufferView"]]
    fmt = FORMATS[a["componentType"]]
    n = COMPONENTS[a["type"]]
    size = struct.calcsize("<" + fmt) * n
    stride = bv.get("byteStride", size)
    data = bv["_bytes"] if "_bytes" in bv else buffers[bv.get("buffer", 0)]
    base = (0 if "_bytes" in bv else bv.get("byteOffset", 0)) + a.get("byteOffset", 0)
    return [struct.unpack_from("<" + fmt * n, data, base + k * stride) for k in range(a["count"])]


def add_accessor(doc, values, component, kind):
    """A new accessor of values, in a new buffer view of its own."""
    fmt = FORMATS[component]
    raw = b"".join(struct.pack("<" + fmt * len(v), *v) for v in values)
    doc["bufferViews"].append({"buffer": 0, "byteLength": len(raw), "_bytes": raw})
    acc = {"bufferView": len(doc["bufferViews"]) - 1, "componentType": component, "count": len(values), "type": kind}
    doc["accessors"].append(acc)
    return len(doc["accessors"]) - 1


def split_shirt(doc, buffers, cell):
    """Moves the shirt of Kenney's body-mesh to a material named Main."""
    row, col = (int(x) for x in cell.split("."))
    mesh = next((m for m in doc.get("meshes", []) if m.get("name") == "body-mesh"), None)
    if mesh is None or len(mesh["primitives"]) != 1:
        fail("--shirt: no body-mesh with one primitive")
    prim = mesh["primitives"][0]
    node = next(n for n in doc["nodes"] if n.get("mesh") == doc["meshes"].index(mesh))
    names = [doc["nodes"][j].get("name") for j in doc["skins"][node["skin"]]["joints"]]
    idx = [v[0] for v in read_accessor(doc, buffers, prim["indices"])]
    uv = read_accessor(doc, buffers, prim["attributes"]["TEXCOORD_0"])
    joints = read_accessor(doc, buffers, prim["attributes"]["JOINTS_0"])
    weights = read_accessor(doc, buffers, prim["attributes"]["WEIGHTS_0"])

    shirt, rest = [], []
    for t in range(0, len(idx), 3):
        tri = idx[t:t + 3]
        v = tri[0]
        joint = names[joints[v][max(range(4), key=lambda k: weights[v][k])]]
        u = sum(uv[k][0] for k in tri) / 3
        w = sum(uv[k][1] for k in tri) / 3
        on = joint in SHIRT_JOINTS and int(w * ATLAS_ROWS) == row and int(u * ATLAS_COLS) == col
        (shirt if on else rest).append(tri)
    if not shirt:
        fail("--shirt %s: no triangle of the torso or the arms in that cell" % cell)
    shared = {k for tri in shirt for k in tri} & {k for tri in rest for k in tri}
    if shared:
        fail("--shirt %s: %d vertices are both shirt and not" % (cell, len(shared)))

    # The shirt's texture moves to the same place in the white cell.
    du = (WHITE_CELL[1] - col) / ATLAS_COLS
    dv = (WHITE_CELL[0] - row) / ATLAS_ROWS
    moved = {k for tri in shirt for k in tri}
    uv = [(p[0] + du, p[1] + dv) if k in moved else p for k, p in enumerate(uv)]
    attrs = dict(prim["attributes"])
    attrs["TEXCOORD_0"] = add_accessor(doc, uv, 5126, "VEC2")
    itype = doc["accessors"][prim["indices"]]["componentType"]
    prim["attributes"] = attrs
    prim["indices"] = add_accessor(doc, [(k,) for tri in rest for k in tri], itype, "SCALAR")
    main = copy.deepcopy(doc["materials"][prim.get("material", 0)])
    main["name"] = "Main"
    doc["materials"].append(main)
    mesh["primitives"].append({"attributes": dict(attrs), "mode": 4, "material": len(doc["materials"]) - 1,
                               "indices": add_accessor(doc, [(k,) for tri in shirt for k in tri], itype, "SCALAR")})
    print("shirt %s: %d of %d triangles" % (cell, len(shirt), len(idx) // 3))


def rebuild(doc, buffers):
    """The GLB bytes of doc, with one buffer holding only the views in use."""
    views = doc.get("bufferViews", [])
    accessors = doc.get("accessors", [])
    data = []
    for bv in views:
        if "_bytes" in bv:
            data.append(bv.pop("_bytes"))
            continue
        start = bv.get("byteOffset", 0)
        data.append(buffers[bv.get("buffer", 0)][start:start + bv["byteLength"]])
    for img in doc.get("images", []):
        if "_bytes" in img:
            views.append({"buffer": 0, "byteLength": len(img["_bytes"])})
            data.append(img.pop("_bytes"))
            img["bufferView"] = len(views) - 1

    used = set()
    for mesh in doc.get("meshes", []):
        for prim in mesh.get("primitives", []):
            used.update(prim.get("attributes", {}).values())
            if "indices" in prim:
                used.add(prim["indices"])
            for target in prim.get("targets", []):
                used.update(target.values())
    for skin in doc.get("skins", []):
        if "inverseBindMatrices" in skin:
            used.add(skin["inverseBindMatrices"])
    for anim in doc.get("animations", []):
        for s in anim.get("samplers", []):
            used.add(s["input"])
            used.add(s["output"])
    for i in used:
        if "sparse" in accessors[i]:
            fail("sparse accessors are not handled")

    acc_map = {old: new for new, old in enumerate(sorted(used))}
    used_views = {accessors[i]["bufferView"] for i in used if "bufferView" in accessors[i]}
    used_views |= {img["bufferView"] for img in doc.get("images", []) if "bufferView" in img}
    view_map = {old: new for new, old in enumerate(sorted(used_views))}

    blob = bytearray()
    new_views = []
    for old in sorted(used_views):
        while len(blob) % 8:
            blob.append(0)
        bv = dict(views[old])
        bv["buffer"] = 0
        bv["byteOffset"] = len(blob)
        bv["byteLength"] = len(data[old])
        blob += data[old]
        new_views.append(bv)
    while len(blob) % 4:
        blob.append(0)

    new_accessors = []
    for old in sorted(used):
        acc = dict(accessors[old])
        if "bufferView" in acc:
            acc["bufferView"] = view_map[acc["bufferView"]]
        new_accessors.append(acc)
    for mesh in doc.get("meshes", []):
        for prim in mesh.get("primitives", []):
            prim["attributes"] = {k: acc_map[v] for k, v in prim.get("attributes", {}).items()}
            if "indices" in prim:
                prim["indices"] = acc_map[prim["indices"]]
            if "targets" in prim:
                prim["targets"] = [{k: acc_map[v] for k, v in t.items()} for t in prim["targets"]]
    for skin in doc.get("skins", []):
        if "inverseBindMatrices" in skin:
            skin["inverseBindMatrices"] = acc_map[skin["inverseBindMatrices"]]
    for anim in doc.get("animations", []):
        for s in anim.get("samplers", []):
            s["input"] = acc_map[s["input"]]
            s["output"] = acc_map[s["output"]]
    for img in doc.get("images", []):
        if "bufferView" in img:
            img["bufferView"] = view_map[img["bufferView"]]

    doc["accessors"] = new_accessors
    doc["bufferViews"] = new_views
    doc["buffers"] = [{"byteLength": len(blob)}]
    doc.setdefault("asset", {})["extras"] = {"office": "rebuilt by office/scripts/assets.py"}

    js = json.dumps(doc, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    while len(js) % 4:
        js += b" "
    total = 12 + 8 + len(js) + 8 + len(blob)
    out = struct.pack("<III", GLB_MAGIC, 2, total)
    out += struct.pack("<II", len(js), CHUNK_JSON) + js
    out += struct.pack("<II", len(blob), CHUNK_BIN) + bytes(blob)
    return out


def main(argv):
    if len(argv) >= 3 and argv[0] == "pack":
        doc, buffers = read_gltf(argv[1])
        out = rebuild(doc, buffers)
        dest = argv[2]
    elif len(argv) >= 4 and argv[0] == "trim":
        doc, buffers = read_glb(argv[1])
        keep = {}
        for pair in argv[3].split(","):
            old, _, new = pair.partition("=")
            keep[old] = new or old
        anims = []
        for anim in doc.get("animations", []):
            if anim.get("name") in keep:
                anim["name"] = keep[anim["name"]]
                anims.append(anim)
        missing = set(keep.values()) - {a["name"] for a in anims}
        if missing:
            fail("no animation " + ", ".join(sorted(missing)))
        doc["animations"] = anims
        # Tangents serve a normal map only: without one, they are dead weight.
        for mesh in doc.get("meshes", []):
            for prim in mesh.get("primitives", []):
                mat = doc.get("materials", [{}])[prim.get("material", 0)] if doc.get("materials") else {}
                if "normalTexture" not in mat:
                    prim.get("attributes", {}).pop("TANGENT", None)
        rest = argv[4:]
        if rest:
            if len(rest) != 2 or rest[0] != "--shirt":
                fail("trim: the only option is --shirt <row.col>")
            split_shirt(doc, buffers, rest[1])
        out = rebuild(doc, buffers)
        dest = argv[2]
    else:
        fail("usage: assets.py pack <in.gltf> <out.glb> | trim <in.glb> <out.glb> <old=new,...> [--shirt <row.col>]")
    with open(dest, "wb") as f:
        f.write(out)
    print("%s: %d bytes" % (dest, len(out)))


if __name__ == "__main__":
    main(sys.argv[1:])

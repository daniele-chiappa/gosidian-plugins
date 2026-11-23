// The office drawn with three.js. Two cameras look at one scene:
//
// - the map, an orthographic camera from above, tilted enough to see the
//   faces: a desk per role, its character tinted with the role's color, the
//   delegations as paths on the floor;
// - the 3D, a perspective camera that turns around the
//   office, with its walls and windows and the offices of its rooms behind
//   it. Only there do the characters move with their state.
//
// It draws on demand: a frame when something changed, and frames in a row
// only while something moves.

import {
  AnimationAction,
  AnimationClip,
  AnimationMixer,
  Box3,
  BoxGeometry,
  BufferGeometry,
  CanvasTexture,
  CapsuleGeometry,
  CircleGeometry,
  Color,
  DirectionalLight,
  Group,
  HemisphereLight,
  LoopOnce,
  LoopRepeat,
  Material,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  OrthographicCamera,
  PerspectiveCamera,
  PlaneGeometry,
  Raycaster,
  RepeatWrapping,
  RingGeometry,
  SRGBColorSpace,
  Scene,
  Shape,
  ShapeGeometry,
  SkinnedMesh,
  SphereGeometry,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import type { Camera, Texture } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';

import type { Theme } from './bridge';
import type { Bounds, Desk, ModelKind, OfficeLayout, Point } from './layout';
import { CHARACTERS, DESK, VIEW, frame } from './layout';
import type { RoleState } from './model';
import type { Orbit, Side, Wall, World } from './world';
import { ORBIT, WINDOW_WIDTH, clampTarget, facing, fitOrbit, lowered, moved, orbitPosition, roomRoleKey, wallsOf, windowsOf } from './world';

export interface Palette {
  background: string;
  rug: string;
  floorA: string;
  floorB: string;
  grout: string;
  link: string;
  select: string;
  // The 3D's: the walls, their glass, the ground between the offices.
  wall: string;
  glass: string;
  ground: string;
}

export const PALETTES: Readonly<Record<Theme, Palette>> = {
  light: {
    background: '#e9ecf0', rug: '#d3deeb', floorA: '#efe9df', floorB: '#e7e0d4', grout: '#d6ccbc', link: '#4f5866', select: '#1b66c9',
    wall: '#f6f3ee', glass: '#9cc3e6', ground: '#d5d9df',
  },
  dark: {
    background: '#15181c', rug: '#2e3a4b', floorA: '#2b3037', floorB: '#272b31', grout: '#1d2025', link: '#b4bdcb', select: '#7db2ff',
    wall: '#3b414a', glass: '#5b87b3', ground: '#1f2328',
  },
};

export type CameraKind = 'map' | '3d';

const ELEVATION = VIEW.elevation;
const CHARACTER_HEIGHT = VIEW.character;
// The characters lift their heads toward the viewer a little: from above,
// a face looking ahead shows mostly the top of the head. The 3D looks from
// lower, so less.
const HEAD_TILT: Record<CameraKind, number> = { map: -0.42, '3d': -0.14 };
const LABEL_HEIGHT = VIEW.label;

// The walls of the 3D: their height, the sill and the top of the windows,
// their thickness, and how high one stands when it is lowered.
const WALL = { height: 1.95, sill: 0.85, glassSill: 0.3, lintel: 1.65, thick: 0.12, low: 0.2 } as const;
// How fast a character turns toward the camera, in radians a second.
const TURN_SPEED = 4;
// A character waiting for a person reaches out again after this long.
const ASK_EVERY = 6000;
// The pace of the work at the desk.
const WORK_PACE = 0.55;

type Kind = 'desk' | 'chair' | 'rug' | 'cactus' | 'books' | ModelKind;

const FILES: Record<Kind, string> = {
  desk: 'models/table_medium_long.glb',
  chair: 'models/chair_A.glb',
  rug: 'models/rug_rectangle_A.glb',
  cactus: 'models/cactus_small_A.glb',
  books: 'models/book_set.glb',
  ...(Object.fromEntries(CHARACTERS.map((c) => [c, `models/${c}.glb`])) as Record<ModelKind, string>),
};

function isCharacter(kind: Kind): kind is ModelKind {
  return (CHARACTERS as readonly string[]).includes(kind);
}

// How big each piece is drawn: its height, its longest side along x, or
// its box (the desk, made lower and shallower than the pack's table so that
// the character behind it shows whole).
interface Size {
  height?: number;
  width?: number;
  alongX?: boolean;
  box?: readonly [number, number, number];
}

const SIZES: Record<Kind, Size> = {
  desk: { box: [1.6, 0.5, 0.7], alongX: true },
  chair: { height: 0.8 },
  rug: { width: 3.2, alongX: true },
  cactus: { height: 0.32 },
  books: { width: 0.42, alongX: true },
  ...(Object.fromEntries(CHARACTERS.map((c) => [c, { height: CHARACTER_HEIGHT }])) as Record<ModelKind, Size>),
};

interface Proto {
  source: Object3D;
  clips: AnimationClip[];
  skinned: boolean;
  height: number;
}

interface Character {
  key: string;
  // Turned toward the camera while it waits for a person, in the 3D.
  holder: Group;
  root: Object3D;
  // Where it stands in the world.
  x: number;
  z: number;
  mixer: AnimationMixer | null;
  idle: AnimationAction | null;
  // Its work at the desk, a loop: in the 3D, while it works.
  work: AnimationAction | null;
  clips: AnimationClip[];
  // A gesture playing once.
  playing: AnimationAction | null;
  // Its head bone, which leans toward the camera over every pose.
  head: Object3D | null;
  state: RoleState;
  yaw: number;
  // The timer of its next reach toward the viewer while it waits.
  ask: ReturnType<typeof setTimeout> | null;
}

// A wall of the 3D, whole and lowered.
interface WallPiece {
  wall: Wall;
  whole: Group;
  low: Group;
}

// A desk's place in the world, for its label and its ring.
interface Anchor {
  x: number;
  z: number;
  // In a room's office: only the 3D draws it.
  inRoom: boolean;
}

function isMesh(o: Object3D): o is Mesh {
  return (o as Mesh).isMesh === true;
}

function materials(m: Mesh): Material[] {
  return Array.isArray(m.material) ? m.material : [m.material];
}

// measure is the box of an object, its skinned meshes in their pose.
function measure(o: Object3D): Box3 {
  o.updateMatrixWorld(true);
  o.traverse((c) => {
    if ((c as SkinnedMesh).isSkinnedMesh) {
      (c as SkinnedMesh).computeBoundingBox();
    }
  });
  return new Box3().setFromObject(o);
}

// normalize scales and moves a model so that it stands on the floor,
// centred, at its size.
function normalize(o: Object3D, size: Size): number {
  let box = measure(o);
  let s = box.getSize(new Vector3());
  if (size.alongX && s.z > s.x) {
    o.rotation.y += Math.PI / 2;
    box = measure(o);
    s = box.getSize(new Vector3());
  }
  if (size.box && s.x > 0 && s.y > 0 && s.z > 0) {
    // Turned a quarter, the model's own x and z swap.
    const turned = Math.abs(Math.sin(o.rotation.y)) > 0.5;
    const [bx, by, bz] = size.box;
    o.scale.multiply(new Vector3(turned ? bz / s.z : bx / s.x, by / s.y, turned ? bx / s.x : bz / s.z));
  } else {
    let k = 1;
    if (size.height && s.y > 0) {
      k = size.height / s.y;
    } else if (size.width && Math.max(s.x, s.z) > 0) {
      k = size.width / Math.max(s.x, s.z);
    }
    o.scale.multiplyScalar(k);
  }
  box = measure(o);
  const c = box.getCenter(new Vector3());
  o.position.x -= c.x;
  o.position.z -= c.z;
  o.position.y -= box.min.y;
  return measure(o).max.y;
}

// soften makes a model's materials matte: with no environment to reflect,
// a metallic surface would draw black.
function soften(o: Object3D, shadows: boolean): void {
  o.traverse((c) => {
    if (!isMesh(c)) {
      return;
    }
    c.castShadow = shadows;
    c.receiveShadow = shadows;
    if ((c as SkinnedMesh).isSkinnedMesh) {
      c.frustumCulled = false;
    }
    for (const m of materials(c)) {
      if ((m as MeshStandardMaterial).isMeshStandardMaterial) {
        const s = m as MeshStandardMaterial;
        s.metalness = 0;
        s.roughness = Math.max(s.roughness, 0.65);
      }
    }
  });
}

// workClip is the work at the desk: a reach of the left hand, then of the
// right, over and over. Null when the model has not both.
export function workClip(clips: readonly AnimationClip[]): AnimationClip | null {
  const a = clips.find((c) => c.name === 'Left');
  const b = clips.find((c) => c.name === 'Ask');
  if (!a || !b) {
    return null;
  }
  const tracks = [];
  for (const ta of a.tracks) {
    const tb = b.tracks.find((t) => t.name === ta.name);
    if (!tb) {
      continue;
    }
    const times = new Float32Array(ta.times.length + tb.times.length);
    times.set(ta.times);
    // The second reach starts a frame after the first ends.
    const gap = 1 / 30;
    for (let i = 0; i < tb.times.length; i++) {
      times[ta.times.length + i] = a.duration + gap + tb.times[i];
    }
    const values = new Float32Array(ta.values.length + tb.values.length);
    values.set(ta.values);
    values.set(tb.values, ta.values.length);
    const T = ta.constructor as new (name: string, times: ArrayLike<number>, values: ArrayLike<number>) => typeof ta;
    tracks.push(new T(ta.name, times, values));
  }
  return tracks.length === 0 ? null : new AnimationClip('Work', a.duration + (1 / 30) + b.duration, tracks);
}

// The pieces drawn with primitives when a model does not load: the map
// still works, plainer.
function fallback(kind: Kind): Object3D {
  const g = new Group();
  const mat = (c: string) => new MeshStandardMaterial({ color: c, roughness: 0.8, metalness: 0 });
  if (isCharacter(kind)) {
    const body = new Mesh(new CapsuleGeometry(0.26, 0.3, 6, 16), mat('#e0703f'));
    body.material.name = 'Main';
    body.position.y = 0.42;
    const head = new Mesh(new SphereGeometry(0.34, 24, 16), mat('#f2d3b1'));
    head.position.y = 0.95;
    g.add(body, head);
    for (const x of [-0.12, 0.12]) {
      const eye = new Mesh(new SphereGeometry(0.06, 12, 8), mat('#20242a'));
      eye.position.set(x, 0.98, 0.3);
      g.add(eye);
    }
    return g;
  }
  switch (kind) {
    case 'desk': {
      const top = new Mesh(new BoxGeometry(1.7, 0.08, 0.85), mat('#b8754f'));
      top.position.y = 0.72;
      g.add(top);
      for (const [x, z] of [[-0.75, -0.35], [0.75, -0.35], [-0.75, 0.35], [0.75, 0.35]]) {
        const leg = new Mesh(new BoxGeometry(0.08, 0.7, 0.08), mat('#9a5f3f'));
        leg.position.set(x, 0.35, z);
        g.add(leg);
      }
      break;
    }
    case 'chair': {
      const seat = new Mesh(new BoxGeometry(0.5, 0.08, 0.5), mat('#4a90d9'));
      seat.position.y = 0.42;
      const back = new Mesh(new BoxGeometry(0.5, 0.45, 0.08), mat('#4a90d9'));
      back.position.set(0, 0.68, -0.22);
      g.add(seat, back);
      break;
    }
    default:
      break;
  }
  return g;
}

export interface SceneOptions {
  reducedMotion: () => boolean;
}

// Projected is where a point of the world falls on the canvas, in CSS
// pixels, and whether it is in front of the camera; depth grows away.
export interface Projected {
  x: number;
  y: number;
  depth: number;
  shown: boolean;
}

export class OfficeScene {
  readonly canvas: HTMLCanvasElement;
  private renderer: WebGLRenderer;
  private scene = new Scene();
  private camera = new OrthographicCamera(-5, 5, 5, -5, 0.1, 100);
  private persp = new PerspectiveCamera(ORBIT.fov, 1, 0.5, 400);
  private controls: OrbitControls;
  private kind: CameraKind = 'map';
  private tilt = HEAD_TILT.map;
  private hemi = new HemisphereLight(0xffffff, 0x8d8579, 1.5);
  private sun = new DirectionalLight(0xffffff, 1.6);
  private protos = new Map<Kind, Proto>();
  // The team's office, drawn by both cameras.
  private office = new Group();
  // What only the 3D draws: the walls, the ground, the rooms' offices.
  private extras = new Group();
  private floorTexture: CanvasTexture;
  // The floors of the rooms' offices: copies of the floor's texture.
  private roomTextures: Texture[] = [];
  private floor: Mesh<PlaneGeometry, MeshStandardMaterial>;
  private ground: Mesh<PlaneGeometry, MeshStandardMaterial>;
  private linkMaterial = new MeshBasicMaterial({ color: '#4f5866', transparent: true, opacity: 0.85, depthWrite: false });
  private selectMaterial = new MeshBasicMaterial({ color: '#1b66c9', transparent: true, opacity: 0.95, depthWrite: false });
  private wallMaterial = new MeshStandardMaterial({ color: '#f6f3ee', roughness: 0.9, metalness: 0 });
  private glassMaterial = new MeshStandardMaterial({ color: '#9cc3e6', roughness: 0.2, metalness: 0, transparent: true, opacity: 0.28, depthWrite: false });
  private floorMaterials: MeshStandardMaterial[] = [];
  private hitMaterial = new MeshBasicMaterial();
  private tinted: Material[] = [];
  // The rug's materials, drawn in a quiet color of the theme instead of its
  // texture.
  private rugMaterials: MeshStandardMaterial[] = [];
  private owned: BufferGeometry[] = [];
  private hits: Mesh[] = [];
  // What a click hits in the rooms' offices: only in the 3D.
  private roomHits: Mesh[] = [];
  private rings = new Map<string, Mesh>();
  private anchors = new Map<string, Anchor>();
  private characters = new Map<string, Character>();
  private walls: WallPiece[] = [];
  private layout: OfficeLayout | null = null;
  private world: World | null = null;
  // The camera of the 3D that holds everything, and whether the person
  // moved it since: a camera moved stays where it is when the office or
  // the window changes.
  private home: Orbit | null = null;
  private movedByHand = false;
  private width = 1;
  private height = 1;
  private raf = 0;
  private last = 0;
  private playing = new Set<string>();
  private raycaster = new Raycaster();
  private opts: SceneOptions;
  private theme: Theme = 'light';
  // Called after a frame is drawn.
  onRender: () => void = () => {};
  // Called when the person moves the camera of the 3D.
  onCameraMove: () => void = () => {};

  constructor(canvas: HTMLCanvasElement, opts: SceneOptions) {
    this.canvas = canvas;
    this.opts = opts;
    // Throws without WebGL: the page then shows the list.
    this.renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: 'low-power' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.02;
    this.scene.add(this.hemi, this.sun, this.sun.target, this.office, this.extras);
    this.extras.visible = false;

    const c = document.createElement('canvas');
    c.width = 128;
    c.height = 128;
    this.floorTexture = new CanvasTexture(c);
    this.floorTexture.wrapS = RepeatWrapping;
    this.floorTexture.wrapT = RepeatWrapping;
    this.floorTexture.colorSpace = SRGBColorSpace;
    this.floorTexture.anisotropy = 4;
    const geo = new PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2);
    this.floor = new Mesh(geo, new MeshStandardMaterial({ map: this.floorTexture, roughness: 0.95, metalness: 0 }));
    this.floor.receiveShadow = true;
    this.scene.add(this.floor);
    const groundGeo = new PlaneGeometry(1, 1);
    groundGeo.rotateX(-Math.PI / 2);
    this.ground = new Mesh(groundGeo, new MeshStandardMaterial({ color: '#d5d9df', roughness: 1, metalness: 0 }));
    this.ground.receiveShadow = true;
    this.ground.position.y = -0.03;

    // The controls listen only while the 3D is shown: on the map a finger
    // still scrolls the page.
    this.controls = new OrbitControls(this.persp, null);
    this.controls.enableDamping = false;
    this.controls.minPolarAngle = ORBIT.minPolar;
    this.controls.maxPolarAngle = ORBIT.maxPolar;
    this.controls.minDistance = ORBIT.minDistance;
    this.controls.addEventListener('start', () => {
      this.movedByHand = true;
    });
    this.controls.addEventListener('change', () => this.cameraChanged(this.movedByHand));
    this.setTheme('light');
  }

  // load reads the models once; one that does not load is drawn plainer.
  async load(): Promise<void> {
    const loader = new GLTFLoader();
    await Promise.all((Object.keys(FILES) as Kind[]).map(async (kind) => {
      let source: Object3D;
      let clips: AnimationClip[] = [];
      try {
        const gltf = await loader.loadAsync(FILES[kind]);
        source = gltf.scene;
        clips = gltf.animations;
      } catch {
        source = fallback(kind);
      }
      let skinned = false;
      source.traverse((o) => {
        skinned ||= (o as SkinnedMesh).isSkinnedMesh === true;
      });
      soften(source, kind !== 'rug');
      // A character is measured in the pose it is drawn in.
      const idle = clips.find((c) => c.name === 'Idle');
      if (idle) {
        const m = new AnimationMixer(source);
        m.clipAction(idle).play();
        m.update(0);
      }
      const height = normalize(source, SIZES[kind]);
      if (kind === 'rug') {
        source.traverse((o) => {
          if (isMesh(o)) {
            for (const m of materials(o)) {
              if ((m as MeshStandardMaterial).isMeshStandardMaterial) {
                const r = m as MeshStandardMaterial;
                r.map = null;
                r.needsUpdate = true;
                this.rugMaterials.push(r);
              }
            }
          }
        });
      }
      const work = workClip(clips);
      if (work) {
        clips = [...clips, work];
      }
      this.protos.set(kind, { source, clips, skinned, height });
    }));
    this.setTheme(this.theme);
  }

  // instance is a copy of a model in a holder of its own: the holder is
  // placed and scaled, the model keeps the offset that centres it.
  private instance(kind: Kind): Group {
    const p = this.protos.get(kind);
    const holder = new Group();
    if (!p) {
      holder.add(fallback(kind));
    } else {
      holder.add(p.skinned ? cloneSkinned(p.source) : p.source.clone());
    }
    return holder;
  }

  private top(kind: Kind): number {
    return this.protos.get(kind)?.height ?? 0.75;
  }

  setTheme(theme: Theme): void {
    this.theme = theme;
    const p = PALETTES[theme];
    this.scene.background = new Color(p.background);
    this.linkMaterial.color.set(p.link);
    for (const m of this.rugMaterials) {
      m.color.set(p.rug);
    }
    this.selectMaterial.color.set(p.select);
    this.wallMaterial.color.set(p.wall);
    this.glassMaterial.color.set(p.glass);
    this.ground.material.color.set(p.ground);
    this.hemi.groundColor.set(theme === 'dark' ? 0x3a3530 : 0x8d8579);
    this.hemi.intensity = theme === 'dark' ? 1.25 : 1.5;
    const c = this.floorTexture.image as HTMLCanvasElement;
    const ctx = c.getContext('2d');
    if (ctx) {
      // Two tiles by two, a thin grout between them.
      const h = c.width / 2;
      ctx.fillStyle = p.grout;
      ctx.fillRect(0, 0, c.width, c.height);
      for (const [x, y, col] of [[0, 0, p.floorA], [h, h, p.floorA], [h, 0, p.floorB], [0, h, p.floorB]] as const) {
        ctx.fillStyle = col;
        ctx.fillRect(x + 1, y + 1, h - 2, h - 2);
      }
      this.floorTexture.needsUpdate = true;
      for (const t of this.roomTextures) {
        t.needsUpdate = true;
      }
    }
    this.requestRender();
  }

  // build draws the office of a world: called when the roles, their places,
  // the delegations or the rooms' offices change, not for a change of
  // state. The map draws only the team's office.
  build(world: World): void {
    this.clear();
    this.world = world;
    const layout = world.main;
    this.layout = layout;
    const b = layout.bounds;
    const w = b.maxX - b.minX;
    const h = b.maxZ - b.minZ;
    this.floor.scale.set(w, 1, h);
    this.floor.position.set((b.minX + b.maxX) / 2, 0, (b.minZ + b.maxZ) / 2);
    this.floorTexture.repeat.set(w / 2.6, h / 2.6);
    this.furnish(this.office, layout, '', 0, 0);

    // The 3D's: the ground, the walls of the team's office, the rooms'.
    const wb = world.bounds;
    this.ground.scale.set(wb.maxX - wb.minX + 3, 1, wb.maxZ - wb.minZ + 3);
    this.ground.position.set((wb.minX + wb.maxX) / 2, -0.03, (wb.minZ + wb.maxZ) / 2);
    this.extras.add(this.ground);
    // Between the team's office and its rooms', the walls are glass.
    const rooms = world.rooms.length > 0;
    this.addWalls(b, rooms ? ['back'] : []);
    for (const o of world.rooms) {
      const ob = moved(o.layout.bounds, o.x, o.z);
      const tex = this.floorTexture.clone();
      tex.repeat.set((ob.maxX - ob.minX) / 2.6, (ob.maxZ - ob.minZ) / 2.6);
      tex.needsUpdate = true;
      this.roomTextures.push(tex);
      const mat = new MeshStandardMaterial({ map: tex, roughness: 0.95, metalness: 0 });
      this.floorMaterials.push(mat);
      const geo = new PlaneGeometry(ob.maxX - ob.minX, ob.maxZ - ob.minZ);
      geo.rotateX(-Math.PI / 2);
      this.owned.push(geo);
      const fl = new Mesh(geo, mat);
      fl.receiveShadow = true;
      fl.position.set((ob.minX + ob.maxX) / 2, 0, (ob.minZ + ob.maxZ) / 2);
      this.extras.add(fl);
      const g = new Group();
      this.furnish(g, o.layout, o.room, o.x, o.z);
      this.extras.add(g);
      this.addWalls(ob, ['front']);
    }
    this.home = null;
    this.shadows();
    this.fit();
    this.updateWalls();
    this.requestRender();
  }

  // furnish puts an office's desks, paths and plants in g, moved by x and z;
  // a room's keys are its name and its role's.
  private furnish(g: Group, layout: OfficeLayout, room: string, ox: number, oz: number): void {
    for (const d of layout.desks) {
      const key = room === '' ? d.name : roomRoleKey(room, d.name);
      g.add(this.desk(d, key, ox, oz, room !== ''));
    }
    for (const l of layout.links) {
      g.add(this.link(l.points.map(([x, z]) => [x + ox, z + oz] as const)));
    }
    // A plant at each corner of the floor.
    const b = moved(layout.bounds, ox, oz);
    for (const [x, z] of [[b.minX + 0.45, b.minZ + 0.45], [b.maxX - 0.45, b.minZ + 0.45], [b.minX + 0.45, b.maxZ - 0.45], [b.maxX - 0.45, b.maxZ - 0.45]]) {
      const plant = this.instance('cactus');
      plant.scale.multiplyScalar(2.2);
      plant.position.set(x, 0, z);
      g.add(plant);
    }
  }

  // addWalls stands the four walls of the 3D around an office's floor; those
  // on the sides named glass are glass from a low sill up, to see the
  // office beyond.
  private addWalls(b: Bounds, glass: readonly Side[]): void {
    for (const wall of wallsOf(b)) {
      const clear = glass.includes(wall.side);
      const sill = clear ? WALL.glassSill : WALL.sill;
      const len = Math.hypot(wall.x1 - wall.x0, wall.z1 - wall.z0) + WALL.thick;
      const whole = new Group();
      const low = new Group();
      const box = (into: Group, w: number, h: number, d: number, x: number, y: number, mat: Material, shadow: boolean) => {
        const geo = new BoxGeometry(w, h, d);
        this.owned.push(geo);
        const m = new Mesh(geo, mat);
        m.position.set(x, y, 0);
        m.castShadow = shadow;
        m.receiveShadow = shadow;
        into.add(m);
      };
      const half = len / 2;
      box(whole, len, sill, WALL.thick, 0, sill / 2, this.wallMaterial, true);
      box(whole, len, WALL.height - WALL.lintel, WALL.thick, 0, (WALL.lintel + WALL.height) / 2, this.wallMaterial, true);
      const between = WALL.lintel - sill;
      const mid = (sill + WALL.lintel) / 2;
      if (clear) {
        box(whole, len, between, 0.03, 0, mid, this.glassMaterial, false);
      } else {
        // Between the windows, the wall; in them, the glass.
        const wins = windowsOf(len);
        let from = 0;
        for (const c of [...wins, len + WINDOW_WIDTH / 2]) {
          const to = Math.min(len, c - WINDOW_WIDTH / 2);
          if (to - from > 1e-3) {
            box(whole, to - from, between, WALL.thick, (from + to) / 2 - half, mid, this.wallMaterial, true);
          }
          from = c + WINDOW_WIDTH / 2;
        }
        for (const c of wins) {
          box(whole, WINDOW_WIDTH, between, 0.03, c - half, mid, this.glassMaterial, false);
        }
      }
      box(low, len, WALL.low, WALL.thick, 0, WALL.low / 2, this.wallMaterial, true);
      for (const g of [whole, low]) {
        g.position.set((wall.x0 + wall.x1) / 2, 0, (wall.z0 + wall.z1) / 2);
        // A wall along z is a wall along x turned a quarter.
        g.rotation.y = wall.x0 === wall.x1 ? Math.PI / 2 : 0;
        this.extras.add(g);
      }
      this.walls.push({ wall, whole, low });
    }
  }

  private desk(d: Desk, key: string, ox: number, oz: number, inRoom: boolean): Group {
    const g = new Group();
    const x = d.x + ox;
    const z = d.z + oz;
    g.position.set(x, 0, z);
    this.anchors.set(key, { x, z, inRoom });
    const hits = inRoom ? this.roomHits : this.hits;
    if (d.room) {
      return this.meeting(g, key, hits);
    }
    const top = this.top('desk');
    if (d.head) {
      const rug = this.instance('rug');
      rug.position.set(0, 0.002, DESK.character + 0.18);
      g.add(rug);
    }
    const chair = this.instance('chair');
    chair.position.set(0, 0, DESK.chair);
    g.add(chair);
    g.add(this.instance('desk'));
    const cactus = this.instance('cactus');
    cactus.position.set(0.58, top, -0.08);
    g.add(cactus);
    if (d.head) {
      const books = this.instance('books');
      books.position.set(-0.48, top, -0.06);
      g.add(books);
    }

    const kind: Kind = d.model;
    const holder = this.instance(kind);
    holder.position.z = DESK.character;
    const root = holder.children[0];
    const clips = this.protos.get(kind)?.clips ?? [];
    root.traverse((o) => {
      if (!isMesh(o)) {
        return;
      }
      const ms = materials(o).map((m) => {
        if (m.name !== 'Main') {
          return m;
        }
        const t = m.clone() as MeshStandardMaterial;
        t.color.set(d.color);
        this.tinted.push(t);
        return t;
      });
      o.material = Array.isArray(o.material) ? ms : ms[0];
    });
    let mixer: AnimationMixer | null = null;
    let idle: AnimationAction | null = null;
    let work: AnimationAction | null = null;
    const idleClip = clips.find((c) => c.name === 'Idle');
    if (idleClip) {
      mixer = new AnimationMixer(root);
      idle = mixer.clipAction(idleClip);
      idle.play();
      mixer.update(0);
      const w = clips.find((c) => c.name === 'Work');
      if (w) {
        work = mixer.clipAction(w);
        work.setLoop(LoopRepeat, Infinity);
        work.timeScale = WORK_PACE;
      }
    }
    const head = root.getObjectByName('head') ?? null;
    head?.rotateX(this.tilt);
    g.add(holder);
    this.characters.set(key, {
      key, holder, root, x, z: z + DESK.character, mixer, idle, work, clips, playing: null, head, state: 'idle', yaw: 0, ask: null,
    });

    const ringGeo = new RingGeometry(0.52, 0.66, 48);
    ringGeo.rotateX(-Math.PI / 2);
    this.owned.push(ringGeo);
    const ring = new Mesh(ringGeo, this.selectMaterial);
    ring.position.set(0, 0.015, DESK.character);
    ring.visible = false;
    ring.renderOrder = 2;
    g.add(ring);
    this.rings.set(key, ring);

    // What a click on the map hits: the desk, the character and the chair.
    const hitGeo = new BoxGeometry(2.1, CHARACTER_HEIGHT + 0.3, DESK.front - DESK.back + 0.1);
    this.owned.push(hitGeo);
    const hit = new Mesh(hitGeo, this.hitMaterial);
    hit.visible = false;
    hit.position.set(0, (CHARACTER_HEIGHT + 0.3) / 2, (DESK.front + DESK.back) / 2);
    hit.userData.role = key;
    g.add(hit);
    hits.push(hit);
    return g;
  }

  // meeting is the place of a room of the team: a meeting table
  // on a rug, nobody at it; its people are in its own office.
  private meeting(g: Group, key: string, hits: Mesh[]): Group {
    const rug = this.instance('rug');
    rug.position.set(0, 0.002, DESK.character + 0.3);
    g.add(rug);
    const top = this.top('desk');
    const table = this.instance('desk');
    table.position.z = DESK.character + 0.3;
    g.add(table);
    const books = this.instance('books');
    books.position.set(-0.3, top, DESK.character + 0.3);
    g.add(books);
    const cactus = this.instance('cactus');
    cactus.position.set(0.45, top, DESK.character + 0.3);
    g.add(cactus);

    const ringGeo = new RingGeometry(0.9, 1.04, 48);
    ringGeo.rotateX(-Math.PI / 2);
    this.owned.push(ringGeo);
    const ring = new Mesh(ringGeo, this.selectMaterial);
    ring.position.set(0, 0.015, DESK.character + 0.3);
    ring.visible = false;
    ring.renderOrder = 2;
    g.add(ring);
    this.rings.set(key, ring);

    const hitGeo = new BoxGeometry(2.1, 1.2, DESK.front - DESK.back + 0.1);
    this.owned.push(hitGeo);
    const hit = new Mesh(hitGeo, this.hitMaterial);
    hit.visible = false;
    hit.position.set(0, 0.6, (DESK.front + DESK.back) / 2);
    hit.userData.role = key;
    g.add(hit);
    hits.push(hit);
    return g;
  }

  // link is a delegation's path: a ribbon on the floor with an arrow at
  // the delegate's end.
  private link(points: readonly Point[]): Group {
    const g = new Group();
    const width = 0.075;
    const arrow = 0.32;
    for (let i = 0; i + 1 < points.length; i++) {
      const [x0, z0] = points[i];
      let [x1, z1] = points[i + 1];
      const dx = x1 - x0;
      const dz = z1 - z0;
      let len = Math.hypot(dx, dz);
      if (len < 1e-6) {
        continue;
      }
      const last = i + 2 === points.length;
      if (last) {
        // The ribbon stops where the arrow starts.
        len = Math.max(0, len - arrow * 0.8);
        x1 = x0 + (dx / Math.hypot(dx, dz)) * len;
        z1 = z0 + (dz / Math.hypot(dx, dz)) * len;
      }
      const angle = Math.atan2(-dz, dx);
      if (len > 0) {
        const seg = new PlaneGeometry(len, width);
        seg.rotateX(-Math.PI / 2);
        this.owned.push(seg);
        const m = new Mesh(seg, this.linkMaterial);
        m.position.set((x0 + x1) / 2, 0.012, (z0 + z1) / 2);
        m.rotation.y = angle;
        m.renderOrder = 1;
        g.add(m);
      }
      if (i > 0) {
        const joint = new CircleGeometry(width / 2, 12);
        joint.rotateX(-Math.PI / 2);
        this.owned.push(joint);
        const j = new Mesh(joint, this.linkMaterial);
        j.position.set(x0, 0.012, z0);
        j.renderOrder = 1;
        g.add(j);
      }
      if (last) {
        const s = new Shape();
        s.moveTo(-arrow, -arrow * 0.55);
        s.lineTo(0, 0);
        s.lineTo(-arrow, arrow * 0.55);
        s.lineTo(-arrow * 0.75, 0);
        s.closePath();
        const head = new ShapeGeometry(s);
        head.rotateX(-Math.PI / 2);
        this.owned.push(head);
        const a = new Mesh(head, this.linkMaterial);
        const [ex, ez] = points[i + 1];
        a.position.set(ex, 0.013, ez);
        a.rotation.y = angle;
        a.renderOrder = 1;
        g.add(a);
      }
    }
    return g;
  }

  private clear(): void {
    this.stopAll();
    this.office.clear();
    this.extras.clear();
    for (const g of this.owned) {
      g.dispose();
    }
    for (const m of [...this.tinted, ...this.floorMaterials]) {
      m.dispose();
    }
    for (const t of this.roomTextures) {
      t.dispose();
    }
    this.owned = [];
    this.tinted = [];
    this.floorMaterials = [];
    this.roomTextures = [];
    this.hits = [];
    this.roomHits = [];
    this.walls = [];
    this.rings.clear();
    this.anchors.clear();
    for (const c of this.characters.values()) {
      if (c.ask !== null) {
        clearTimeout(c.ask);
      }
      c.mixer?.stopAllAction();
    }
    this.characters.clear();
    this.layout = null;
    this.world = null;
  }

  setSelected(key: string | null): void {
    for (const [n, r] of this.rings) {
      r.visible = n === key;
    }
    this.requestRender();
  }

  // --- the two cameras ---

  get cameraKind(): CameraKind {
    return this.kind;
  }

  // setCamera shows the map or the 3D. The 3D's controls listen only while
  // it is shown.
  setCamera(kind: CameraKind): void {
    if (kind === this.kind) {
      return;
    }
    this.kind = kind;
    this.extras.visible = kind === '3d';
    if (kind === '3d') {
      this.controls.connect(this.canvas);
    } else {
      this.controls.disconnect();
      this.canvas.style.cursor = '';
    }
    this.retilt(HEAD_TILT[kind]);
    this.shadows();
    this.fit();
    for (const c of this.characters.values()) {
      this.motion(c);
    }
    this.updateWalls();
    this.requestRender();
  }

  // The camera the frame is drawn with.
  private get active(): Camera {
    return this.kind === '3d' ? this.persp : this.camera;
  }

  // retilt leans every head by the tilt of the camera now shown.
  private retilt(next: number): void {
    for (const c of this.characters.values()) {
      c.head?.rotateX(next - this.tilt);
    }
    this.tilt = next;
  }

  // posed runs a change of a character's pose with its head upright, then
  // leans the head toward the camera again: the mixer writes the head only
  // when a clip moves it, so the lean is taken off first, never stacked.
  private posed(c: Character, change: () => void): void {
    c.head?.rotateX(-this.tilt);
    change();
    c.head?.rotateX(this.tilt);
  }

  // The sun's shadows cover what the camera shows.
  private shadows(): void {
    const b = this.kind === '3d' && this.world ? this.world.bounds : this.layout?.bounds;
    if (!b) {
      return;
    }
    const cx = (b.minX + b.maxX) / 2;
    const cz = (b.minZ + b.maxZ) / 2;
    this.sun.target.position.set(cx, 0, cz);
    this.sun.position.set(cx - 6, 14, cz + 8);
    const r = Math.max(b.maxX - b.minX, b.maxZ - b.minZ) / 2 + 2;
    const sc = this.sun.shadow.camera;
    sc.left = -r;
    sc.right = r;
    sc.top = r;
    sc.bottom = -r;
    sc.near = 1;
    sc.far = 40 + r;
    sc.updateProjectionMatrix();
  }

  // fit frames the whole office, whatever the shape of the map; in the 3D,
  // it frames everything unless the person moved the camera.
  private fit(): void {
    const aspect = this.width / this.height;
    if (this.kind === '3d') {
      this.persp.aspect = aspect;
      this.persp.updateProjectionMatrix();
      if (this.world) {
        this.home = fitOrbit(this.world.bounds, aspect);
        this.controls.maxDistance = this.home.distance * ORBIT.farther;
        if (!this.movedByHand) {
          this.goTo(this.home);
        }
      }
      return;
    }
    const b = this.layout?.bounds ?? { minX: -3, maxX: 3, minZ: -3, maxZ: 3 };
    const sin = Math.sin(ELEVATION);
    const cos = Math.cos(ELEVATION);
    const f = frame(b);
    const halfW = f.w / 2;
    const halfH = f.h / 2;
    let hw = halfW;
    let hh = halfH;
    if (hw / hh > aspect) {
      hh = hw / aspect;
    } else {
      hw = hh * aspect;
    }
    const cam = this.camera;
    cam.left = -hw;
    cam.right = hw;
    cam.top = hh;
    cam.bottom = -hh;
    // The labels above the far row need room: the frame's centre rises by
    // half their height.
    const up = new Vector3(0, cos, -sin);
    const target = new Vector3((b.minX + b.maxX) / 2, 0, (b.minZ + b.maxZ) / 2).addScaledVector(up, (LABEL_HEIGHT * cos) / 2);
    cam.position.copy(target).add(new Vector3(0, sin, cos).multiplyScalar(40));
    cam.near = 1;
    cam.far = 100;
    cam.lookAt(target);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
  }

  private goTo(o: Orbit): void {
    const p = orbitPosition(o);
    this.controls.target.set(o.target.x, o.target.y, o.target.z);
    this.persp.position.set(p.x, p.y, p.z);
    this.persp.lookAt(this.controls.target);
    this.controls.update();
    this.cameraChanged(false);
  }

  // resetView brings the 3D's camera back to what holds everything.
  resetView(): void {
    this.movedByHand = false;
    if (this.home) {
      this.goTo(this.home);
    }
    this.requestRender();
  }

  // turn, tilt and zoom move the 3D's camera from the keys and buttons, as
  // a drag does: a turn to the right moves the office's near side to the
  // right, a tilt up looks from higher.
  turn(steps: number): void {
    this.byHand(() => this.controls.rotateLeft(steps * ORBIT.turn));
  }

  tiltBy(steps: number): void {
    this.byHand(() => this.controls.rotateUp(steps * ORBIT.tilt));
  }

  zoom(steps: number): void {
    const k = Math.pow(ORBIT.zoom, Math.abs(steps));
    // In three's controls dollyOut divides the distance, dollyIn multiplies
    // it: nearer is out.
    this.byHand(() => (steps > 0 ? this.controls.dollyOut(k) : this.controls.dollyIn(k)));
  }

  private byHand(move: () => void): void {
    if (this.kind !== '3d') {
      return;
    }
    this.movedByHand = true;
    move();
  }

  get cameraMoved(): boolean {
    return this.movedByHand;
  }

  // cameraChanged keeps the camera over the offices, lowers the walls in
  // front of it, turns the waiting toward it, and draws.
  private cameraChanged(byHand: boolean): void {
    if (this.world) {
      const t = this.controls.target;
      const c = clampTarget(t, this.world.bounds);
      if (c.x !== t.x || c.z !== t.z) {
        const dx = c.x - t.x;
        const dz = c.z - t.z;
        t.set(c.x, t.y, c.z);
        this.persp.position.x += dx;
        this.persp.position.z += dz;
      }
    }
    this.updateWalls();
    for (const c of this.characters.values()) {
      if (c.state === 'waiting') {
        this.wantMotion(c);
      }
    }
    if (byHand) {
      this.onCameraMove();
    }
    this.requestRender();
  }

  private updateWalls(): void {
    const p = this.persp.position;
    for (const w of this.walls) {
      const low = lowered(w.wall, p.x, p.z);
      w.whole.visible = !low;
      w.low.visible = low;
    }
  }

  // --- the characters ---

  // setStates gives each character its role's state: in the 3D, who works
  // works at the desk and who waits for a person turns toward the viewer.
  setStates(states: ReadonlyMap<string, RoleState>): void {
    for (const [key, c] of this.characters) {
      const s = states.get(key) ?? 'idle';
      if (s !== c.state) {
        c.state = s;
        this.motion(c);
      }
    }
  }

  // live says whether the characters move with their state: in the 3D, for
  // whoever did not ask the system for less motion.
  private get live(): boolean {
    return this.kind === '3d' && !this.opts.reducedMotion();
  }

  // motion sets what a character does now: its work, or its idle pose; and
  // where it looks.
  private motion(c: Character): void {
    if (c.playing === null) {
      this.posed(c, () => {
        const working = this.live && c.state === 'working' && c.work !== null;
        if (working && c.work && !c.work.isRunning()) {
          c.idle?.stop();
          c.work.reset().play();
        } else if (!working && c.work?.isRunning()) {
          c.work.stop();
          c.idle?.play();
          c.mixer?.update(0);
        }
      });
    }
    if (c.ask !== null && (c.state !== 'waiting' || !this.live)) {
      clearTimeout(c.ask);
      c.ask = null;
    }
    if (c.state === 'waiting' && this.live && c.ask === null && c.playing === null) {
      this.askLater(c);
    }
    this.wantMotion(c);
  }

  private askLater(c: Character): void {
    c.ask = setTimeout(() => {
      c.ask = null;
      if (c.state === 'waiting' && this.live) {
        this.gesture(c.key, 'Ask');
      }
    }, ASK_EVERY);
  }

  // yawFor is where a character looks: at the camera of the 3D while it
  // waits for a person, ahead otherwise.
  private yawFor(c: Character): number {
    if (this.kind !== '3d' || c.state !== 'waiting') {
      return 0;
    }
    return facing(c.x, c.z, this.persp.position.x, this.persp.position.z);
  }

  // wantMotion draws the frames a character's motion needs: it turns at
  // once for whoever asked for less motion.
  private wantMotion(c: Character): void {
    const target = this.yawFor(c);
    if (this.opts.reducedMotion() || this.kind !== '3d') {
      c.yaw = target;
      c.holder.rotation.y = target;
    }
    this.requestRender();
  }

  private moving(c: Character): boolean {
    return c.playing !== null || (c.work?.isRunning() ?? false) || Math.abs(angleTo(c.yaw, this.yawFor(c))) > 1e-3;
  }

  // gesture plays a short gesture of a role's character, once: Ask (it
  // reaches out to the viewer) when it starts waiting for a person, Yes (it
  // nods) when its work is done. Nothing moves for whoever asked the system
  // for less motion.
  gesture(key: string, clip: 'Ask' | 'Yes'): void {
    if (this.opts.reducedMotion()) {
      return;
    }
    const c = this.characters.get(key);
    const anim = c?.clips.find((x) => x.name === clip);
    if (!c || !c.mixer || !anim || this.playing.has(key)) {
      return;
    }
    const a = c.mixer.clipAction(anim);
    this.posed(c, () => {
      c.work?.stop();
      c.idle?.stop();
      a.reset();
      a.setLoop(LoopOnce, 1);
      a.clampWhenFinished = false;
      a.play();
    });
    c.playing = a;
    const done = () => {
      c.mixer?.removeEventListener('finished', done);
      this.settle(c);
      this.playing.delete(key);
      this.motion(c);
      this.requestRender();
    };
    c.mixer.addEventListener('finished', done);
    this.playing.add(key);
    this.last = performance.now();
    this.requestRender();
  }

  private settle(c: Character): void {
    this.posed(c, () => {
      c.playing?.stop();
      c.playing = null;
      if (c.idle && c.mixer) {
        c.idle.play();
        c.mixer.update(0);
      }
    });
  }

  private stopAll(): void {
    for (const key of this.playing) {
      const c = this.characters.get(key);
      if (c) {
        this.settle(c);
      }
    }
    this.playing.clear();
  }

  resize(width: number, height: number): void {
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
    this.renderer.setSize(this.width, this.height, false);
    this.fit();
    this.requestRender();
  }

  // project is where a role's label goes, in CSS pixels of the canvas:
  // above its character's head. Null for a key the camera does not draw.
  project(key: string): Projected | null {
    const a = this.anchors.get(key);
    if (!a || (this.kind === 'map' && a.inRoom)) {
      return null;
    }
    return this.projectPoint(a.x, LABEL_HEIGHT, a.z + DESK.character);
  }

  // projectPoint is where a point of the world falls on the canvas.
  projectPoint(x: number, y: number, z: number): Projected {
    const cam = this.active;
    const v = new Vector3(x, y, z).project(cam);
    return { x: ((v.x + 1) / 2) * this.width, y: ((1 - v.y) / 2) * this.height, depth: v.z, shown: v.z > -1 && v.z < 1 };
  }

  // pick is the role under a point of the canvas, in CSS pixels: on the map
  // the team's, in the 3D the rooms' people too.
  pick(x: number, y: number): string | null {
    const ndc = new Vector2((x / this.width) * 2 - 1, -(y / this.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.active);
    const hit = this.raycaster.intersectObjects(this.kind === '3d' ? [...this.hits, ...this.roomHits] : this.hits, false)[0];
    return hit ? String(hit.object.userData.role) : null;
  }

  requestRender(): void {
    if (this.raf === 0) {
      this.last = performance.now();
      this.raf = requestAnimationFrame(this.frame);
    }
  }

  private frame = (now: number): void => {
    this.raf = 0;
    const dt = Math.min(0.1, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    let more = false;
    for (const c of this.characters.values()) {
      if (!this.moving(c)) {
        continue;
      }
      more = true;
      const m = c.mixer;
      if (m && (c.playing !== null || c.work?.isRunning())) {
        this.posed(c, () => m.update(dt));
      }
      const target = this.yawFor(c);
      const d = angleTo(c.yaw, target);
      const step = TURN_SPEED * dt;
      c.yaw = Math.abs(d) <= step ? target : c.yaw + Math.sign(d) * step;
      c.holder.rotation.y = c.yaw;
    }
    this.renderer.render(this.scene, this.active);
    this.onRender();
    if (more) {
      this.raf = requestAnimationFrame(this.frame);
    }
  };

  dispose(): void {
    if (this.raf !== 0) {
      cancelAnimationFrame(this.raf);
    }
    this.clear();
    if (this.kind === '3d') {
      this.controls.dispose();
    }
    this.floorTexture.dispose();
    this.renderer.dispose();
  }
}

// angleTo is the shortest turn from a to b, in radians.
function angleTo(a: number, b: number): number {
  let d = (b - a) % (2 * Math.PI);
  if (d > Math.PI) {
    d -= 2 * Math.PI;
  } else if (d < -Math.PI) {
    d += 2 * Math.PI;
  }
  return d;
}

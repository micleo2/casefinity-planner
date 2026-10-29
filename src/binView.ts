import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { syncFaces, syncLines } from "replicad-threejs-helper";
import type { Solid } from "./sizing.ts";

/**
 * The selected bin in 3D, with a section tool. Same scene as casefinity's
 * viewer (src/vendor/casefinity/viewer.ts), plus the bin's sized items and an
 * optional cut plane.
 *
 * The cut is GPU clipping — moving it is a uniform change, no CAD rebuild.
 * Clipping alone leaves the cut solids hollow, so each one gets a cap: the
 * classic stencil trick (three.js webgl_clipping_stencil). Back faces
 * increment the stencil, front faces decrement it, so wherever a pixel of the
 * cut plane lies inside a closed solid the count is non-zero; a hatched plane
 * drawn only there fills the cut face. Bins and items are capped in separate
 * passes so they get their own colours.
 *
 * Frame: casefinity's bin frame — X/Y centred on the bin, Z up from its
 * underside. Item solids from placeInBin use the same frame.
 */

const FACE = 0x6b8fb3;
const EDGE = 0x1a2530;
const ITEM = 0xd9a441;
const BIN_CAP: [string, string] = ["#e8eef5", "#6b8fb3"];
const ITEM_CAP: [string, string] = ["#f6e3b8", "#b07d22"];
/** Hatch pitch on the cut face, mm. */
const HATCH = 3;

export type Axis = "x" | "y" | "z";

export interface Section {
  enabled: boolean;
  axis: Axis;
  /** Cut position along the axis in the bin frame, mm. */
  pos: number;
  /** Remove the other half. */
  flipped: boolean;
  /** Show the removed half as a faint ghost. */
  ghost: boolean;
}

/** Which half is removed by default: the one facing the default camera (+X, −Y, +Z). */
const NEAR_SIGN: Record<Axis, number> = { x: 1, y: -1, z: 1 };
const AXIS_VEC: Record<Axis, THREE.Vector3> = {
  x: new THREE.Vector3(1, 0, 0),
  y: new THREE.Vector3(0, 1, 0),
  z: new THREE.Vector3(0, 0, 1),
};

interface ShapeMeshes {
  faces: Parameters<typeof syncFaces>[1];
  edges: Parameters<typeof syncLines>[1];
}

function hatchTexture([bg, line]: [string, string]): THREE.CanvasTexture {
  const n = 32;
  const c = document.createElement("canvas");
  c.width = c.height = n;
  const g = c.getContext("2d")!;
  g.fillStyle = bg;
  g.fillRect(0, 0, n, n);
  g.strokeStyle = line;
  g.lineWidth = 4;
  // One diagonal, plus its wrapped corners so the tile repeats seamlessly
  for (const o of [-n, 0, n]) {
    g.beginPath();
    g.moveTo(o, n);
    g.lineTo(o + n, 0);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** Back faces +1, front faces −1, no colour or depth: leaves the stencil odd inside the solid. */
function stencilMaterials(plane: THREE.Plane): THREE.Material[] {
  return ([THREE.BackSide, THREE.FrontSide] as const).map((side) => {
    const op = side === THREE.BackSide ? THREE.IncrementWrapStencilOp : THREE.DecrementWrapStencilOp;
    return new THREE.MeshBasicMaterial({
      side,
      clippingPlanes: [plane],
      depthWrite: false,
      depthTest: false,
      colorWrite: false,
      stencilWrite: true,
      stencilFunc: THREE.AlwaysStencilFunc,
      stencilFail: op,
      stencilZFail: op,
      stencilZPass: op,
    });
  });
}

export class BinView {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  /** Visible, clipped geometry. */
  private group = new THREE.Group();
  /** Stencil writers and the removed half's ghost, rebuilt with the geometry. */
  private extras = new THREE.Group();
  /** The items and their stencil writers, so they can be hidden together. */
  private items = new THREE.Group();
  private itemStencils = new THREE.Group();
  private plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private ghostPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0);
  private binCap: THREE.Mesh;
  private itemCap: THREE.Mesh;
  private faceMat: THREE.MeshStandardMaterial;
  private edgeMat: THREE.LineBasicMaterial;
  private itemMat: THREE.MeshStandardMaterial;
  private ghostMat: THREE.MeshStandardMaterial;
  private ghostEdgeMat: THREE.LineBasicMaterial;
  private stencilBin = stencilMaterials(this.plane);
  private stencilItem = stencilMaterials(this.plane);
  private bounds = new THREE.Box3();
  private hasFramed = false;
  section: Section = { enabled: false, axis: "y", pos: 0, flipped: false, ghost: true };
  showItems = true;

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, stencil: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.localClippingEnabled = true;
    container.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(0x16181d);
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 10_000);
    this.camera.up.set(0, 0, 1); // CAD models are Z-up
    this.camera.position.set(400, -400, 300);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.2));
    const sun = new THREE.DirectionalLight(0xffffff, 1.5);
    sun.position.set(300, -500, 600);
    this.scene.add(sun);
    const grid = new THREE.GridHelper(1000, 50, 0x2c313a, 0x22262d);
    grid.rotation.x = Math.PI / 2;
    this.scene.add(grid);

    const clip = [this.plane];
    const ghostClip = [this.ghostPlane];
    this.faceMat = new THREE.MeshStandardMaterial({ color: FACE, metalness: 0.05, roughness: 0.65, side: THREE.DoubleSide, clippingPlanes: clip });
    this.edgeMat = new THREE.LineBasicMaterial({ color: EDGE, clippingPlanes: clip });
    this.itemMat = new THREE.MeshStandardMaterial({ color: ITEM, metalness: 0.05, roughness: 0.6, clippingPlanes: clip });
    this.ghostMat = new THREE.MeshStandardMaterial({
      color: FACE, transparent: true, opacity: 0.1, depthWrite: false, side: THREE.DoubleSide, clippingPlanes: ghostClip,
    });
    this.ghostEdgeMat = new THREE.LineBasicMaterial({ color: 0x8aa4bf, transparent: true, opacity: 0.12, clippingPlanes: ghostClip });

    this.binCap = this.makeCap(BIN_CAP, 1.1);
    this.itemCap = this.makeCap(ITEM_CAP, 2.1);
    this.scene.add(this.extras, this.binCap, this.itemCap, this.group);

    const resize = () => {
      const { clientWidth: w, clientHeight: h } = container;
      if (!w || !h) return;
      this.renderer.setSize(w, h);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    };
    new ResizeObserver(resize).observe(container);
    resize();

    this.renderer.setAnimationLoop(() => {
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    });
    this.applySection();
  }

  /** A hatched plane drawn only where the stencil is non-zero, resetting it as it goes. */
  private makeCap(colors: [string, string], renderOrder: number): THREE.Mesh {
    const mat = new THREE.MeshBasicMaterial({
      map: hatchTexture(colors),
      side: THREE.DoubleSide,
      stencilWrite: true,
      stencilRef: 0,
      stencilFunc: THREE.NotEqualStencilFunc,
      stencilFail: THREE.ReplaceStencilOp,
      stencilZFail: THREE.ReplaceStencilOp,
      stencilZPass: THREE.ReplaceStencilOp,
      polygonOffset: true,
      polygonOffsetFactor: -1,
    });
    const cap = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    cap.renderOrder = renderOrder;
    cap.onAfterRender = (r) => r.clearStencil();
    return cap;
  }

  update(shapes: ShapeMeshes[], items: Solid[]): void {
    for (const g of [this.group, this.extras, this.items, this.itemStencils]) {
      g.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
      g.clear();
    }

    const binGeos: THREE.BufferGeometry[] = [];
    for (const { faces, edges } of shapes) {
      const faceGeo = new THREE.BufferGeometry();
      syncFaces(faceGeo, faces);
      binGeos.push(faceGeo);
      this.group.add(new THREE.Mesh(faceGeo, this.faceMat));
      const edgeGeo = new THREE.BufferGeometry();
      syncLines(edgeGeo, edges);
      this.group.add(new THREE.LineSegments(edgeGeo, this.edgeMat));
      this.extras.add(new THREE.LineSegments(edgeGeo, this.ghostEdgeMat));
      const ghost = new THREE.Mesh(faceGeo, this.ghostMat);
      ghost.renderOrder = 10;
      this.extras.add(ghost);
    }
    this.bounds.setFromObject(this.group);
    this.group.add(this.items);
    this.extras.add(this.itemStencils);

    for (const so of items) {
      const mesh = new THREE.Mesh();
      if (so.kind === "box") {
        mesh.geometry = new THREE.BoxGeometry(so.sx, so.sy, so.sz);
      } else {
        mesh.geometry = new THREE.CylinderGeometry(so.r, so.r, so.len, 48);
        // three's cylinders run along Y
        if (so.axis === "z") mesh.rotation.x = Math.PI / 2;
        if (so.axis === "x") mesh.rotation.z = Math.PI / 2;
      }
      mesh.material = this.itemMat;
      mesh.position.set(so.cx, so.cy, so.cz);
      this.items.add(mesh);
      const outline = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry, 30), this.edgeMat);
      outline.position.copy(mesh.position);
      outline.rotation.copy(mesh.rotation);
      this.items.add(outline);
      for (const m of this.stencilItem) {
        const s = new THREE.Mesh(mesh.geometry, m);
        s.position.copy(mesh.position);
        s.rotation.copy(mesh.rotation);
        s.renderOrder = 2;
        this.itemStencils.add(s);
      }
    }
    for (const geo of binGeos) {
      for (const m of this.stencilBin) {
        const s = new THREE.Mesh(geo, m);
        s.renderOrder = 1;
        this.extras.add(s);
      }
    }

    if (!this.hasFramed) {
      this.frame();
      this.hasFramed = true;
    }
    this.applySection();
  }

  /** Cut range along an axis: the bin's extent, mm. */
  range(axis: Axis): [number, number] {
    if (this.bounds.isEmpty()) return [0, 0];
    return [this.bounds.min[axis], this.bounds.max[axis]];
  }

  setSection(patch: Partial<Section>): void {
    Object.assign(this.section, patch);
    this.applySection();
  }

  setShowItems(show: boolean): void {
    this.showItems = show;
    this.applySection();
  }

  private applySection(): void {
    const { enabled, axis, flipped, ghost } = this.section;
    const [lo, hi] = this.range(axis);
    const pos = (this.section.pos = Math.min(hi, Math.max(lo, this.section.pos)));
    // three keeps n·p + c ≥ 0, so the normal points away from the removed half.
    const sign = NEAR_SIGN[axis] * (flipped ? -1 : 1);
    const n = AXIS_VEC[axis].clone().multiplyScalar(-sign);
    this.plane.set(n, -n.dot(AXIS_VEC[axis]) * pos);
    this.ghostPlane.copy(this.plane).negate();

    const on = enabled && !this.bounds.isEmpty();
    this.renderer.localClippingEnabled = on;
    this.extras.visible = on;
    this.extras.children.forEach((o) => {
      if (o.renderOrder === 10 || (o as THREE.LineSegments).isLineSegments) o.visible = ghost;
    });
    this.items.visible = this.itemStencils.visible = this.showItems;
    for (const cap of [this.binCap, this.itemCap]) {
      cap.visible = on && (cap === this.binCap || this.showItems);
      if (!cap.visible) continue;
      // Centre the cap over the bin, in the cut plane, big enough to cover it
      const size = this.bounds.getSize(new THREE.Vector3()).length() * 1.5;
      const center = this.bounds.getCenter(new THREE.Vector3());
      this.plane.projectPoint(center, cap.position);
      cap.lookAt(cap.position.clone().add(n));
      cap.scale.set(size, size, 1);
      const map = (cap.material as THREE.MeshBasicMaterial).map!;
      map.repeat.set(size / HATCH, size / HATCH);
    }
  }

  /** Turn the camera square to the cut face, from the removed side. */
  faceCut(): void {
    if (this.bounds.isEmpty()) return;
    const { axis, flipped } = this.section;
    const center = this.bounds.getCenter(new THREE.Vector3());
    const radius = this.bounds.getSize(new THREE.Vector3()).length() / 2;
    const dir = AXIS_VEC[axis].clone().multiplyScalar(NEAR_SIGN[axis] * (flipped ? -1 : 1));
    // Straight down would be parallel to the Z-up camera; lean it a hair toward the front
    if (axis === "z") dir.y -= 0.02;
    this.controls.target.copy(center);
    this.camera.position.copy(center).addScaledVector(dir.normalize(), radius * 2.2);
  }

  frame(): void {
    const box = new THREE.Box3().setFromObject(this.group);
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const radius = box.getSize(new THREE.Vector3()).length() / 2;
    this.controls.target.copy(center);
    const direction = new THREE.Vector3(1, -1, 0.8).normalize();
    this.camera.position.copy(center).addScaledVector(direction, radius * 2.4);
  }
}

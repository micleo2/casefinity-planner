import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { Layout } from "./bins.ts";
import { placeInBin, sizeItem } from "./sizing.ts";

/**
 * The whole case in 3D: every bin as a see-through shell, and each item (box
 * or cylinder, in the orientation it was sized for) standing inside its bin.
 * Built from plain boxes and cylinders — no CAD — so it updates instantly.
 *
 * World frame matches the grid: X to the right, +Y toward the back (row 1),
 * Z up from the case floor. Renders on demand (orbit, resize, update).
 */

const BIN = 0x3b6fe0;
const SPACER = 0x9ca3af;
const SELECTED = 0x1d4ed8;

export class CaseView {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(40, 1, 1, 20_000);
  private controls: OrbitControls;
  private group = new THREE.Group();
  private framedFor = "";

  constructor(private container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(this.renderer.domElement);
    this.scene.background = new THREE.Color(0xf8fafc);
    this.camera.up.set(0, 0, 1);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.addEventListener("change", () => this.draw());
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8899aa, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(-300, -500, 800);
    this.scene.add(sun);
    this.scene.add(this.group);
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
  }

  private resize() {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.draw();
  }

  private draw() {
    this.renderer.render(this.scene, this.camera);
  }

  private clear() {
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else mat?.dispose();
    });
    this.group.clear();
  }

  update(layout: Layout, selectedId: string | null) {
    this.clear();
    const s = layout.settings;
    const P = s.gridSpacing;
    const W = s.areaX * P;
    const D = s.areaY * P;
    const H = s.overallHeight;

    // Case floor with the grid drawn on it
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, D), new THREE.MeshStandardMaterial({ color: 0xe5e7eb }));
    floor.position.set(W / 2, D / 2, -0.2);
    this.group.add(floor);
    const lines: number[] = [];
    for (let i = 0; i <= s.areaX; i++) lines.push(i * P, 0, 0, i * P, D, 0);
    for (let j = 0; j <= s.areaY; j++) lines.push(0, j * P, 0, W, j * P, 0);
    const gridGeo = new THREE.BufferGeometry();
    gridGeo.setAttribute("position", new THREE.Float32BufferAttribute(lines, 3));
    this.group.add(new THREE.LineSegments(gridGeo, new THREE.LineBasicMaterial({ color: 0xc7d2ea })));

    const items = new Map(layout.items.map((it) => [it.id, it]));
    const itemMat = new THREE.MeshStandardMaterial({ color: 0x94a3b8, roughness: 0.6 });
    const itemSelMat = new THREE.MeshStandardMaterial({ color: 0x64748b, roughness: 0.6 });

    for (const bin of layout.bins) {
      const sel = bin.id === selectedId;
      const color = sel ? SELECTED : bin.itemId || bin.title !== "Spacer" ? BIN : SPACER;
      const bw = bin.unitsX * P - 2 * s.clear;
      const bd = bin.unitsY * P - 2 * s.clear;
      const bh = bin.height ?? H;
      const cx = (bin.col + bin.unitsX / 2) * P;
      const cy = (s.areaY - bin.row - bin.unitsY / 2) * P;

      const shellGeo = new THREE.BoxGeometry(bw, bd, bh);
      const shell = new THREE.Mesh(shellGeo, new THREE.MeshStandardMaterial({
        color, transparent: true, opacity: sel ? 0.28 : 0.14, depthWrite: false,
      }));
      shell.position.set(cx, cy, bh / 2);
      shell.renderOrder = 2;
      this.group.add(shell);
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(shellGeo), new THREE.LineBasicMaterial({ color }));
      edges.position.copy(shell.position);
      this.group.add(edges);

      const item = bin.itemId ? items.get(bin.itemId) : undefined;
      if (!item) continue;
      const sizing = sizeItem(item, s);
      const solids = sizing.ok ? placeInBin(item, sizing, bin, s) : null;
      for (const so of solids ?? []) {
        let geo: THREE.BufferGeometry;
        const mesh = new THREE.Mesh();
        if (so.kind === "box") {
          geo = new THREE.BoxGeometry(so.sx, so.sy, so.sz);
        } else {
          geo = new THREE.CylinderGeometry(so.r, so.r, so.len, 40);
          // three's cylinders run along Y
          if (so.axis === "z") mesh.rotation.x = Math.PI / 2;
          if (so.axis === "x") mesh.rotation.z = Math.PI / 2;
        }
        mesh.geometry = geo;
        mesh.material = sel ? itemSelMat : itemMat;
        mesh.position.set(cx + so.cx, cy + so.cy, so.cz);
        this.group.add(mesh);
        const outline = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 30), new THREE.LineBasicMaterial({ color: 0x334155 }));
        outline.position.copy(mesh.position);
        outline.rotation.copy(mesh.rotation);
        this.group.add(outline);
      }
    }

    // Frame the case the first time, and whenever its size changes.
    const key = `${W}x${D}x${H}`;
    if (key !== this.framedFor) {
      this.framedFor = key;
      const target = new THREE.Vector3(W / 2, D / 2, H / 3);
      const r = Math.hypot(W, D, H);
      this.controls.target.copy(target);
      this.camera.position.set(W * 0.2, -D * 1.25, r * 0.95);
      this.controls.update();
    }
    this.draw();
  }
}

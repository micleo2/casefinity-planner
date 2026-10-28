import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { syncFaces, syncLines } from "replicad-threejs-helper";

interface ShapeMeshes {
  faces: Parameters<typeof syncFaces>[1];
  edges: Parameters<typeof syncLines>[1];
}

const FACE_MATERIAL = new THREE.MeshStandardMaterial({
  color: 0x6b8fb3,
  metalness: 0.05,
  roughness: 0.65,
  side: THREE.DoubleSide,
});
const EDGE_MATERIAL = new THREE.LineBasicMaterial({ color: 0x1a2530 });

export class Viewer {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private group = new THREE.Group();
  private hasFramed = false;

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(0x16181d);
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 10_000);
    // CAD models are Z-up
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(400, -400, 300);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.2));
    const sun = new THREE.DirectionalLight(0xffffff, 1.5);
    sun.position.set(300, -500, 600);
    this.scene.add(sun);

    const grid = new THREE.GridHelper(1000, 50, 0x2c313a, 0x22262d);
    grid.rotation.x = Math.PI / 2; // move grid into the XY plane
    this.scene.add(grid);
    this.scene.add(this.group);

    const resize = () => {
      const { clientWidth: w, clientHeight: h } = container;
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
  }

  update(shapes: ShapeMeshes[]): void {
    for (const child of this.group.children) {
      (child as THREE.Mesh).geometry.dispose();
    }
    this.group.clear();

    for (const { faces, edges } of shapes) {
      const faceGeometry = new THREE.BufferGeometry();
      syncFaces(faceGeometry, faces);
      this.group.add(new THREE.Mesh(faceGeometry, FACE_MATERIAL));

      const edgeGeometry = new THREE.BufferGeometry();
      syncLines(edgeGeometry, edges);
      this.group.add(new THREE.LineSegments(edgeGeometry, EDGE_MATERIAL));
    }

    if (!this.hasFramed) {
      this.frame();
      this.hasFramed = true;
    }
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

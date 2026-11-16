import * as THREE from 'three';
import { TrackballControls } from 'three/examples/jsm/controls/TrackballControls.js';
import type { MeshData } from '../core/obj';
import type { Orientation } from '../core/orientation';

export type StandardView = 'fit' | 'top' | 'front' | 'side';

const PLAIN: [number, number, number] = [0.62, 0.70, 0.78];
const DIMMED: [number, number, number] = [0.50, 0.53, 0.57];
const SELECTED: [number, number, number] = [1.0, 0.55, 0.1];
/** soft tints for detected flat areas */
const TINTS: [number, number, number][] = [
  [0.36, 0.62, 0.90], [0.40, 0.76, 0.56], [0.78, 0.60, 0.88], [0.90, 0.76, 0.40],
  [0.45, 0.80, 0.82], [0.90, 0.58, 0.62], [0.62, 0.72, 0.42], [0.60, 0.62, 0.92],
];

/**
 * 3D view of a scan. Draws only when something changes (no idle GPU use),
 * so it is light on a laptop battery.
 */
export class Viewer3D {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(35, 1, 1, 100000);
  private controls: TrackballControls;
  private light = new THREE.DirectionalLight(0xffffff, 2.2);
  private model: THREE.Mesh | null = null;
  private data: MeshData | null = null;
  private labels: Int32Array | null = null;
  private showAreas = false;
  private selected: number | null = null;
  /** which way is up in this scan (the scanner's own axes are arbitrary) */
  private axes: Orientation = { up: [0, 0, 1], right: [1, 0, 0], forward: [0, 1, 0] };
  private center = new THREE.Vector3();
  private radius = 1000;
  private frame = 0;
  private needsRender = true;
  private resizeObserver: ResizeObserver;
  private raycaster = new THREE.Raycaster();
  private down: { x: number; y: number } | null = null;

  /** called with the flat-area id under a click, or -1 */
  onPick: ((region: number) => void) | null = null;

  constructor(private host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    host.appendChild(this.renderer.domElement);

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x5a6470, 1.1));
    this.camera.add(this.light);
    this.light.position.set(0.4, 0.6, 1);
    this.scene.add(this.camera);

    this.controls = new TrackballControls(this.camera, this.renderer.domElement);
    this.controls.rotateSpeed = 3;
    this.controls.zoomSpeed = 1.4;
    this.controls.panSpeed = 0.9;
    this.controls.staticMoving = true;
    this.controls.addEventListener('change', () => this.requestRender());

    // a click (press and release without moving) picks; a drag rotates
    const el = this.renderer.domElement;
    // Trackpad pinch (wheel + ctrlKey): zoom the model at a comfortable speed.
    // Handled before the orbit controls see it, which would treat the tiny pinch steps as almost nothing.
    el.addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault(); e.stopImmediatePropagation();
      this.dolly(Math.exp(Math.max(-40, Math.min(40, e.deltaY)) * 0.01));
    }, { passive: false, capture: true });
    el.addEventListener('pointerdown', (e) => { this.down = e.button === 0 ? { x: e.clientX, y: e.clientY } : null; });
    el.addEventListener('pointerup', (e) => {
      const d = this.down; this.down = null;
      if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) return;
      this.pick(e.clientX, e.clientY);
    });

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.resize();
    this.loop();
  }

  setScan(data: MeshData | null, labels: Int32Array | null, orientation?: Orientation) {
    if (data === this.data) return;
    if (orientation) this.axes = orientation;
    if (this.model) {
      this.scene.remove(this.model);
      this.model.geometry.dispose();
      (this.model.material as THREE.Material).dispose();
      this.model = null;
    }
    this.data = data; this.labels = labels; this.selected = null;
    if (data) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
      g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(data.positions.length), 3));
      g.setIndex(new THREE.BufferAttribute(data.indices, 1));
      g.computeVertexNormals();
      g.computeBoundingSphere();
      const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75, metalness: 0, side: THREE.DoubleSide });
      this.model = new THREE.Mesh(g, material);
      this.scene.add(this.model);
      this.center.copy(g.boundingSphere!.center);
      this.radius = Math.max(g.boundingSphere!.radius, 1);
      this.paint();
      this.setView('fit');
    }
    this.requestRender();
  }

  /** Colour the detected flat areas (true) or show the scan plain (false). */
  setShowAreas(show: boolean) { if (show !== this.showAreas) { this.showAreas = show; this.paint(); } }
  setSelected(region: number | null) { if (region !== this.selected) { this.selected = region; this.paint(); } }

  private paint() {
    if (!this.model || !this.data) return;
    const colors = this.model.geometry.getAttribute('color') as THREE.BufferAttribute;
    const c = colors.array as Float32Array, ix = this.data.indices, labels = this.labels;
    const put = (v: number, rgb: [number, number, number]) => { c[v * 3] = rgb[0]; c[v * 3 + 1] = rgb[1]; c[v * 3 + 2] = rgb[2]; };
    const nF = ix.length / 3;
    if (!this.showAreas || !labels) {
      for (let v = 0; v < c.length / 3; v++) put(v, PLAIN);
    } else {
      // two passes so that area colours win over the grey in-between at shared points
      for (let pass = 0; pass < 2; pass++) {
        for (let f = 0; f < nF; f++) {
          const l = labels[f];
          if ((pass === 0) !== (l < 0)) continue;
          const rgb = l < 0 ? DIMMED : l === this.selected ? SELECTED : TINTS[l % TINTS.length];
          put(ix[f * 3], rgb); put(ix[f * 3 + 1], rgb); put(ix[f * 3 + 2], rgb);
        }
      }
      if (this.selected !== null) {
        for (let f = 0; f < nF; f++) {
          if (labels[f] === this.selected) { put(ix[f * 3], SELECTED); put(ix[f * 3 + 1], SELECTED); put(ix[f * 3 + 2], SELECTED); }
        }
      }
    }
    colors.needsUpdate = true;
    this.requestRender();
  }

  private pick(clientX: number, clientY: number) {
    if (!this.model || !this.labels || !this.onPick) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.intersectObject(this.model, false)[0];
    this.onPick(hit && hit.faceIndex != null ? this.labels[hit.faceIndex] : -1);
  }

  setView(view: StandardView) {
    const v = (a: ArrayLike<number>) => new THREE.Vector3(a[0], a[1], a[2]);
    const up = v(this.axes.up), right = v(this.axes.right), forward = v(this.axes.forward);
    if (view === 'top') this.lookFrom(up.clone(), forward); // from above, looking down
    else if (view === 'front') this.lookFrom(forward.clone().negate(), up);
    else if (view === 'side') this.lookFrom(right.clone(), up);
    else this.lookFrom(right.clone().multiplyScalar(0.55).addScaledVector(forward, -0.75).addScaledVector(up, 0.6).normalize(), up);
  }

  /** Look straight at a flat area (against its normal). */
  faceDirection(normal: ArrayLike<number>, upHint: ArrayLike<number>) {
    this.lookFrom(new THREE.Vector3(normal[0], normal[1], normal[2]).normalize(), new THREE.Vector3(upHint[0], upHint[1], upHint[2]));
  }

  private lookFrom(dir: THREE.Vector3, up: THREE.Vector3) {
    const distance = (this.radius / Math.sin(THREE.MathUtils.degToRad(this.camera.fov / 2))) * 1.05;
    this.camera.up.copy(up);
    this.camera.position.copy(this.center).addScaledVector(dir, distance);
    this.camera.near = Math.max(distance / 1000, 0.1);
    this.camera.far = distance * 20;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(this.center);
    this.controls.minDistance = this.radius * 0.02;
    this.controls.maxDistance = distance * 8;
    this.controls.update();
    this.requestRender();
  }

  /** Moves the camera towards (factor < 1) or away from (factor > 1) the point it looks at. */
  private dolly(factor: number) {
    const offset = this.camera.position.clone().sub(this.controls.target);
    const distance = THREE.MathUtils.clamp(offset.length() * factor, this.controls.minDistance, this.controls.maxDistance);
    this.camera.position.copy(this.controls.target).add(offset.setLength(distance));
    this.controls.update();
    this.requestRender();
  }

  requestRender() { this.needsRender = true; }

  private loop = () => {
    this.frame = requestAnimationFrame(this.loop);
    this.controls.update();
    if (!this.needsRender) return;
    this.needsRender = false;
    this.renderer.render(this.scene, this.camera);
  };

  private resize() {
    const w = Math.max(this.host.clientWidth, 1), h = Math.max(this.host.clientHeight, 1);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.controls.handleResize();
    this.requestRender();
  }

  dispose() {
    cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.setScan(null, null);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

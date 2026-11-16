import * as THREE from 'three';
import { TrackballControls } from 'three/examples/jsm/controls/TrackballControls.js';
import type { MeshData } from '../core/obj';

export type StandardView = 'fit' | 'top' | 'front' | 'side';

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
  private center = new THREE.Vector3();
  private radius = 1000;
  private frame = 0;
  private resizeObserver: ResizeObserver;

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

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.resize();
    this.loop();
  }

  setMesh(data: MeshData | null) {
    if (this.model) {
      this.scene.remove(this.model);
      this.model.geometry.dispose();
      (this.model.material as THREE.Material).dispose();
      this.model = null;
    }
    if (data) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
      g.setIndex(new THREE.BufferAttribute(data.indices, 1));
      g.computeVertexNormals();
      g.computeBoundingSphere();
      const material = new THREE.MeshStandardMaterial({ color: 0x9fb3c8, roughness: 0.75, metalness: 0, side: THREE.DoubleSide });
      this.model = new THREE.Mesh(g, material);
      this.scene.add(this.model);
      this.center.copy(g.boundingSphere!.center);
      this.radius = Math.max(g.boundingSphere!.radius, 1);
      this.setView('fit');
    }
    this.requestRender();
  }

  setView(view: StandardView) {
    const dir = new THREE.Vector3();
    const up = new THREE.Vector3(0, 0, 1);
    if (view === 'top') { dir.set(0, 0, 1); up.set(0, 1, 0); }
    else if (view === 'front') dir.set(0, -1, 0);
    else if (view === 'side') dir.set(1, 0, 0);
    else dir.set(0.55, -0.75, 0.6).normalize();
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

  private needsRender = true;
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
    this.setMesh(null);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

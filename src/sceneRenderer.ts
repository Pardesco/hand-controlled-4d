/**
 * Composites the live webcam and the projected polytope into ONE canvas, in one
 * pass, at capture time (spec §1). Layers, back to front:
 *
 *   1. Video background -- fullscreen quad sampling the webcam through the
 *      same crop/mirror uniforms coords.ts produces. The room is untouched:
 *      no filter, no grade (spec §5).
 *   2. Hand masks -- convex hulls written into the DEPTH BUFFER ONLY
 *      (colorWrite: false) at the depth estimated from palm span. The polytope
 *      then depth-tests against them for free (spec §3).
 *   3. Polytope edges -- instanced tubes (never LINES), coloured by
 *      pre-projection W so the fourth dimension is legible as hue. A bright
 *      core plus an additive halo plus a subtle two-sided chromatic split
 *      carry the glow (spec §5).
 *   4. Engage feedback -- fingertip rings and a chamfered construction frame,
 *      drawn in an orthographic overlay pass INTO THE SAME CANVAS so they are
 *      part of the recording (spec §6).
 */

import * as THREE from "three";
import { cropTransformToUniform, type CropTransform } from "./coords.ts";
import type { HandMask } from "./handMask.ts";
import type { Polytope4D } from "./polychora.ts";
import { applyToVec, projectTo3D, type Mat4, type Vec3, type Vec4 } from "./polytope4d.ts";
import type { Point2D } from "./types.ts";

/** Enough for the 120-cell; instanced buffers are allocated once at maximum. */
const MAX_EDGES = 1200;
const MAX_VERTICES = 600;
/** MediaPipe hands have 21 landmarks; the expanded hull can never exceed that. */
const MAX_HULL_POINTS = 24;

const CAMERA_FOV = 50;
const CAMERA_DISTANCE = 3.2;

export type SceneStyle = {
  /** World-space tube radius of the edge core. */
  tubeRadius: number;
  /** Halo opacity, 0..1. */
  glowStrength: number;
  /** World-space offset of the red/blue ghost passes. 0 disables. */
  chromaSplit: number;
  /** Hue at w = 0 (0..1). */
  hueBase: number;
  /** Hue swing from w = -1 to w = +1. */
  hueRange: number;
  /** Overall polytope scale. */
  objectScale: number;
  /** Vertical placement of the object centre in display space (0 top, 1 bottom). */
  objectCenterY: number;
  /** Fingertip ring / frame accent colour. */
  accentColor: string;
};

export const DEFAULT_SCENE_STYLE: SceneStyle = {
  tubeRadius: 0.016,
  glowStrength: 0.35,
  chromaSplit: 0.012,
  hueBase: 0.52,
  hueRange: 0.33,
  objectScale: 0.95,
  objectCenterY: 0.38,
  accentColor: "#35e0d6",
};

export type RingFeedback = {
  /** Pinch midpoint, display space. */
  center: Point2D;
  /** Ring radius, display-normalized (of canvas height). */
  radius: number;
  /** 0..1 -- brightens on pinch. */
  intensity: number;
};

/** A small coloured dot, e.g. the selector hand's per-plane fingertip legend. */
export type MarkerFeedback = {
  center: Point2D;
  /** Radius, display-normalized (of canvas height). */
  radius: number;
  /** 0..1. */
  intensity: number;
  /** CSS hex colour. */
  color: string;
  /**
   * Optional short tag ("ZW", "REV") drawn as a pill beside the dot, so the
   * active plane is readable at the fingertip itself. Empty/undefined = none.
   */
  label?: string;
};

/** Marker mesh pool size: 4 plane fingers + thumb, with headroom. */
export const MAX_MARKERS = 8;

export type FeedbackState = {
  left: RingFeedback | null;
  right: RingFeedback | null;
  /** 0..1, fades the construction frame in while the clutch is engaged. */
  engage: number;
  /** Up to MAX_MARKERS dots, drawn into the recorded frame. */
  markers: MarkerFeedback[];
};

function disposeMaterial(material: THREE.Material | THREE.Material[]): void {
  if (Array.isArray(material)) material.forEach((m) => m.dispose());
  else material.dispose();
}

export class SceneRenderer {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private overlayScene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  /** Display space: x 0..1 left-right, y 0..1 top-bottom, matching coords.ts. */
  private overlayCamera = new THREE.OrthographicCamera(0, 1, 0, 1, -10, 10);

  private style: SceneStyle = { ...DEFAULT_SCENE_STYLE };

  // Background
  private videoTexture: THREE.VideoTexture | null = null;
  private backgroundMaterial: THREE.ShaderMaterial;
  private backgroundQuad: THREE.Mesh;

  // Polytope
  private polytope: Polytope4D | null = null;
  private eyeW = 2.2;
  private core: THREE.InstancedMesh;
  private halo: THREE.InstancedMesh;
  private chromaA: THREE.InstancedMesh;
  private chromaB: THREE.InstancedMesh;
  private joints: THREE.InstancedMesh;
  private objectGroup = new THREE.Group();

  // Hand occlusion
  private maskMeshes: THREE.Mesh[] = [];
  private maskPositions: Float32Array[] = [];

  // Feedback overlay
  private rings: THREE.Mesh[] = [];
  private ringMaterials: THREE.MeshBasicMaterial[] = [];
  private markers: THREE.Mesh[] = [];
  private markerMaterials: THREE.MeshBasicMaterial[] = [];
  private labels: THREE.Mesh[] = [];
  private labelMaterials: THREE.MeshBasicMaterial[] = [];
  /** Lazily built pill textures, keyed by "text|color". */
  private readonly labelTextures = new Map<string, THREE.CanvasTexture>();
  private frame: THREE.LineSegments;
  private frameMaterial: THREE.LineBasicMaterial;

  // Scratch (the render loop must not allocate)
  private readonly scratchVec4: Vec4 = [0, 0, 0, 0];
  private readonly scratchVec3: Vec3 = [0, 0, 0];
  private readonly projected = new Float32Array(MAX_VERTICES * 3);
  private readonly wCoords = new Float32Array(MAX_VERTICES);
  private readonly dummy = new THREE.Object3D();
  private readonly colorScratch = new THREE.Color();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly edgeDir = new THREE.Vector3();
  private readonly unprojectScratch = new THREE.Vector3();

  constructor(private canvas: HTMLCanvasElement) {
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        canvas,
        antialias: true,
        alpha: false,
        powerPreference: "high-performance",
      });
    } catch (err) {
      throw new Error(
        `WebGL is unavailable (${err instanceof Error ? err.message : String(err)}).`
      );
    }
    this.renderer = renderer;
    this.renderer.autoClear = false;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.camera = new THREE.PerspectiveCamera(CAMERA_FOV, 1, 0.1, 100);
    this.camera.position.set(0, 0, CAMERA_DISTANCE);
    this.camera.lookAt(0, 0, 0);

    // ---- background video quad
    this.backgroundMaterial = new THREE.ShaderMaterial({
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uMap: { value: null },
        uCrop: { value: new THREE.Vector4(1, 1, 0, 0) },
        uMirror: { value: 0 },
        uHasVideo: { value: 0 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = position.xy * 0.5 + 0.5;
          gl_Position = vec4(position.xy, 1.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D uMap;
        uniform vec4 uCrop;   // fracX, fracY, offsetX, offsetY
        uniform float uMirror;
        uniform float uHasVideo;
        varying vec2 vUv;
        void main() {
          // Display space is y-down from the top-left; GL gives y-up. One flip.
          vec2 d = vec2(vUv.x, 1.0 - vUv.y);
          float x = uMirror > 0.5 ? 1.0 - d.x : d.x;
          vec2 v = vec2(x * uCrop.x + uCrop.z, d.y * uCrop.y + uCrop.w);
          // VideoTexture is y-up; undo the display flip at the sample.
          vec3 rgb = uHasVideo > 0.5 ? texture2D(uMap, vec2(v.x, 1.0 - v.y)).rgb : vec3(0.0);
          gl_FragColor = vec4(rgb, 1.0);
        }
      `,
    });
    this.backgroundQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.backgroundMaterial);
    this.backgroundQuad.frustumCulled = false;
    this.backgroundQuad.renderOrder = -10;
    this.scene.add(this.backgroundQuad);

    // ---- hand occlusion masks (depth only, drawn between background and tubes)
    for (let i = 0; i < 2; i += 1) {
      const positions = new Float32Array(MAX_HULL_POINTS * 3);
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      // Fan triangulation of a convex polygon.
      const indices: number[] = [];
      for (let k = 1; k < MAX_HULL_POINTS - 1; k += 1) indices.push(0, k, k + 1);
      geometry.setIndex(indices);
      geometry.setDrawRange(0, 0);
      const material = new THREE.MeshBasicMaterial({
        colorWrite: false,
        depthWrite: true,
        depthTest: true,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.renderOrder = -5;
      mesh.frustumCulled = false;
      mesh.visible = false;
      this.maskMeshes.push(mesh);
      this.maskPositions.push(positions);
      this.scene.add(mesh);
    }

    // ---- polytope instanced tubes
    // Unit cylinder along +Y; per-instance matrix stretches it between the two
    // projected endpoints. Open-ended: the caps would only ever face inward.
    const coreGeometry = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true);
    const jointGeometry = new THREE.SphereGeometry(1, 8, 6);

    const makeInstanced = (
      geometry: THREE.BufferGeometry,
      material: THREE.Material,
      capacity: number
    ): THREE.InstancedMesh => {
      const mesh = new THREE.InstancedMesh(geometry, material, capacity);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0;
      mesh.frustumCulled = false;
      this.objectGroup.add(mesh);
      return mesh;
    };

    this.core = makeInstanced(
      coreGeometry,
      new THREE.MeshBasicMaterial({ toneMapped: false }),
      MAX_EDGES
    );
    this.halo = makeInstanced(
      coreGeometry,
      new THREE.MeshBasicMaterial({
        toneMapped: false,
        transparent: true,
        opacity: DEFAULT_SCENE_STYLE.glowStrength,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
      MAX_EDGES
    );
    this.chromaA = makeInstanced(
      coreGeometry,
      new THREE.MeshBasicMaterial({
        color: 0xff2040,
        toneMapped: false,
        transparent: true,
        opacity: 0.16,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
      MAX_EDGES
    );
    this.chromaB = makeInstanced(
      coreGeometry,
      new THREE.MeshBasicMaterial({
        color: 0x2080ff,
        toneMapped: false,
        transparent: true,
        opacity: 0.16,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
      MAX_EDGES
    );
    this.joints = makeInstanced(
      jointGeometry,
      new THREE.MeshBasicMaterial({ toneMapped: false }),
      MAX_VERTICES
    );

    // instanceColor must exist before first render; seed it white.
    for (const mesh of [this.core, this.halo, this.joints]) {
      const capacity = mesh === this.joints ? MAX_VERTICES : MAX_EDGES;
      mesh.instanceColor = new THREE.InstancedBufferAttribute(
        new Float32Array(capacity * 3).fill(1),
        3
      );
      mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    }

    this.scene.add(this.objectGroup);

    // ---- engage feedback: fingertip rings + chamfered construction frame
    const ringGeometry = new THREE.RingGeometry(0.82, 1, 40);
    for (let i = 0; i < 2; i += 1) {
      const material = new THREE.MeshBasicMaterial({
        color: new THREE.Color(DEFAULT_SCENE_STYLE.accentColor),
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthTest: false,
        side: THREE.DoubleSide,
      });
      const ring = new THREE.Mesh(ringGeometry, material);
      ring.visible = false;
      this.overlayScene.add(ring);
      this.rings.push(ring);
      this.ringMaterials.push(material);
    }

    // Fingertip plane-legend dots: a soft core disc ringed by a crisp edge is
    // overkill at this size; a plain additive disc reads cleanly at phone size.
    const markerGeometry = new THREE.CircleGeometry(1, 24);
    for (let i = 0; i < MAX_MARKERS; i += 1) {
      const material = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthTest: false,
        side: THREE.DoubleSide,
      });
      const marker = new THREE.Mesh(markerGeometry, material);
      marker.visible = false;
      this.overlayScene.add(marker);
      this.markers.push(marker);
      this.markerMaterials.push(material);
    }

    // Label pills beside the dots ("ZW", "REV"). Texture per text+colour,
    // built lazily and cached; the quad is 2:1 to match the texture.
    const labelGeometry = new THREE.PlaneGeometry(2, 1);
    for (let i = 0; i < MAX_MARKERS; i += 1) {
      const material = new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: 0,
        depthTest: false,
        side: THREE.DoubleSide,
      });
      const label = new THREE.Mesh(labelGeometry, material);
      label.visible = false;
      this.overlayScene.add(label);
      this.labels.push(label);
      this.labelMaterials.push(material);
    }

    this.frameMaterial = new THREE.LineBasicMaterial({
      color: new THREE.Color(DEFAULT_SCENE_STYLE.accentColor),
      transparent: true,
      opacity: 0,
      depthTest: false,
    });
    this.frame = new THREE.LineSegments(buildDraftFrame(), this.frameMaterial);
    this.frame.visible = false;
    this.overlayScene.add(this.frame);
  }

  get drawingBufferSize(): { width: number; height: number } {
    return {
      width: this.canvas.width,
      height: this.canvas.height,
    };
  }

  setVideo(video: HTMLVideoElement): void {
    this.videoTexture?.dispose();
    this.videoTexture = new THREE.VideoTexture(video);
    this.videoTexture.colorSpace = THREE.SRGBColorSpace;
    this.videoTexture.minFilter = THREE.LinearFilter;
    this.videoTexture.magFilter = THREE.LinearFilter;
    this.backgroundMaterial.uniforms.uMap!.value = this.videoTexture;
    this.backgroundMaterial.uniforms.uHasVideo!.value = 1;
  }

  setCrop(crop: CropTransform): void {
    const [fracX, fracY, offsetX, offsetY] = cropTransformToUniform(crop);
    (this.backgroundMaterial.uniforms.uCrop!.value as THREE.Vector4).set(
      fracX,
      fracY,
      offsetX,
      offsetY
    );
    this.backgroundMaterial.uniforms.uMirror!.value = crop.mirrored ? 1 : 0;
  }

  setPolytope(polytope: Polytope4D): void {
    this.polytope = polytope;
    this.core.count = polytope.edges.length;
    this.halo.count = polytope.edges.length;
    this.chromaA.count = polytope.edges.length;
    this.chromaB.count = polytope.edges.length;
    this.joints.count = polytope.vertices.length;
  }

  /** 4D eye distance; see PROJECTION_EYE_W in polytope4d.ts. */
  setEyeW(eyeW: number): void {
    this.eyeW = eyeW;
  }

  setStyle(style: Partial<SceneStyle>): void {
    Object.assign(this.style, style);
    (this.halo.material as THREE.MeshBasicMaterial).opacity = this.style.glowStrength;
    const chromaOn = this.style.chromaSplit > 1e-5;
    this.chromaA.visible = chromaOn;
    this.chromaB.visible = chromaOn;
    const accent = new THREE.Color(this.style.accentColor);
    for (const material of this.ringMaterials) material.color.copy(accent);
    this.frameMaterial.color.copy(accent);
  }

  resize(cssWidth: number, cssHeight: number, pixelRatio: number): void {
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(cssWidth, cssHeight, false);
    this.camera.aspect = cssWidth / cssHeight;
    this.camera.updateProjectionMatrix();
  }

  /**
   * Re-projects every vertex under the current orientation and rebuilds the
   * instance transforms and W-colours. ~1200 edges x 5 instanced meshes stays
   * comfortably inside a 60 FPS frame on the target GPU.
   */
  updateOrientation(rotation: Mat4): void {
    const polytope = this.polytope;
    if (!polytope) return;

    const { objectScale, objectCenterY, hueBase, hueRange, tubeRadius, chromaSplit } = this.style;

    // Object centre in world space, from its display-space vertical placement.
    const worldPerDisplayY =
      2 * CAMERA_DISTANCE * Math.tan((CAMERA_FOV * Math.PI) / 360);
    const centerYWorld = (0.5 - objectCenterY) * worldPerDisplayY;
    this.objectGroup.position.set(0, centerYWorld, 0);

    const vertices = polytope.vertices;
    for (let i = 0; i < vertices.length; i += 1) {
      const rotated = applyToVec(rotation, vertices[i]!, this.scratchVec4);
      this.wCoords[i] = rotated[3]!;
      const p = projectTo3D(rotated, this.eyeW, this.scratchVec3);
      this.projected[i * 3] = p[0] * objectScale;
      this.projected[i * 3 + 1] = p[1] * objectScale;
      this.projected[i * 3 + 2] = p[2] * objectScale;
    }

    const dummy = this.dummy;
    const edges = polytope.edges;
    for (let e = 0; e < edges.length; e += 1) {
      const [i, j] = edges[e]!;
      const ax = this.projected[i * 3]!;
      const ay = this.projected[i * 3 + 1]!;
      const az = this.projected[i * 3 + 2]!;
      const bx = this.projected[j * 3]!;
      const by = this.projected[j * 3 + 1]!;
      const bz = this.projected[j * 3 + 2]!;

      this.edgeDir.set(bx - ax, by - ay, bz - az);
      const length = Math.max(this.edgeDir.length(), 1e-6);
      this.edgeDir.divideScalar(length);

      dummy.position.set((ax + bx) * 0.5, (ay + by) * 0.5, (az + bz) * 0.5);
      dummy.quaternion.setFromUnitVectors(this.up, this.edgeDir);
      dummy.scale.set(tubeRadius, length, tubeRadius);
      dummy.updateMatrix();
      this.core.setMatrixAt(e, dummy.matrix);

      // Halo shares position/length but is fatter.
      dummy.scale.set(tubeRadius * 3.2, length, tubeRadius * 3.2);
      dummy.updateMatrix();
      this.halo.setMatrixAt(e, dummy.matrix);
      this.chromaA.setMatrixAt(e, dummy.matrix);
      this.chromaB.setMatrixAt(e, dummy.matrix);

      // Colour by W before projection: depth in the fourth dimension as hue.
      const w = (this.wCoords[i]! + this.wCoords[j]!) * 0.5;
      this.colorScratch.setHSL(hueBase - hueRange * w, 1, 0.62);
      this.core.setColorAt(e, this.colorScratch);
      this.halo.setColorAt(e, this.colorScratch);
    }

    for (let i = 0; i < vertices.length; i += 1) {
      dummy.position.set(this.projected[i * 3]!, this.projected[i * 3 + 1]!, this.projected[i * 3 + 2]!);
      dummy.quaternion.identity();
      const r = tubeRadius * 1.5;
      dummy.scale.set(r, r, r);
      dummy.updateMatrix();
      this.joints.setMatrixAt(i, dummy.matrix);
      this.colorScratch.setHSL(hueBase - hueRange * this.wCoords[i]!, 1, 0.7);
      this.joints.setColorAt(i, this.colorScratch);
    }

    this.chromaA.position.set(chromaSplit, 0, 0);
    this.chromaB.position.set(-chromaSplit, 0, 0);

    this.core.instanceMatrix.needsUpdate = true;
    this.halo.instanceMatrix.needsUpdate = true;
    this.chromaA.instanceMatrix.needsUpdate = true;
    this.chromaB.instanceMatrix.needsUpdate = true;
    this.joints.instanceMatrix.needsUpdate = true;
    if (this.core.instanceColor) this.core.instanceColor.needsUpdate = true;
    if (this.halo.instanceColor) this.halo.instanceColor.needsUpdate = true;
    if (this.joints.instanceColor) this.joints.instanceColor.needsUpdate = true;
  }

  /**
   * Places a display-space point at `depthFactor` times the object distance
   * along the ray through that pixel. Depth testing then handles occlusion.
   */
  private displayToWorld(
    p: Point2D,
    depthFactor: number,
    out: THREE.Vector3
  ): THREE.Vector3 {
    const v = this.unprojectScratch;
    v.set(p.x * 2 - 1, 1 - p.y * 2, 0.5).unproject(this.camera);
    v.sub(this.camera.position).normalize();
    const distance = CAMERA_DISTANCE * depthFactor;
    out.copy(this.camera.position).addScaledVector(v, distance);
    return out;
  }

  private readonly maskWorldScratch = new THREE.Vector3();

  /** `masks[0]` left hand, `masks[1]` right. Null hides that mask. */
  setHandMasks(masks: readonly (HandMask | null)[]): void {
    for (let m = 0; m < this.maskMeshes.length; m += 1) {
      const mesh = this.maskMeshes[m]!;
      const mask = masks[m] ?? null;
      if (!mask || mask.hull.length < 3) {
        mesh.visible = false;
        continue;
      }
      const positions = this.maskPositions[m]!;
      const count = Math.min(mask.hull.length, MAX_HULL_POINTS);
      for (let i = 0; i < count; i += 1) {
        const world = this.displayToWorld(mask.hull[i]!, mask.depth, this.maskWorldScratch);
        positions[i * 3] = world.x;
        positions[i * 3 + 1] = world.y;
        positions[i * 3 + 2] = world.z;
      }
      const geometry = mesh.geometry;
      geometry.setDrawRange(0, Math.max(0, (count - 2) * 3));
      const attribute = geometry.getAttribute("position") as THREE.BufferAttribute;
      attribute.needsUpdate = true;
      mesh.visible = true;
    }
  }

  /** Fingertip rings + construction frame; part of the recorded image. */
  setFeedback(state: FeedbackState): void {
    const aspect = this.camera.aspect || 1;
    const feedbacks = [state.left, state.right];
    for (let i = 0; i < 2; i += 1) {
      const ring = this.rings[i]!;
      const material = this.ringMaterials[i]!;
      const feedback = feedbacks[i];
      if (!feedback || feedback.intensity <= 0.01) {
        ring.visible = false;
        continue;
      }
      ring.visible = true;
      ring.position.set(feedback.center.x, feedback.center.y, 0);
      // Divide x by aspect so the ring stays circular in display coords.
      ring.scale.set(feedback.radius / aspect, feedback.radius, 1);
      material.opacity = 0.25 + 0.75 * Math.min(1, feedback.intensity);
    }

    for (let i = 0; i < MAX_MARKERS; i += 1) {
      const mesh = this.markers[i]!;
      const material = this.markerMaterials[i]!;
      const labelMesh = this.labels[i]!;
      const labelMaterial = this.labelMaterials[i]!;
      const marker = state.markers[i];
      if (!marker || marker.intensity <= 0.01) {
        mesh.visible = false;
        labelMesh.visible = false;
        continue;
      }
      mesh.visible = true;
      mesh.position.set(marker.center.x, marker.center.y, 1);
      mesh.scale.set(marker.radius / aspect, marker.radius, 1);
      material.color.set(marker.color);
      material.opacity = Math.min(1, marker.intensity);

      if (!marker.label) {
        labelMesh.visible = false;
        continue;
      }
      labelMesh.visible = true;
      // Pill floats just above the dot, clear of the fingertip.
      const height = 0.026;
      labelMesh.position.set(
        marker.center.x,
        marker.center.y - marker.radius - height * 0.85,
        1
      );
      // The overlay camera runs y-down (top = 0), which vertically mirrors
      // textured quads; the negative y scale flips the text back upright.
      labelMesh.scale.set(height / aspect, -height, 1);
      labelMaterial.map = this.labelTexture(marker.label, marker.color);
      labelMaterial.opacity = Math.min(1, marker.intensity);
    }

    const engage = state.engage;
    if (engage <= 0.01) {
      this.frame.visible = false;
    } else {
      this.frame.visible = true;
      this.frameMaterial.opacity = 0.5 * engage;
      // The frame hugs the object: a square of the object's apparent size,
      // centred where the object is.
      const half = 0.36 * this.style.objectScale;
      this.frame.position.set(0.5, this.style.objectCenterY, 0);
      this.frame.scale.set(half / aspect, half, 1);
    }
  }

  /**
   * A rounded pill with the plane tag, drawn once per text+colour and cached.
   * 2:1 canvas to match the label quad.
   */
  private labelTexture(text: string, color: string): THREE.CanvasTexture {
    const key = `${text}|${color}`;
    const cached = this.labelTextures.get(key);
    if (cached) return cached;

    const width = 128;
    const height = 64;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d")!;
    const radius = height * 0.4;
    ctx.beginPath();
    ctx.roundRect(4, 4, width - 8, height - 8, radius);
    ctx.fillStyle = "rgba(3, 6, 10, 0.78)";
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = color;
    ctx.stroke();
    ctx.font = `700 ${Math.round(height * 0.52)}px "Cascadia Mono", Consolas, monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = color;
    ctx.fillText(text, width / 2, height / 2 + 2);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    this.labelTextures.set(key, texture);
    return texture;
  }

  render(): void {
    this.renderer.clear(true, true, true);
    this.renderer.render(this.scene, this.camera);
    this.renderer.clearDepth();
    this.renderer.render(this.overlayScene, this.overlayCamera);
  }

  dispose(): void {
    this.videoTexture?.dispose();
    for (const texture of this.labelTextures.values()) texture.dispose();
    this.labelTextures.clear();
    this.scene.traverse((object) => {
      if (object instanceof THREE.Mesh || object instanceof THREE.LineSegments) {
        object.geometry.dispose();
        disposeMaterial(object.material as THREE.Material);
      }
    });
    this.overlayScene.traverse((object) => {
      if (object instanceof THREE.Mesh || object instanceof THREE.LineSegments) {
        object.geometry.dispose();
        disposeMaterial(object.material as THREE.Material);
      }
    });
    this.renderer.dispose();
  }
}

/**
 * Chamfered draft frame in unit space (-1..1 with corner cuts), the same
 * architectural registration language as the portal app: a faint outline with
 * 45-degree chamfered corners and heavier bracket accents that overshoot.
 */
function buildDraftFrame(): THREE.BufferGeometry {
  const chamfer = 0.18;
  const overshoot = 0.12;
  const points: number[] = [];
  const seg = (x1: number, y1: number, x2: number, y2: number): void => {
    points.push(x1, y1, 0, x2, y2, 0);
  };

  // Outline with chamfered corners.
  seg(-1 + chamfer, -1, 1 - chamfer, -1);
  seg(1, -1 + chamfer, 1, 1 - chamfer);
  seg(1 - chamfer, 1, -1 + chamfer, 1);
  seg(-1, 1 - chamfer, -1, -1 + chamfer);
  seg(-1 + chamfer, -1, -1, -1 + chamfer); // chamfer cuts
  seg(1 - chamfer, -1, 1, -1 + chamfer);
  seg(1 - chamfer, 1, 1, 1 - chamfer);
  seg(-1 + chamfer, 1, -1, 1 - chamfer);

  // Corner brackets: setting-out lines that cross and overshoot the corners.
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      seg(sx * (1 - chamfer * 2), sy, sx * (1 + overshoot), sy);
      seg(sx, sy * (1 - chamfer * 2), sx, sy * (1 + overshoot));
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(points), 3));
  return geometry;
}

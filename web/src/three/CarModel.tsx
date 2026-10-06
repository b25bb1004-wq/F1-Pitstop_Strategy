/* The real car: "Ferrari F1-75" by Sketcher (Sketchfab), CC-BY-NC-4.0, re-liveried here with all team and
 * sponsor branding removed (see web/tools/optimize-car.mjs). Loaded once (with progress, during the intro),
 * then cloned per use. x = forward after normalisation, 5.6 units long, wheels on y = 0. */
import * as THREE from "three";
import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { TYRE_COLOR } from "../data";

let asset: any = null;
export const CAR_URL = import.meta.env.BASE_URL + "models/f1.glb";
export const hasCar = () => !!asset;

export async function loadCar(onProgress: (f: number) => void) {
  const res = await fetch(CAR_URL);
  const total = Number(res.headers.get("content-length")) || 0;
  let buf: ArrayBuffer;
  if (res.body && total) {
    const reader = res.body.getReader();
    const parts: Uint8Array[] = [];
    let got = 0;
    for (;;) { const { done, value } = await reader.read(); if (done) break; parts.push(value); got += value.length; onProgress(Math.min(got / total, 0.97)); }
    buf = await new Blob(parts as BlobPart[]).arrayBuffer();
  } else buf = await res.arrayBuffer();
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  asset = await loader.parseAsync(buf, "");
  onProgress(1);
  return asset;
}

type Ref<T> = { current: T };
type Props = {
  compound?: string; livery?: string; accent?: string; spin?: Ref<number>; reveal?: Ref<number>; jackOnChange?: boolean;
  hologram?: boolean; brake?: Ref<number>; rainBlink?: Ref<boolean>;
};

function normalise(root: THREE.Object3D) {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root), size = box.getSize(new THREE.Vector3());
  const longZ = size.z > size.x, axis = longZ ? "z" : "x";
  const lo = box.min[axis], hi = box.max[axis], span = hi - lo;
  let yLo = -Infinity, yHi = -Infinity;
  root.traverse((o: any) => {
    if (!o.isMesh) return;
    const b = new THREE.Box3().setFromObject(o), c = (b.min[axis] + b.max[axis]) / 2;
    if (c < lo + span * 0.18) yLo = Math.max(yLo, b.max.y);
    if (c > hi - span * 0.18) yHi = Math.max(yHi, b.max.y);
  });
  const frontAtHigh = yHi < yLo;            // the rear wing stands tall; the nose is low
  const wrap = new THREE.Group();
  wrap.add(root);
  wrap.rotation.y = longZ ? (frontAtHigh ? Math.PI / 2 : -Math.PI / 2) : frontAtHigh ? 0 : Math.PI;
  const s = 5.6 / span;
  wrap.scale.setScalar(s);
  wrap.updateMatrixWorld(true);
  const b2 = new THREE.Box3().setFromObject(wrap), c2 = b2.getCenter(new THREE.Vector3());
  wrap.position.set(-c2.x, -b2.min.y, -c2.z);
  const outer = new THREE.Group();
  outer.add(wrap);
  outer.updateMatrixWorld(true);
  return outer;
}

/* ---------- procedural detail textures ---------- */
let weave: THREE.CanvasTexture | null = null;
function carbonWeave() {
  if (weave) return weave;
  const c = document.createElement("canvas"); c.width = c.height = 64;
  const g = c.getContext("2d")!;
  g.fillStyle = "#16171b"; g.fillRect(0, 0, 64, 64);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const twill = (x + y) % 4 < 2;                       // 2x2 twill
    const grad = g.createLinearGradient(x * 8, y * 8, x * 8 + (twill ? 8 : 0), y * 8 + (twill ? 0 : 8));
    grad.addColorStop(0, "#202128"); grad.addColorStop(0.5, "#2d2f37"); grad.addColorStop(1, "#1a1b20");
    g.fillStyle = grad; g.fillRect(x * 8 + 0.5, y * 8 + 0.5, 7, 7);
  }
  weave = new THREE.CanvasTexture(c);
  weave.wrapS = weave.wrapT = THREE.RepeatWrapping; weave.repeat.set(36, 36); weave.colorSpace = THREE.SRGBColorSpace;
  return weave;
}
let sidewall: THREE.CanvasTexture | null = null;
function sidewallText() {
  if (sidewall) return sidewall;
  const c = document.createElement("canvas"); c.width = 2048; c.height = 64;
  const g = c.getContext("2d")!;
  g.clearRect(0, 0, 2048, 64);
  g.font = "italic 800 40px 'Barlow Condensed', 'Arial Narrow', sans-serif"; g.textBaseline = "middle"; g.fillStyle = "#f5f5f7";
  for (let i = 0; i < 3; i++) { const x0 = i * 682; g.fillText("PITWALL", x0 + 40, 34); g.font = "600 28px 'Barlow Condensed', sans-serif"; g.fillText("P-SPEC  18\"", x0 + 260, 35); g.font = "italic 800 40px 'Barlow Condensed', sans-serif"; }
  sidewall = new THREE.CanvasTexture(c); sidewall.colorSpace = THREE.SRGBColorSpace; sidewall.anisotropy = 8;
  return sidewall;
}
/* an annulus whose u runs around the tyre and v across the band, so text wraps the sidewall */
function polarRing(r0: number, r1: number, seg = 160) {
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
    pos.push(c * r0, s * r0, 0, c * r1, s * r1, 0); uv.push(i / seg, 0, i / seg, 1);
    if (i < seg) { const k = i * 2; idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/* livery: F1-style swept stripe, white pinline, accent nose and exposed carbon lower edges,
   computed in the car's own space so it stays put as the car moves */
function liveryMaterial(base: string, accent: string, carInv: { value: THREE.Matrix4 }) {
  const m = new THREE.MeshPhysicalMaterial({ color: base, metalness: 0.5, roughness: 0.28, clearcoat: 1, clearcoatRoughness: 0.05 });
  const accentU = { value: new THREE.Color(accent) };
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uCarInv = carInv; sh.uniforms.uAccent = accentU;
    sh.vertexShader = sh.vertexShader.replace("#include <common>", "#include <common>\nuniform mat4 uCarInv; varying vec3 vCar;")
      .replace("#include <worldpos_vertex>", "#include <worldpos_vertex>\nvCar = (uCarInv * modelMatrix * vec4(transformed, 1.0)).xyz;");
    sh.fragmentShader = sh.fragmentShader.replace("#include <common>", "#include <common>\nuniform vec3 uAccent; varying vec3 vCar;")
      .replace("#include <color_fragment>", `#include <color_fragment>
        float band = smoothstep(0.075, 0.06, abs(vCar.y - (0.47 + 0.075 * vCar.x)));
        float pin = smoothstep(0.012, 0.0, abs(vCar.y - (0.555 + 0.075 * vCar.x)));
        float nose = smoothstep(2.15, 2.3, vCar.x);
        float low = smoothstep(0.3, 0.26, vCar.y);
        vec3 col = mix(diffuseColor.rgb, uAccent, max(band, nose * 0.9));
        col = mix(col, vec3(0.95), pin * (1.0 - nose));
        col = mix(col, vec3(0.035), low);
        diffuseColor.rgb = col;`);
  };
  (m as any).userData.accent = accentU;
  m.customProgramCacheKey = () => "pitwall-livery";
  return m;
}

export function CarModel({ compound = "MEDIUM", livery = "#101014", accent = "#e10600", spin, reveal, jackOnChange = true, hologram = false, brake, rainBlink }: Props) {
  const stripe = useMemo(() => new THREE.MeshStandardMaterial({ color: TYRE_COLOR[compound], emissive: TYRE_COLOR[compound], emissiveIntensity: 0.8 }), []);
  const clip = useMemo(() => new THREE.Plane(new THREE.Vector3(-1, 0, 0), reveal ? -3.4 : 1e4), []);
  const clipInv = useMemo(() => new THREE.Plane(new THREE.Vector3(1, 0, 0), 3.4), []);
  const carInv = useMemo(() => ({ value: new THREE.Matrix4() }), []);
  const built = useMemo(() => {
    if (!asset) return null;
    const src = asset.scene.clone(true);
    const paint = liveryMaterial(livery, accent, carInv);
    const trim = new THREE.MeshPhysicalMaterial({ color: accent, metalness: 0.35, roughness: 0.3, clearcoat: 1 });
    const rubber = new THREE.MeshStandardMaterial({ color: "#121215", roughness: 0.9 });
    const plastic = new THREE.MeshStandardMaterial({ color: "#0b0b0d", roughness: 0.6 });
    const carbon = new THREE.MeshPhysicalMaterial({ map: carbonWeave(), color: "#ffffff", metalness: 0.3, roughness: 0.42, clearcoat: 0.8, clearcoatRoughness: 0.12 });
    const rain = new THREE.MeshStandardMaterial({ color: "#ff1e1e", emissive: "#ff1e1e", emissiveIntensity: 3 });
    const holo = new THREE.MeshBasicMaterial({ color: "#d8dde6", wireframe: true, transparent: true, opacity: 0.22, clippingPlanes: [clipInv], toneMapped: false });
    const wheelMeshes: THREE.Mesh[] = [];
    const holoGroup = new THREE.Group();
    src.traverse((o: any) => {
      if (!o.isMesh) return;
      o.castShadow = true; o.receiveShadow = true;
      const n = o.material?.name || "";
      let m: THREE.Material = o.material;
      if (n === "car_chassis") m = paint;
      else if (n === "Wheels") m = rubber;
      else if (n === "sf21_sw_badges") m = plastic;
      else if (n === "Yellow" || n === "caliper_color") m = trim;
      else if (n === "2022_light" || n === "led_red") m = rain;
      else if (n === "carbon" || n === "gp21_sw_carbon") m = carbon;
      else m = (m as THREE.Material).clone();
      m.clippingPlanes = [clip];
      o.material = m;
      if (n === "Wheels" || n === "Wheels_TREAD") wheelMeshes.push(o);
    });
    const root = normalise(src);
    root.updateMatrixWorld(true);
    const centers = wheelMeshes.map((m) => new THREE.Box3().setFromObject(m).getCenter(new THREE.Vector3()));
    const pivots: THREE.Group[] = [];
    const rings: THREE.Mesh[] = [];
    const discMat = new THREE.MeshStandardMaterial({ color: "#2a2a30", emissive: "#ff5a14", emissiveIntensity: 0, metalness: 0.8, roughness: 0.4 });
    const textMat = new THREE.MeshBasicMaterial({ map: sidewallText(), transparent: true, depthWrite: false, toneMapped: false });
    for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const ms = wheelMeshes.filter((_, i) => Math.sign(centers[i].x) === sx && Math.sign(centers[i].z) === sz);
      if (!ms.length) continue;
      const box = new THREE.Box3(); ms.forEach((m) => box.expandByObject(m));
      const c = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
      const pivot = new THREE.Group(); pivot.position.copy(c); root.add(pivot); pivot.updateMatrixWorld(true);
      ms.forEach((m) => pivot.attach(m));
      const r = size.y / 2, w = size.z;
      for (const side of [-1, 1]) {
        const band = new THREE.Mesh(new THREE.TorusGeometry(r * 0.83, r * 0.022, 8, 96), stripe);
        band.position.z = side * (w / 2 + 0.004); pivot.add(band); rings.push(band);
        const text = new THREE.Mesh(polarRing(r * 0.62, r * 0.76), textMat);
        text.position.z = side * (w / 2 + 0.006); if (side < 0) text.rotation.y = Math.PI; pivot.add(text); rings.push(text);
      }
      const disc = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.46, r * 0.46, 0.03, 32), discMat);
      disc.rotation.x = Math.PI / 2; disc.position.z = -sz * (w * 0.2); pivot.add(disc);
      pivots.push(pivot);
    }
    if (hologram) {
      root.updateMatrixWorld(true);
      root.traverse((o: any) => {
        if (!o.isMesh || rings.includes(o)) return;
        const h = new THREE.Mesh(o.geometry, holo); h.matrixAutoUpdate = false; h.matrix.copy(o.matrixWorld); holoGroup.add(h);
      });
    }
    return { root, pivots, paint, trim, holo, holoGroup, discMat, rain };
  }, []);

  useEffect(() => {
    if (!built) return;
    built.paint.color.set(livery);
    (built.paint as any).userData.accent.value.set(accent);
    built.trim.color.set(accent);
  }, [livery, accent, built]);
  const target = useRef(new THREE.Color(TYRE_COLOR[compound]));
  const jack = useRef(0), first = useRef(true), body = useRef<THREE.Group>(null);
  useEffect(() => {
    target.current.set(TYRE_COLOR[compound] || "#fff");
    if (!first.current && jackOnChange) jack.current = 1;
    first.current = false;
  }, [compound]);

  useFrame(({ clock }, dt) => {
    if (!built) return;
    const d = Math.min(dt, 0.05);
    built.root.updateMatrixWorld();
    carInv.value.copy(built.root.matrixWorld).invert();
    const w = spin ? spin.current : 0;
    built.pivots.forEach((p) => (p.rotation.z -= w * d));
    stripe.color.lerp(target.current, 1 - Math.pow(0.002, d)); stripe.emissive.copy(stripe.color);
    const b = brake ? brake.current : 0;
    built.discMat.emissiveIntensity += (b * 2.4 - built.discMat.emissiveIntensity) * Math.min(1, d * (b > built.discMat.emissiveIntensity ? 14 : 2.5));
    built.rain.emissiveIntensity = rainBlink?.current ? (Math.sin(clock.elapsedTime * 22) > 0 ? 6 : 0.4) : 3;
    jack.current = Math.max(0, jack.current - d * 1.5);
    if (body.current) body.current.position.y = Math.sin(Math.min(jack.current, 1) * Math.PI) * 0.12;
    if (reveal) {
      const r = Math.min(Math.max(reveal.current, 0), 1);
      clip.constant = -3.1 + r * 6.4;
      clipInv.constant = -clip.constant;
      built.holo.opacity = 0.05 + 0.3 * (1 - r);
    }
  });
  if (!built) return null;
  return (
    <group ref={body}>
      <primitive object={built.root} />
      {hologram && <primitive object={built.holoGroup} />}
    </group>
  );
}

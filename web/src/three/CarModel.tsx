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
type Props = { compound?: string; livery?: string; accent?: string; spin?: Ref<number>; reveal?: Ref<number>; jackOnChange?: boolean; hologram?: boolean };

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

export function CarModel({ compound = "MEDIUM", livery = "#14161b", accent = "#ffb547", spin, reveal, jackOnChange = true, hologram = false }: Props) {
  const stripe = useMemo(() => new THREE.MeshStandardMaterial({ color: TYRE_COLOR[compound], emissive: TYRE_COLOR[compound], emissiveIntensity: 0.9 }), []);
  const clip = useMemo(() => new THREE.Plane(new THREE.Vector3(-1, 0, 0), reveal ? -3.4 : 1e4), []);
  const clipInv = useMemo(() => new THREE.Plane(new THREE.Vector3(1, 0, 0), 3.4), []);
  const built = useMemo(() => {
    if (!asset) return null;
    const src = asset.scene.clone(true);
    const paint = new THREE.MeshPhysicalMaterial({ color: livery, metalness: 0.55, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.06 });
    const amber = new THREE.MeshPhysicalMaterial({ color: accent, metalness: 0.4, roughness: 0.3, clearcoat: 1, emissive: accent, emissiveIntensity: 0.12 });
    const rubber = new THREE.MeshStandardMaterial({ color: "#111214", roughness: 0.88 });
    const plastic = new THREE.MeshStandardMaterial({ color: "#0b0b0d", roughness: 0.6 });
    const holo = new THREE.MeshBasicMaterial({ color: "#ffb547", wireframe: true, transparent: true, opacity: 0.22, clippingPlanes: [clipInv], toneMapped: false });
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
      else if (n === "Yellow" || n === "caliper_color") m = amber;
      else if (n === "2022_light" || n === "led_red") m = new THREE.MeshStandardMaterial({ color: "#ff2a1f", emissive: "#ff2a1f", emissiveIntensity: 3 });
      else if (n === "carbon") { m = (m as THREE.Material).clone(); Object.assign(m, { roughness: 0.38, metalness: 0.35 }); (m as any).color?.set("#1b1c21"); }
      else m = (m as THREE.Material).clone();
      m.clippingPlanes = [clip];
      o.material = m;
      if (n === "Wheels" || n === "Wheels_TREAD") wheelMeshes.push(o);
    });
    const root = normalise(src);
    // wheels: cluster tyre meshes into four, re-parent each around a pivot at its centre so it can spin
    root.updateMatrixWorld(true);
    const centers = wheelMeshes.map((m) => new THREE.Box3().setFromObject(m).getCenter(new THREE.Vector3()));
    const pivots: THREE.Group[] = [];
    const rings: THREE.Mesh[] = [];
    for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const ms = wheelMeshes.filter((_, i) => Math.sign(centers[i].x) === sx && Math.sign(centers[i].z) === sz);
      if (!ms.length) continue;
      const box = new THREE.Box3(); ms.forEach((m) => box.expandByObject(m));
      const c = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
      const pivot = new THREE.Group(); pivot.position.copy(c); root.add(pivot); pivot.updateMatrixWorld(true);
      ms.forEach((m) => pivot.attach(m));
      const r = size.y / 2, w = size.z;
      for (const side of [-1, 1]) {
        const ring = new THREE.Mesh(new THREE.TorusGeometry(r * 0.74, r * 0.035, 10, 64), stripe);
        ring.position.z = side * (w / 2 + 0.004); pivot.add(ring); rings.push(ring);
      }
      pivots.push(pivot);
    }
    if (hologram) {
      root.updateMatrixWorld(true);
      root.traverse((o: any) => {
        if (!o.isMesh || rings.includes(o)) return;
        const h = new THREE.Mesh(o.geometry, holo); h.matrixAutoUpdate = false; h.matrix.copy(o.matrixWorld); holoGroup.add(h);
      });
    }
    return { root, pivots, paint, holo, holoGroup };
  }, []);

  useEffect(() => { if (built) built.paint.color.set(livery); }, [livery, built]);
  const target = useRef(new THREE.Color(TYRE_COLOR[compound]));
  const jack = useRef(0), first = useRef(true), body = useRef<THREE.Group>(null);
  useEffect(() => {
    target.current.set(TYRE_COLOR[compound] || "#fff");
    if (!first.current && jackOnChange) jack.current = 1;
    first.current = false;
  }, [compound]);

  useFrame((_, dt) => {
    if (!built) return;
    const d = Math.min(dt, 0.05);
    const w = spin ? spin.current : 0;
    built.pivots.forEach((p) => (p.rotation.z -= w * d));
    stripe.color.lerp(target.current, 1 - Math.pow(0.002, d)); stripe.emissive.copy(stripe.color);
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

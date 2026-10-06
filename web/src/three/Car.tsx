/* A procedurally modelled 2020s F1 car (no external model). x = forward, y = up, z = lateral.
 * `reveal` (0..1) fades the solid body in over amber blueprint edges; `spin` drives wheel rotation
 * (rad/s); `compound` colours the tyre sidewall stripes and animates a pit-stop "jack" on change. */
import * as THREE from "three";
import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { TYRE_COLOR } from "../data";

type Ref<T> = { current: T };
type Props = { compound?: string; reveal?: Ref<number>; spin?: Ref<number>; jackOnChange?: boolean };

const shape = (pts: [number, number][], curves = true) => {
  const s = new THREE.Shape();
  s.moveTo(...pts[0]);
  for (let i = 1; i < pts.length; i++) {
    const [x, y] = pts[i];
    if (curves && i < pts.length - 1) {
      const [nx, ny] = pts[i + 1];
      s.quadraticCurveTo(x, y, (x + nx) / 2, (y + ny) / 2);
    } else s.lineTo(x, y);
  }
  s.closePath();
  return s;
};
const extrude = (pts: [number, number][], depth: number, bevel = 0.05, curves = true) => {
  const g = new THREE.ExtrudeGeometry(shape(pts, curves), {
    depth, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel * 0.8, bevelSegments: 5, curveSegments: 28,
  });
  g.translate(0, 0, -depth / 2);
  g.computeVertexNormals();
  return g;
};
const box = (x: number, y: number, z: number) => new THREE.BoxGeometry(x, y, z);
function rod(a: THREE.Vector3, b: THREE.Vector3, r = 0.012) {
  const len = a.distanceTo(b);
  const g = new THREE.CylinderGeometry(r, r, len, 8);
  g.translate(0, len / 2, 0);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize()));
  g.translate(a.x, a.y, a.z);
  return g;
}

export function useCarMaterials() {
  return useMemo(() => {
    const physical = (o: THREE.MeshPhysicalMaterialParameters) => new THREE.MeshPhysicalMaterial(o);
    return {
      carbon: physical({ color: "#121419", metalness: 0.45, roughness: 0.34, clearcoat: 1, clearcoatRoughness: 0.12 }),
      gloss: physical({ color: "#0a0b0e", metalness: 0.6, roughness: 0.22, clearcoat: 1, clearcoatRoughness: 0.08 }),
      amber: physical({ color: "#ffb547", metalness: 0.35, roughness: 0.28, clearcoat: 1, emissive: "#ff8a00", emissiveIntensity: 0.18 }),
      red: physical({ color: "#ff2a1f", metalness: 0.3, roughness: 0.3, clearcoat: 1, emissive: "#ff2a1f", emissiveIntensity: 0.12 }),
      rubber: physical({ color: "#0d0d0f", metalness: 0, roughness: 0.92 }),
      rim: physical({ color: "#24272e", metalness: 0.95, roughness: 0.25 }),
      helmet: physical({ color: "#f4f4f6", metalness: 0.2, roughness: 0.25, clearcoat: 1 }),
      visor: physical({ color: "#050506", metalness: 1, roughness: 0.05 }),
      rain: new THREE.MeshStandardMaterial({ color: "#ff2a1f", emissive: "#ff2a1f", emissiveIntensity: 2.5 }),
      edge: new THREE.LineBasicMaterial({ color: "#ffb547", transparent: true, opacity: 0.9 }),
    };
  }, []);
}

function Part({ geo, mat, edgeMat, ...rest }: any) {
  const edges = useMemo(() => new THREE.EdgesGeometry(geo, 28), [geo]);
  return (
    <group {...rest}>
      <mesh geometry={geo} material={mat} castShadow receiveShadow />
      <lineSegments geometry={edges} material={edgeMat} />
    </group>
  );
}

function Wheel({ r, w, stripe, mats, refCb, position }: any) {
  const geos = useMemo(() => {
    const tyre = new THREE.CylinderGeometry(r, r, w, 56, 1, false);
    tyre.rotateX(Math.PI / 2);
    const shoulder = new THREE.TorusGeometry(r - 0.012, 0.03, 12, 56);
    const band = new THREE.TorusGeometry(r * 0.8, 0.016, 10, 64);
    const rim = new THREE.CylinderGeometry(r * 0.6, r * 0.6, w * 1.02, 40);
    rim.rotateX(Math.PI / 2);
    const spokes = Array.from({ length: 5 }, (_, i) => {
      const g = box(r * 1.08, 0.028, 0.02);
      g.translate(r * 0.27, 0, 0);
      g.rotateZ((i / 5) * Math.PI * 2);
      return g;
    });
    return { tyre, shoulder, band, rim, spokes };
  }, [r, w]);
  return (
    <group position={position}>
      <group ref={refCb}>
        <mesh geometry={geos.tyre} material={mats.rubber} castShadow />
        {[-1, 1].map((s) => (
          <group key={s} position={[0, 0, (s * w) / 2]}>
            <mesh geometry={geos.shoulder} material={mats.rubber} />
            <mesh geometry={geos.band} material={stripe} />
            {geos.spokes.map((g: THREE.BufferGeometry, i: number) => <mesh key={i} geometry={g} material={mats.rim} position={[0, 0, s * 0.012]} />)}
          </group>
        ))}
        <mesh geometry={geos.rim} material={mats.rim} />
      </group>
    </group>
  );
}

export function Car({ compound = "MEDIUM", reveal, spin, jackOnChange = true }: Props) {
  const mats = useCarMaterials();
  // reveal: everything with x <= plane.constant is solid; an amber scan line rides the boundary
  const clip = useMemo(() => new THREE.Plane(new THREE.Vector3(-1, 0, 0), reveal ? -3.4 : 100), []);
  const scan = useRef<THREE.Mesh>(null);
  useMemo(() => {
    Object.entries(mats).forEach(([k, m]) => { if (k !== "edge") (m as THREE.Material).clippingPlanes = [clip]; });
  }, [mats, clip]);
  const stripe = useMemo(() => new THREE.MeshStandardMaterial({ color: TYRE_COLOR[compound], emissive: TYRE_COLOR[compound], emissiveIntensity: 0.6, clippingPlanes: [clip] }), []);
  const target = useRef(new THREE.Color(TYRE_COLOR[compound]));
  const wheels = useRef<THREE.Group[]>([]);
  const body = useRef<THREE.Group>(null!);
  const jack = useRef(0);
  const first = useRef(true);

  useEffect(() => {
    target.current.set(TYRE_COLOR[compound] || "#ffffff");
    if (!first.current && jackOnChange) jack.current = 1;
    first.current = false;
  }, [compound, jackOnChange]);

  const g = useMemo(() => {
    const nose = extrude([[1.15, 0.2], [1.15, 0.56], [1.9, 0.48], [2.6, 0.36], [2.98, 0.27], [2.98, 0.19], [1.15, 0.17]], 0.34, 0.06);
    const tub = extrude([[1.3, 0.17], [1.3, 0.58], [0.62, 0.66], [0.3, 0.7], [0.02, 0.84], [-0.28, 1.06], [-0.7, 1.04], [-1.5, 0.82],
      [-2.25, 0.6], [-2.55, 0.44], [-2.55, 0.17]], 0.6, 0.07);
    const pod = extrude([[0.78, 0.2], [0.78, 0.6], [0.35, 0.64], [-0.4, 0.58], [-1.25, 0.42], [-1.85, 0.26], [-1.85, 0.17], [0.78, 0.17]], 1.38, 0.1);
    const fin = extrude([[-0.42, 1.04], [-2.2, 0.98], [-2.2, 0.7], [-1.0, 0.88]], 0.018, 0, false);
    const intake = extrude([[0.0, 0.92], [-0.12, 1.0], [-0.28, 0.98], [-0.18, 0.86]], 0.22, 0.03);
    const floor = box(4.85, 0.035, 1.66);
    const plank = box(3.8, 0.02, 0.32);
    const fw = [box(0.44, 0.022, 2.06), box(0.3, 0.018, 1.92), box(0.24, 0.016, 1.62)];
    const fwEnd = box(0.6, 0.24, 0.022);
    const rwMain = box(0.44, 0.045, 1.06), rwFlap = box(0.28, 0.03, 1.06), rwEnd = box(0.82, 0.66, 0.026), pylon = box(0.3, 0.42, 0.04);
    const beam = box(0.22, 0.03, 0.92), stripeTop = box(1.7, 0.012, 0.05), rain = box(0.05, 0.08, 0.12);
    const haloCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(-0.22, 0.79, -0.21), new THREE.Vector3(-0.08, 0.9, -0.25), new THREE.Vector3(0.28, 0.95, -0.22),
      new THREE.Vector3(0.5, 0.91, 0), new THREE.Vector3(0.28, 0.95, 0.22), new THREE.Vector3(-0.08, 0.9, 0.25), new THREE.Vector3(-0.22, 0.79, 0.21),
    ]);
    const halo = new THREE.TubeGeometry(haloCurve, 64, 0.03, 10, false);
    const pillar = new THREE.TubeGeometry(new THREE.CatmullRomCurve3([new THREE.Vector3(0.62, 0.64, 0), new THREE.Vector3(0.56, 0.8, 0), new THREE.Vector3(0.5, 0.91, 0)]), 16, 0.03, 8, false);
    const helmet = new THREE.SphereGeometry(0.13, 32, 24);
    const visor = new THREE.SphereGeometry(0.132, 32, 12, -0.9, 1.8, 1.1, 0.45);
    const sus: THREE.BufferGeometry[] = [];
    const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
    for (const s of [-1, 1]) {
      sus.push(rod(V(1.55, 0.46, 0.16 * s), V(1.92, 0.42, 0.84 * s)), rod(V(1.75, 0.28, 0.16 * s), V(1.92, 0.3, 0.84 * s)),
        rod(V(1.35, 0.3, 0.2 * s), V(1.9, 0.36, 0.84 * s)), rod(V(-1.2, 0.48, 0.3 * s), V(-1.62, 0.44, 0.78 * s)),
        rod(V(-1.9, 0.28, 0.3 * s), V(-1.62, 0.3, 0.78 * s)));
    }
    return { nose, tub, pod, fin, intake, floor, plank, fw, fwEnd, rwMain, rwFlap, rwEnd, pylon, beam, stripeTop, rain, halo, pillar, helmet, visor, sus };
  }, []);

  useFrame((_, dt) => {
    const d = Math.min(dt, 0.05);
    const w = spin ? spin.current : 0;
    wheels.current.forEach((wh) => wh && (wh.rotation.z -= w * d));
    stripe.color.lerp(target.current, 1 - Math.pow(0.002, d));
    stripe.emissive.copy(stripe.color);
    if (body.current) {
      jack.current = Math.max(0, jack.current - d * 1.6);
      const j = Math.sin(Math.min(jack.current, 1) * Math.PI);
      body.current.position.y = j * 0.09;
    }
    if (reveal) {
      const r = Math.min(Math.max(reveal.current, 0), 1);
      clip.constant = -3.4 + r * 6.9;
      mats.edge.opacity = 0.85 - 0.7 * r;
      if (scan.current) { scan.current.position.x = clip.constant; scan.current.visible = r > 0.01 && r < 0.995; }
    } else mats.edge.opacity = 0.0;
  });

  const P = (props: any) => <Part edgeMat={mats.edge} {...props} />;
  return (
    <group>
      <group ref={body}>
        <P geo={g.floor} mat={mats.gloss} position={[-0.12, 0.12, 0]} />
        <mesh geometry={g.plank} material={mats.amber} position={[-0.3, 0.095, 0]} />
        <P geo={g.nose} mat={mats.carbon} />
        <P geo={g.tub} mat={mats.carbon} />
        <P geo={g.pod} mat={mats.carbon} />
        <P geo={g.fin} mat={mats.amber} />
        <P geo={g.intake} mat={mats.gloss} />
        {[-1, 1].map((s) => <mesh key={s} geometry={g.stripeTop} material={mats.amber} position={[-0.45, 0.635, 0.66 * s]} rotation={[0, 0, -0.07]} />)}
        <mesh geometry={g.halo} material={mats.gloss} />
        <mesh geometry={g.pillar} material={mats.gloss} />
        <mesh geometry={g.helmet} material={mats.helmet} position={[0.18, 0.86, 0]} />
        <mesh geometry={g.visor} material={mats.visor} position={[0.18, 0.86, 0]} rotation={[0, 0, 0]} />
        <P geo={g.fw[0]} mat={mats.carbon} position={[2.84, 0.12, 0]} />
        <P geo={g.fw[1]} mat={mats.carbon} position={[2.76, 0.19, 0]} rotation={[0, 0, -0.32]} />
        <P geo={g.fw[2]} mat={mats.amber} position={[2.66, 0.27, 0]} rotation={[0, 0, -0.55]} />
        {[-1, 1].map((s) => <P key={s} geo={g.fwEnd} mat={mats.red} position={[2.8, 0.2, 1.04 * s]} />)}
        <P geo={g.pylon} mat={mats.carbon} position={[-2.36, 0.72, 0]} />
        <P geo={g.beam} mat={mats.carbon} position={[-2.5, 0.42, 0]} rotation={[0, 0, 0.2]} />
        <P geo={g.rwMain} mat={mats.carbon} position={[-2.45, 0.97, 0]} rotation={[0, 0, 0.14]} />
        <P geo={g.rwFlap} mat={mats.amber} position={[-2.3, 1.11, 0]} rotation={[0, 0, 0.5]} />
        {[-1, 1].map((s) => <P key={s} geo={g.rwEnd} mat={mats.carbon} position={[-2.42, 0.86, 0.545 * s]} />)}
        <mesh geometry={g.rain} material={mats.rain} position={[-2.6, 0.42, 0]} />
        {g.sus.map((s, i) => <mesh key={i} geometry={s} material={mats.gloss} />)}
      </group>
      {reveal && (
        <mesh ref={scan} position={[-3.4, 0.62, 0]}>
          <boxGeometry args={[0.025, 1.35, 2.3]} />
          <meshBasicMaterial color="#ffc477" transparent opacity={0.28} toneMapped={false} depthWrite={false} />
        </mesh>
      )}
      {[[1.92, 0.36, 0.98, 0.36, 0.36], [1.92, 0.36, -0.98, 0.36, 0.36], [-1.62, 0.38, 0.95, 0.38, 0.46], [-1.62, 0.38, -0.95, 0.38, 0.46]].map(
        ([x, y, z, r, w], i) => (
          <Wheel key={i} r={r} w={w} stripe={stripe} mats={mats} position={[x, y, z]} refCb={(el: THREE.Group) => (wheels.current[i] = el)} />
        ))}
    </group>
  );
}

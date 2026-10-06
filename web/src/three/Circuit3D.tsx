/* 3D race scene: the real circuit (metres, true elevation) as a ribbon, every car at its recorded pace,
 * the followed car as the real model in team livery, and three camera modes. */
import * as THREE from "three";
import { useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { Grid, OrbitControls } from "@react-three/drei";
import { Track, TEAM_COLOR } from "../data";
import { CarModel, hasCar } from "./CarModel";
import { Car } from "./Car";

export type CarState = { code: string; team: string; frac: number; lapDur: number; visible: boolean; pitting: boolean; selected: boolean };
export type Feed = { current: { cars: CarState[]; compound: string } };

const WIDTH = 13, ELEV = 1.6;
const wrap = (f: number) => (isFinite(f) ? ((f % 1) + 1) % 1 : 0);   // track width (m) and a gentle elevation exaggeration for drama

export function useCircuit(track: Track) {
  return useMemo(() => {
    const s = track.scale_m, a = track.aspect;
    const pts = track.points.map(([x, y], i) => new THREE.Vector3((x - 0.5) * s, (track.z?.[i] ?? 0) * s * ELEV, -(y - a / 2) * s));
    while (pts.length > 3 && pts[0].distanceTo(pts[pts.length - 1]) < 2) pts.pop();     // closed loop: drop the duplicate end
    const curve = new THREE.CatmullRomCurve3(pts, true, "centripetal");
    const N = 1600;
    const left: THREE.Vector3[] = [], right: THREE.Vector3[] = [], mid: THREE.Vector3[] = [];
    const up = new THREE.Vector3(0, 1, 0);
    for (let i = 0; i <= N; i++) {
      const u = i / N, p = curve.getPointAt(u % 1), t = curve.getTangentAt(u % 1);
      const side = new THREE.Vector3().crossVectors(t, up).normalize();
      mid.push(p); left.push(p.clone().addScaledVector(side, WIDTH / 2)); right.push(p.clone().addScaledVector(side, -WIDTH / 2));
    }
    const pos: number[] = [], idx: number[] = [], uv: number[] = [];
    for (let i = 0; i <= N; i++) {
      pos.push(...left[i].toArray(), ...right[i].toArray()); uv.push(0, i / 8, 1, i / 8);
      if (i < N) { const k = i * 2; idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
    }
    const ribbon = new THREE.BufferGeometry();
    ribbon.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    ribbon.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    ribbon.setIndex(idx); ribbon.computeVertexNormals();
    const edge = (arr: THREE.Vector3[], lift = 0.08) => new THREE.TubeGeometry(new THREE.CatmullRomCurve3(arr.map((p) => p.clone().setY(p.y + lift)), true), N, 0.18, 4, true);
    const box = new THREE.Box3().setFromPoints(mid);
    return { curve, ribbon, edgeL: edge(left), edgeR: edge(right), box, minY: box.min.y };
  }, [track]);
}

function Gantry({ curve }: { curve: THREE.CatmullRomCurve3 }) {
  const p = curve.getPointAt(0), t = curve.getTangentAt(0);
  const yaw = Math.atan2(-t.z, t.x);
  return (
    <group position={p} rotation={[0, yaw, 0]}>
      <mesh position={[0, 0.03, 0]}><boxGeometry args={[1.2, 0.02, WIDTH]} /><meshBasicMaterial color="#ffffff" toneMapped={false} /></mesh>
      {[-1, 1].map((s) => <mesh key={s} position={[0, 4, s * (WIDTH / 2 + 1)]}><boxGeometry args={[0.4, 8, 0.4]} /><meshStandardMaterial color="#1a1c22" /></mesh>)}
      <mesh position={[0, 8, 0]}><boxGeometry args={[0.6, 0.9, WIDTH + 2.4]} /><meshStandardMaterial color="#111318" emissive="#ff2a1f" emissiveIntensity={0.25} /></mesh>
    </group>
  );
}

function Pods({ feed, curve }: { feed: Feed; curve: THREE.CatmullRomCurve3 }) {
  const mesh = useRef<THREE.InstancedMesh>(null!);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const color = useMemo(() => new THREE.Color(), []);
  const q = useMemo(() => new THREE.Quaternion(), []);
  const X = useMemo(() => new THREE.Vector3(1, 0, 0), []);
  useFrame(() => {
    const cars = feed.current.cars;
    for (let i = 0; i < 22; i++) {
      const c = cars[i];
      if (!c || !c.visible || c.selected) { dummy.scale.setScalar(0); dummy.updateMatrix(); mesh.current.setMatrixAt(i, dummy.matrix); continue; }
      const p = curve.getPointAt(wrap(c.frac)), t = curve.getTangentAt(wrap(c.frac));
      const lane = ((i % 5) - 2) * 1.6;
      const side = new THREE.Vector3(-t.z, 0, t.x).normalize();
      dummy.position.copy(p).addScaledVector(side, lane).setY(p.y + 0.55);
      dummy.quaternion.copy(q.setFromUnitVectors(X, t));
      dummy.scale.set(5.4, 0.55, 1.6);
      dummy.updateMatrix();
      mesh.current.setMatrixAt(i, dummy.matrix);
      mesh.current.setColorAt(i, color.set(c.pitting ? "#555" : TEAM_COLOR[c.team] || "#ccc").multiplyScalar(2.2));
    }
    mesh.current.instanceMatrix.needsUpdate = true;
    if (mesh.current.instanceColor) mesh.current.instanceColor.needsUpdate = true;
  });
  return (
    <instancedMesh ref={mesh} args={[undefined as any, undefined as any, 22]}>
      <capsuleGeometry args={[0.5, 1, 4, 12]} />
      <meshBasicMaterial toneMapped={false} />
    </instancedMesh>
  );
}

function Followed({ feed, curve, livery }: { feed: Feed; curve: THREE.CatmullRomCurve3; livery: string }) {
  const g = useRef<THREE.Group>(null!);
  const spin = useRef(0);
  const q = useMemo(() => new THREE.Quaternion(), []);
  const X = useMemo(() => new THREE.Vector3(1, 0, 0), []);
  const length = useMemo(() => curve.getLength(), [curve]);
  useFrame(() => {
    const c = feed.current.cars.find((x) => x.selected);
    if (!c || !g.current) return;
    const u = wrap(c.frac), p = curve.getPointAt(u), t = curve.getTangentAt(u);
    g.current.position.copy(p);
    g.current.quaternion.slerp(q.setFromUnitVectors(X, t), 0.35);
    spin.current = c.lapDur > 0 ? Math.min(55, (length / c.lapDur / 0.36) * Math.min((feed.current as any).speed || 0, 1)) : 0;
    g.current.visible = c.visible;
  });
  return (
    <group ref={g}>
      {hasCar() ? <CarModel livery={livery} compound={feed.current.compound} spin={spin} jackOnChange={false} /> : <Car compound={feed.current.compound} spin={spin} jackOnChange={false} />}
      <pointLight position={[0, 3, 0]} intensity={40} distance={30} color="#ffd59a" />
    </group>
  );
}

function Cameras({ feed, curve, mode, box }: { feed: Feed; curve: THREE.CatmullRomCurve3; mode: string; box: THREE.Box3 }) {
  const { camera } = useThree();
  const look = useRef(new THREE.Vector3());
  const tmp = useMemo(() => new THREE.Vector3(), []);
  useFrame(({ clock }, dt) => {
    if (mode === "overview") return;
    const c = feed.current.cars.find((x) => x.selected);
    if (!c) return;
    const u = wrap(c.frac), p = curve.getPointAt(u), t = curve.getTangentAt(u);
    const k = 1 - Math.pow(0.0015, Math.min(dt, 0.05));
    if (mode === "chase") {
      tmp.copy(p).addScaledVector(t, -13).add(new THREE.Vector3(0, 4.2, 0));
      camera.position.lerp(tmp, k);
      look.current.lerp(tmp.copy(p).addScaledVector(t, 14).setY(p.y + 1.2), k);
    } else {
      const a = clock.elapsedTime * 0.12;
      tmp.set(p.x + Math.cos(a) * 70, p.y + 45, p.z + Math.sin(a) * 70);
      camera.position.lerp(tmp, k * 0.6);
      look.current.lerp(p, k);
    }
    camera.lookAt(look.current);
  });
  return mode === "overview" ? (
    <OrbitControls makeDefault target={box.getCenter(new THREE.Vector3())} maxPolarAngle={1.35} minDistance={200} maxDistance={4000} />
  ) : null;
}

export function CircuitScene({ track, feed, mode, livery }: { track: Track; feed: Feed; mode: string; livery: string }) {
  const c = useCircuit(track);
  const { camera } = useThree();
  useMemo(() => {
    if (mode !== "overview") return;
    const ctr = c.box.getCenter(new THREE.Vector3()), size = c.box.getSize(new THREE.Vector3());
    camera.position.set(ctr.x + size.x * 0.1, ctr.y + Math.max(size.x, size.z) * 0.75, ctr.z + Math.max(size.x, size.z) * 0.55);
    camera.lookAt(ctr);
  }, [mode, c]);
  return (
    <>
      <color attach="background" args={["#04050a"]} />
      <fog attach="fog" args={["#04050a", mode === "overview" ? 2500 : 120, mode === "overview" ? 6000 : 900]} />
      <hemisphereLight args={["#ffd9a8", "#05060a", 0.5]} />
      <directionalLight position={[300, 500, 200]} intensity={1.4} />
      <mesh geometry={c.ribbon} receiveShadow>
        <meshStandardMaterial color="#1b1d24" roughness={0.82} metalness={0.15} />
      </mesh>
      <mesh geometry={c.edgeL}><meshBasicMaterial color="#ffb547" toneMapped={false} /></mesh>
      <mesh geometry={c.edgeR}><meshBasicMaterial color="#ff8a00" toneMapped={false} /></mesh>
      <Gantry curve={c.curve} />
      <Grid position={[0, c.minY - 0.6, 0]} args={[20000, 20000]} cellSize={25} cellThickness={0.6} cellColor="#1d1a14" sectionSize={250}
        sectionThickness={1.1} sectionColor="#4a3210" fadeDistance={mode === "overview" ? 6000 : 700} fadeStrength={1.4} infiniteGrid />
      <Pods feed={feed} curve={c.curve} />
      <Followed feed={feed} curve={c.curve} livery={livery} />
      <Cameras feed={feed} curve={c.curve} mode={mode} box={c.box} />
    </>
  );
}

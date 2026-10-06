/* 3D race scene on the real circuit (metres, true elevation): smoothed racing line, kerbs at corners,
 * every car moving with the circuit's real speed profile, the followed car as the full model, and four
 * stable camera rigs (chase / TV trackside / helicopter / overview). */
import * as THREE from "three";
import { useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { Grid, Html, OrbitControls } from "@react-three/drei";
import { Track, TEAM_COLOR } from "../data";
import { CarModel, hasCar } from "./CarModel";
import { Car } from "./Car";

export type CarState = { code: string; team: string; frac: number; lapDur: number; visible: boolean; pitting: boolean; selected: boolean; ghost?: boolean };
export type Feed = { current: { cars: CarState[]; compound: string; speed?: number; sc?: boolean; brake?: number } };

const WIDTH = 13, ELEV = 1.6;
export const wrap = (f: number) => (isFinite(f) ? ((f % 1) + 1) % 1 : 0);
const damp = (k: number, dt: number) => 1 - Math.exp(-k * Math.min(dt, 0.05));
const angDiff = (a: number, b: number) => Math.atan2(Math.sin(b - a), Math.cos(b - a));
const EUL = new THREE.Euler(0, 0, 0, "YZX");
export const setPose = (q: THREE.Quaternion, yaw: number, pitch: number) => q.setFromEuler(EUL.set(0, yaw, pitch, "YZX"));
/* a damped heading that follows a car: identical maths for the car body and the cameras, so they stay locked */
function useSmoothedHeading() {
  const st = useRef<{ yaw: number; pitch: number; init: boolean }>({ yaw: 0, pitch: 0, init: false });
  return (target: { yaw: number; pitch: number }, dt: number, speed: number) => {
    const s = st.current;
    if (!s.init) { s.yaw = target.yaw; s.pitch = target.pitch; s.init = true; return s; }
    const k = damp(9 * Math.sqrt(Math.max(1, speed)), dt);
    s.yaw += angDiff(s.yaw, target.yaw) * k;
    s.pitch += (target.pitch - s.pitch) * k;
    return s;
  };
}

/* smoothed circuit + helpers shared by the race theatre, onboard and what-if scenes */
export function useCircuit(track: Track) {
  return useMemo(() => {
    const s = track.scale_m || 1000, a = track.aspect || 0.6;
    let pts = track.points.map(([x, y], i) => new THREE.Vector3((x - 0.5) * s, (track.z?.[i] ?? 0) * s * ELEV, -(y - a / 2) * s));
    while (pts.length > 3 && pts[0].distanceTo(pts[pts.length - 1]) < 2) pts.pop();
    // circular moving average (two passes) removes telemetry jitter that made the cameras wobble
    for (let pass = 0; pass < 2; pass++) {
      const n = pts.length;
      pts = pts.map((_, i) => {
        const acc = new THREE.Vector3();
        for (let k = -3; k <= 3; k++) acc.add(pts[(i + k + n) % n]);
        return acc.divideScalar(7);
      });
    }
    const curve = new THREE.CatmullRomCurve3(pts, true, "centripetal");
    curve.arcLengthDivisions = 4000;
    curve.updateArcLengths();
    const length = curve.getLength();
    const N = 1800;
    const up = new THREE.Vector3(0, 1, 0);
    const mid: THREE.Vector3[] = [], side: THREE.Vector3[] = [], tan: THREE.Vector3[] = [];
    for (let i = 0; i <= N; i++) {
      const u = (i / N) % 1, p = curve.getPointAt(u), t = curve.getTangentAt(u);
      mid.push(p); tan.push(t); side.push(new THREE.Vector3().crossVectors(t, up).normalize());
    }
    const strip = (offIn: number, offOut: number, lift: number, colors?: (i: number) => THREE.Color | null) => {
      const pos: number[] = [], col: number[] = [], idx: number[] = [];
      let v = 0;
      for (let i = 0; i < N; i++) {
        const c = colors ? colors(i) : null;
        if (colors && !c) continue;
        const a0 = mid[i].clone().addScaledVector(side[i], offIn), a1 = mid[i].clone().addScaledVector(side[i], offOut);
        const b0 = mid[i + 1].clone().addScaledVector(side[i + 1], offIn), b1 = mid[i + 1].clone().addScaledVector(side[i + 1], offOut);
        for (const q of [a0, a1, b0, b1]) { pos.push(q.x, q.y + lift, q.z); const cc = c || new THREE.Color(1, 1, 1); col.push(cc.r, cc.g, cc.b); }
        idx.push(v, v + 1, v + 2, v + 1, v + 3, v + 2); v += 4;
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
      g.setIndex(idx); g.computeVertexNormals();
      return g;
    };
    // curvature (heading change over ~20 m) decides where kerbs go
    const look = Math.max(2, Math.round((20 / length) * N));
    const curv = tan.map((t, i) => t.angleTo(tan[Math.min(N, i + look)]));
    const red = new THREE.Color("#e10600"), white = new THREE.Color("#f2f2f2");
    const kerbCol = (i: number) => (curv[i] > 0.12 ? (Math.floor(i / 2) % 2 ? red : white) : null);
    const asphalt = strip(-WIDTH / 2, WIDTH / 2, 0);
    const kerbL = strip(WIDTH / 2, WIDTH / 2 + 1.6, 0.04, kerbCol), kerbR = strip(-WIDTH / 2 - 1.6, -WIDTH / 2, 0.04, kerbCol);
    const lineL = strip(WIDTH / 2 - 0.35, WIDTH / 2 - 0.15, 0.03), lineR = strip(-WIDTH / 2 + 0.15, -WIDTH / 2 + 0.35, 0.03);
    // speed profile: lap-time fraction -> distance fraction from the fastest lap's telemetry
    const tel: any = (track as any).tel;
    let timeToDist = (f: number) => wrap(f);
    let speedAt = (_u: number) => 200;
    if (tel?.t?.length) {
      const T = tel.t[tel.t.length - 1] || 1, M = tel.t.length;
      const tf: number[] = tel.t.map((v: number) => v / T);
      timeToDist = (f: number) => {
        const x = wrap(f);
        let lo = 0, hi = M - 1;
        while (lo < hi) { const m = (lo + hi) >> 1; if (tf[m] < x) lo = m + 1; else hi = m; }
        const i = Math.max(1, lo), t0 = tf[i - 1], t1 = tf[i];
        return Math.min(0.99999, ((i - 1) + (t1 > t0 ? (x - t0) / (t1 - t0) : 0)) / (M - 1));
      };
      speedAt = (u: number) => tel.speed[Math.min(M - 1, Math.round(wrap(u) * (M - 1)))];
    }
    // heading table: yaw/pitch along the line, smoothed as unit vectors (wrap-safe). Cars and cameras
    // are oriented from yaw + pitch only, so there is never any roll (no flips on reversed headings).
    const H = 2400, yaw = new Float32Array(H + 1), pitch = new Float32Array(H + 1);
    const cx = new Float32Array(H), sz = new Float32Array(H), py = new Float32Array(H);
    for (let i = 0; i < H; i++) { const t = curve.getTangentAt(i / H); const y = Math.atan2(-t.z, t.x); cx[i] = Math.cos(y); sz[i] = Math.sin(y); py[i] = Math.asin(Math.max(-1, Math.min(1, t.y))); }
    const win = Math.max(2, Math.round((8 / length) * H));
    for (let i = 0; i <= H; i++) {
      let a = 0, b = 0, c2 = 0;
      for (let k = -win; k <= win; k++) { const j = (i + k + H * 4) % H; a += cx[j]; b += sz[j]; c2 += py[j]; }
      yaw[i] = Math.atan2(b, a); pitch[i] = c2 / (2 * win + 1);
    }
    const poseAt = (u: number) => {
      const x = wrap(u) * H, i = Math.floor(x), f = x - i;
      let d = yaw[(i + 1) % H] - yaw[i]; d = Math.atan2(Math.sin(d), Math.cos(d));
      return { yaw: yaw[i] + d * f, pitch: pitch[i] + (pitch[(i + 1) % H] - pitch[i]) * f };
    };
    const box = new THREE.Box3().setFromPoints(mid);
    // trackside TV cameras every ~350 m, set back from the line
    const cams: { u: number; pos: THREE.Vector3 }[] = [];
    const nCams = Math.max(8, Math.round(length / 350));
    for (let k = 0; k < nCams; k++) {
      const u = k / nCams, p = curve.getPointAt(u), t = curve.getTangentAt(u), sd = new THREE.Vector3().crossVectors(t, up).normalize();
      cams.push({ u, pos: p.clone().addScaledVector(sd, (k % 2 ? 1 : -1) * 34).add(new THREE.Vector3(0, 7 + (k % 3) * 3, 0)).addScaledVector(t, 40) });
    }
    return { curve, length, asphalt, kerbL, kerbR, lineL, lineR, box, minY: box.min.y, timeToDist, speedAt, cams, tel, poseAt };
  }, [track]);
}
export type Circuit = ReturnType<typeof useCircuit>;

export function TrackMesh({ c }: { c: Circuit }) {
  return (
    <>
      <mesh geometry={c.asphalt} receiveShadow><meshStandardMaterial color="#202229" roughness={0.86} metalness={0.1} side={THREE.DoubleSide} /></mesh>
      <mesh geometry={c.kerbL}><meshStandardMaterial vertexColors roughness={0.6} side={THREE.DoubleSide} /></mesh>
      <mesh geometry={c.kerbR}><meshStandardMaterial vertexColors roughness={0.6} side={THREE.DoubleSide} /></mesh>
      <mesh geometry={c.lineL}><meshBasicMaterial color="#e8e8ec" side={THREE.DoubleSide} /></mesh>
      <mesh geometry={c.lineR}><meshBasicMaterial color="#e8e8ec" side={THREE.DoubleSide} /></mesh>
      <Gantry c={c} />
    </>
  );
}

function Gantry({ c }: { c: Circuit }) {
  const p = c.curve.getPointAt(0), t = c.curve.getTangentAt(0);
  const yaw = Math.atan2(-t.z, t.x);
  const checker = useMemo(() => {
    const cv = document.createElement("canvas"); cv.width = 16; cv.height = 128;
    const g = cv.getContext("2d")!;
    for (let y = 0; y < 16; y++) for (let x = 0; x < 2; x++) { g.fillStyle = (x + y) % 2 ? "#111" : "#f2f2f2"; g.fillRect(x * 8, y * 8, 8, 8); }
    const tx = new THREE.CanvasTexture(cv); tx.magFilter = THREE.NearestFilter; return tx;
  }, []);
  return (
    <group position={p} rotation={[0, yaw, 0]}>
      <mesh position={[0, 0.05, 0]} rotation={[-Math.PI / 2, 0, 0]}><planeGeometry args={[1.6, WIDTH]} /><meshBasicMaterial map={checker} /></mesh>
      {[-1, 1].map((s) => <mesh key={s} position={[0, 4.5, s * (WIDTH / 2 + 1.2)]}><boxGeometry args={[0.5, 9, 0.5]} /><meshStandardMaterial color="#1a1b22" /></mesh>)}
      <mesh position={[0, 9, 0]}><boxGeometry args={[0.8, 1.1, WIDTH + 3]} /><meshStandardMaterial color="#121318" emissive="#e10600" emissiveIntensity={0.35} /></mesh>
    </group>
  );
}

export function Pods({ feed, c }: { feed: Feed; c: Circuit }) {
  const mesh = useRef<THREE.InstancedMesh>(null!);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const color = useMemo(() => new THREE.Color(), []);
  useFrame(() => {
    const cars = feed.current.cars;
    for (let i = 0; i < 24; i++) {
      const s = cars[i];
      if (!s || !s.visible || s.selected || s.ghost) { dummy.scale.setScalar(0); dummy.updateMatrix(); mesh.current.setMatrixAt(i, dummy.matrix); continue; }
      const u = c.timeToDist(s.frac), p = c.curve.getPointAt(u), pose = c.poseAt(u);
      const side = new THREE.Vector3(Math.sin(pose.yaw), 0, Math.cos(pose.yaw));
      dummy.position.copy(p).addScaledVector(side, ((i % 5) - 2) * 1.5).setY(p.y + 0.5);
      setPose(dummy.quaternion, pose.yaw, pose.pitch);
      dummy.scale.set(5.2, 0.5, 1.5);
      dummy.updateMatrix();
      mesh.current.setMatrixAt(i, dummy.matrix);
      mesh.current.setColorAt(i, color.set(s.pitting ? "#555" : TEAM_COLOR[s.team] || "#ccc").multiplyScalar(2));
    }
    mesh.current.instanceMatrix.needsUpdate = true;
    if (mesh.current.instanceColor) mesh.current.instanceColor.needsUpdate = true;
  });
  return (
    <instancedMesh ref={mesh} args={[undefined as any, undefined as any, 24]}>
      <capsuleGeometry args={[0.5, 1, 4, 12]} />
      <meshBasicMaterial toneMapped={false} />
    </instancedMesh>
  );
}

/* a car that follows `pick(feed)` along the circuit with damped heading */
export function FollowCar({ feed, c, livery, accent, pick, ghost = false, label }: { feed: Feed; c: Circuit; livery: string; accent?: string; pick: (cars: CarState[]) => CarState | undefined; ghost?: boolean; label?: string }) {
  const g = useRef<THREE.Group>(null!);
  const spin = useRef(0), brake = useRef(0), blink = useRef(false);
  const heading = useSmoothedHeading();
  useFrame((_, dt) => {
    const s = pick(feed.current.cars);
    if (!s || !g.current) return;
    const u = c.timeToDist(s.frac), p = c.curve.getPointAt(u);
    const h = heading(c.poseAt(u), dt, feed.current.speed ?? 1);
    g.current.position.copy(p);
    setPose(g.current.quaternion, h.yaw, h.pitch);
    const v = c.speedAt(u) / 3.6, play = feed.current.speed ?? 1;
    spin.current = Math.min(60, (v / 0.36) * Math.min(play, 1.5));
    brake.current = play > 0 && c.speedAt(u + 0.004) < c.speedAt(u) - 4 ? 1 : 0;
    blink.current = !!feed.current.sc;
    g.current.visible = s.visible;
  });
  return (
    <group ref={g}>
      {hasCar() ? <CarModel livery={livery} accent={accent} compound={feed.current.compound} spin={spin} brake={brake} rainBlink={blink} jackOnChange={false} />
        : <Car compound={feed.current.compound} spin={spin} jackOnChange={false} />}
      {ghost ? null : <pointLight position={[0, 3, 0]} intensity={40} distance={30} color="#ffffff" />}
      {label && <Html position={[0, 3.0, 0]} center distanceFactor={10} zIndexRange={[20, 0]}>
        <span className="tag-skew" style={{ background: ghost ? "#f5f5f7" : "#e10600", color: ghost ? "#111" : "#fff", whiteSpace: "nowrap" }}><span>{label}</span></span>
      </Html>}
    </group>
  );
}

export function Cameras({ feed, c, mode, pick }: { feed: Feed; c: Circuit; mode: string; pick: (cars: CarState[]) => CarState | undefined }) {
  const { camera } = useThree();
  const pos = useRef(new THREE.Vector3()), look = useRef(new THREE.Vector3());
  const first = useRef(true), cam = useRef(0);
  const tmp = useMemo(() => new THREE.Vector3(), []);
  const fwd = useMemo(() => new THREE.Vector3(), []);
  const heading = useSmoothedHeading();
  useFrame(({ clock }, dt) => {
    if (mode === "overview") { first.current = true; return; }
    const s = pick(feed.current.cars);
    if (!s) return;
    const play = Math.max(1, feed.current.speed ?? 1);
    const u = c.timeToDist(s.frac), p = c.curve.getPointAt(u);
    const h = heading(c.poseAt(u), dt, play);
    fwd.set(Math.cos(h.yaw), 0, -Math.sin(h.yaw));
    if (mode === "tcam") {
      // rigid onboard camera above the airbox, pitched with the car
      pos.current.copy(p).addScaledVector(fwd, -0.35).setY(p.y + 1.32);
      look.current.copy(pos.current).addScaledVector(fwd, 30).setY(p.y + 1.32 + Math.tan(h.pitch) * 30 - 0.25);
    } else if (mode === "chase") {
      // locked behind the car's smoothed heading: moves with the car, never against it
      pos.current.copy(p).addScaledVector(fwd, -11.5).setY(p.y + 3.4);
      look.current.copy(p).addScaledVector(fwd, 16).setY(p.y + 1.0);
    } else if (mode === "tv") {
      let best = 0, bd = Infinity;
      c.cams.forEach((cc, i) => { const d = wrap(cc.u - u); if (d < bd && d > 0.002) { bd = d; best = i; } });
      const cut = best !== cam.current; cam.current = best;
      pos.current.copy(c.cams[best].pos);
      look.current.lerp(tmp.copy(p).setY(p.y + 0.8), first.current || cut ? 1 : damp(7 * Math.sqrt(play), dt));
    } else {
      const a = clock.elapsedTime * 0.08;
      pos.current.lerp(tmp.set(p.x + Math.cos(a) * 80, p.y + 52, p.z + Math.sin(a) * 80), first.current ? 1 : damp(2.5 * Math.sqrt(play), dt));
      look.current.lerp(p, first.current ? 1 : damp(6 * Math.sqrt(play), dt));
    }
    first.current = false;
    camera.position.copy(pos.current);
    camera.lookAt(look.current);
  });
  return mode === "overview" ? <OrbitControls makeDefault target={c.box.getCenter(new THREE.Vector3())} maxPolarAngle={1.35} minDistance={200} maxDistance={4000} /> : null;
}

export function Atmosphere({ c, far = false }: { c: Circuit; far?: boolean }) {
  return (
    <>
      <color attach="background" args={["#07070b"]} />
      <fog attach="fog" args={["#07070b", far ? 2500 : 160, far ? 6000 : 1100]} />
      <hemisphereLight args={["#e9edf5", "#060609", 0.55]} />
      <directionalLight position={[300, 500, 200]} intensity={1.5} />
      <Grid position={[0, c.minY - 0.6, 0]} args={[20000, 20000]} cellSize={25} cellThickness={0.6} cellColor="#16161d" sectionSize={250}
        sectionThickness={1.1} sectionColor="#3a1414" fadeDistance={far ? 6000 : 800} fadeStrength={1.4} infiniteGrid />
    </>
  );
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
  const sel = (cars: CarState[]) => cars.find((x) => x.selected);
  return (
    <>
      <Atmosphere c={c} far={mode === "overview"} />
      <TrackMesh c={c} />
      <Pods feed={feed} c={c} />
      <FollowCar feed={feed} c={c} livery={livery} pick={sel} />
      <Cameras feed={feed} c={c} mode={mode} pick={sel} />
    </>
  );
}

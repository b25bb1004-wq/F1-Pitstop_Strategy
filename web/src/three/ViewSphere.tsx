/* View sphere for the Overview camera. A small globe holds a live miniature of the circuit (DRS zones in green,
 * every car as a team-coloured dot) seen from the same direction as the main camera. Drag the globe and the race
 * turns with it; orbit the main view and the globe follows. Wheel zooms, double-click resets. */
import * as THREE from "three";
import { useEffect, useMemo, useRef } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { TEAM_COLOR, Track } from "../data";
import type { Feed, ViewCtl } from "./Circuit3D";

const R = 1, ELEV = 1.6;

function Globe({ view, track, feed, pointAt }: { view: ViewCtl; track: Track; feed: Feed; pointAt: (f: number) => number[] }) {
  const { camera } = useThree();
  const dots = useRef<THREE.InstancedMesh>(null!);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const col = useMemo(() => new THREE.Color(), []);
  const sph = useMemo(() => new THREE.Spherical(), []);

  // miniature circuit in the globe's equatorial plane, same axes as the 3D scene
  const mini = useMemo(() => {
    const a = track.aspect || 0.6;
    const raw = track.points.map(([x, y], i) => [x - 0.5, (track.z?.[i] ?? 0) * ELEV, -(y - a / 2)]);
    const k = (0.82 * R) / Math.max(...raw.map(([x, , z]) => Math.hypot(x, z)));
    const toMini = (x: number, y: number, z: number) => new THREE.Vector3(x * k, y * k - 0.02, z * k);
    const pts = raw.map(([x, y, z]) => toMini(x, y, z));
    const drs = track.drs_zone, n = pts.length;
    const cols: number[] = [];
    const g = new THREE.Color("#22d65a"), w = new THREE.Color("#d9d9de");
    const pos: number[] = [];
    for (let i = 0; i < n; i++) {
      const p = pts[i], q = pts[(i + 1) % n];
      const on = drs && drs[Math.round((i / (n - 1)) * (drs.length - 1))] === 1;
      pos.push(p.x, p.y, p.z, q.x, q.y, q.z);
      for (let j = 0; j < 2; j++) cols.push(...(on ? g : w).toArray());
    }
    const line = new THREE.BufferGeometry();
    line.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    line.setAttribute("color", new THREE.Float32BufferAttribute(cols, 3));
    // start / finish tick across the track
    const p0 = pts[0], t = pts[1].clone().sub(p0).normalize(), sd = new THREE.Vector3(-t.z, 0, t.x).multiplyScalar(0.07);
    const sf = new THREE.BufferGeometry().setFromPoints([p0.clone().add(sd), p0.clone().sub(sd)]);
    return { line, sf, toMini, k, a };
  }, [track]);

  // graticule: meridians every 30 degrees, parallels every 30 degrees, equator in red
  const grid = useMemo(() => {
    const pos: number[] = [];
    const seg = (f: (s: number) => THREE.Vector3) => { for (let i = 0; i < 64; i++) { const p = f(i / 64), q = f((i + 1) / 64); pos.push(p.x, p.y, p.z, q.x, q.y, q.z); } };
    for (let m = 0; m < 6; m++) { const th = (m / 6) * Math.PI; seg((s) => new THREE.Vector3().setFromSphericalCoords(R, s * Math.PI * 2, th)); }
    for (const lat of [-60, -30, 30, 60]) { const ph = ((90 - lat) * Math.PI) / 180; seg((s) => new THREE.Vector3().setFromSphericalCoords(R, ph, s * Math.PI * 2)); }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    const eq: THREE.Vector3[] = [];
    for (let i = 0; i <= 96; i++) eq.push(new THREE.Vector3().setFromSphericalCoords(R, Math.PI / 2, (i / 96) * Math.PI * 2));
    return { g, eq: new THREE.BufferGeometry().setFromPoints(eq) };
  }, []);

  useFrame(() => {
    // look at the globe from the main camera's direction
    sph.set(4.2, Math.min(1.45, Math.max(0.04, view.pol)), view.az);
    camera.position.setFromSpherical(sph);
    camera.lookAt(0, 0, 0);
    const cars = feed.current.cars, m = dots.current;
    if (!m) return;
    for (let i = 0; i < m.count; i++) {
      const s = cars[i];
      if (!s || !s.visible) { dummy.scale.setScalar(0); dummy.updateMatrix(); m.setMatrixAt(i, dummy.matrix); continue; }
      const [px, py] = pointAt(s.frac);
      dummy.position.copy(mini.toMini(px - 0.5, 0.02 / mini.k, -(py - mini.a / 2)));
      dummy.scale.setScalar(s.selected ? 1.9 : 1);
      dummy.updateMatrix();
      m.setMatrixAt(i, dummy.matrix);
      m.setColorAt(i, col.set(s.selected ? "#ffffff" : TEAM_COLOR[s.team] || "#cccccc"));
    }
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  });

  return (
    <>
      {/* dark backdrop on the far side only, so the miniature reads in front of it; a faint glass front */}
      <mesh renderOrder={-2}><sphereGeometry args={[R, 48, 32]} /><meshBasicMaterial color="#050506" side={THREE.BackSide} /></mesh>
      <mesh renderOrder={5}><sphereGeometry args={[R, 48, 32]} /><meshBasicMaterial color="#ffffff" transparent opacity={0.035} depthWrite={false} /></mesh>
      <lineSegments geometry={grid.g}><lineBasicMaterial color="#34343c" transparent opacity={0.9} /></lineSegments>
      <lineLoop geometry={grid.eq}><lineBasicMaterial color="#e10600" /></lineLoop>
      <lineSegments geometry={mini.line}><lineBasicMaterial vertexColors /></lineSegments>
      <lineSegments geometry={mini.sf}><lineBasicMaterial color="#ffffff" /></lineSegments>
      <instancedMesh ref={dots} args={[undefined as any, undefined as any, 24]}>
        <sphereGeometry args={[0.03, 10, 8]} />
        <meshBasicMaterial toneMapped={false} />
      </instancedMesh>
    </>
  );
}

export default function ViewSphere({ view, track, feed, pointAt }: { view: ViewCtl; track: Track; feed: Feed; pointAt: (f: number) => number[] }) {
  const host = useRef<HTMLDivElement>(null);
  // drag to orbit, wheel to zoom, double-click to reset; pointer capture keeps the drag on the globe
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let drag: { x: number; y: number; id: number } | null = null;
    const down = (e: PointerEvent) => { drag = { x: e.clientX, y: e.clientY, id: e.pointerId }; try { el.setPointerCapture(e.pointerId); } catch {} view.spin = false; el.classList.add("grab"); };
    const move = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return;
      view.az -= (e.clientX - drag.x) * 0.012;
      view.pol -= (e.clientY - drag.y) * 0.01;
      view.dirty = true;
      drag.x = e.clientX; drag.y = e.clientY;
    };
    const up = (e: PointerEvent) => { if (drag && e.pointerId === drag.id) { drag = null; el.classList.remove("grab"); } };
    const wheel = (e: WheelEvent) => { e.preventDefault(); view.dist *= e.deltaY > 0 ? 1.1 : 0.9; view.dirty = true; };
    const dbl = () => { view.reset++; };
    const key = (e: KeyboardEvent) => {
      const k: Record<string, () => void> = { ArrowLeft: () => (view.az += 0.12), ArrowRight: () => (view.az -= 0.12), ArrowUp: () => (view.pol -= 0.1), ArrowDown: () => (view.pol += 0.1) };
      if (k[e.key]) { e.preventDefault(); e.stopPropagation(); k[e.key](); view.dirty = true; }
    };
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    el.addEventListener("wheel", wheel, { passive: false });
    el.addEventListener("dblclick", dbl);
    el.addEventListener("keydown", key);
    return () => {
      el.removeEventListener("pointerdown", down); el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up); el.removeEventListener("wheel", wheel); el.removeEventListener("dblclick", dbl); el.removeEventListener("keydown", key);
    };
  }, [view]);
  const set = (p: Partial<ViewCtl>) => { Object.assign(view, p, { dirty: true }); };
  return (
    <div className="vsphere">
      <div className="vs-globe" ref={host} tabIndex={0} role="slider" aria-label="View sphere: drag to rotate the race, wheel to zoom, double-click to reset, arrow keys to turn"
        aria-valuetext="camera orientation">
        <Canvas dpr={[1, 2]} camera={{ fov: 30, near: 0.1, far: 20, position: [0, 2, 4] }} gl={{ alpha: true, antialias: true }}>
          <Globe view={view} track={track} feed={feed} pointAt={pointAt} />
        </Canvas>
      </div>
      <div className="vs-btns" role="group" aria-label="View presets">
        <button onClick={() => set({ pol: 0.04 })}>Top</button>
        <button onClick={() => set({ pol: 1.05 })}>3D</button>
        <button onClick={() => { view.spin = !view.spin; }} aria-label="Toggle auto spin">Spin</button>
        <button onClick={() => { view.reset++; }}>Reset</button>
      </div>
    </div>
  );
}

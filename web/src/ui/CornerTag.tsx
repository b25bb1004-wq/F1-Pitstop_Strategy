/* Broadcast-style caption for the corner the car is in. Corners are detected from the circuit's curvature,
 * so the numbering is Pitwall's own (it can differ from official turn numbers). */
import type { Corner } from "../three/Circuit3D";

const ORD = ["", "1st", "2nd", "3rd", "4th", "5th", "6th", "7th", "8th"];
export default function CornerTag({ corner }: { corner?: Corner | null }) {
  if (!corner) return null;
  const deg = Math.round((corner.angle * 180) / Math.PI);
  return (
    <div className="corner-tag" key={corner.n} aria-live="off">
      <b>C{corner.n}</b>
      <span>{deg < 30 ? "Chicane" : `${corner.dir > 0 ? "Left" : "Right"} · ${deg}°`}</span>
      <small>apex {corner.vmin} km/h{corner.gear ? ` · ${ORD[corner.gear] || corner.gear + "th"}` : ""}</small>
    </div>
  );
}

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export function LogoTrainButton({ children, className, onClick, "aria-label": label }: {
  children: ReactNode;
  className: string;
  onClick: () => void;
  "aria-label"?: string;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const clicks = useRef({ count: 0, last: 0 });
  const [lap, setLap] = useState<{ path: string; width: number; height: number; duration: number } | null>(null);

  useEffect(() => {
    const reset = (event: MouseEvent) => {
      if (!button.current?.contains(event.target as Node)) clicks.current.count = 0;
    };
    document.addEventListener("click", reset, true);
    return () => document.removeEventListener("click", reset, true);
  }, []);

  useEffect(() => {
    if (!lap) return;
    const finish = () => setLap(null);
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") finish(); };
    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    const timer = window.setTimeout(finish, (lap.duration + .6) * 1000);
    window.addEventListener("resize", finish);
    window.addEventListener("scroll", finish, true);
    window.addEventListener("keydown", escape);
    document.addEventListener("visibilitychange", finish);
    motion.addEventListener("change", finish);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("resize", finish);
      window.removeEventListener("scroll", finish, true);
      window.removeEventListener("keydown", escape);
      document.removeEventListener("visibilitychange", finish);
      motion.removeEventListener("change", finish);
    };
  }, [lap]);

  const activate = () => {
    if (!lap) {
      const now = performance.now();
      clicks.current.count = now - clicks.current.last <= 2000 ? clicks.current.count + 1 : 1;
      clicks.current.last = now;
      if (clicks.current.count === 7) {
        clicks.current.count = 0;
        const mark = button.current!.querySelector(".brand-mark")!.getBoundingClientRect();
        const width = document.documentElement.clientWidth;
        const height = window.innerHeight;
        const home = [mark.x + mark.width / 2, mark.y + mark.height / 2];
        const random = (min: number, max: number) => min + Math.random() * (max - min);
        const points = [home];
        // Cross the screen between independently placed figure-eights, coils and loops.
        const stunts = Math.floor(random(4, 7));
        for (let stunt = 0; stunt < stunts; stunt++) {
          const radiusX = random(.08, .23) * width;
          const radiusY = random(.08, .23) * height;
          const centerX = random(radiusX + 32, width - radiusX - 32);
          const centerY = random(radiusY + 32, height - radiusY - 32);
          const rotation = random(0, Math.PI * 2);
          const phase = random(0, Math.PI * 2);
          const direction = Math.random() < .5 ? -1 : 1;
          const shape = Math.floor(random(0, 3));
          const turns = Math.floor(random(1, 3));
          const steps = turns * 24;
          for (let step = 0; step <= steps; step++) {
            const angle = phase + direction * step / 24 * Math.PI * 2;
            const coil = shape === 2 ? 1 - .7 * step / steps : 1;
            const x = Math.cos(angle) * coil;
            const y = Math.sin(angle * (shape === 1 ? 2 : 1)) * coil;
            points.push([
              centerX + radiusX * (x * Math.cos(rotation) - y * Math.sin(rotation)) / Math.SQRT2,
              centerY + radiusY * (x * Math.sin(rotation) + y * Math.cos(rotation)) / Math.SQRT2,
            ]);
          }
        }
        points.push(home);
        // Smooth the joins without turning the whole trip back into a circular lap.
        const path = `M ${home.join(" ")} ` + points.slice(1).map((point, index) => {
          const previous = points[index];
          const before = points[Math.max(0, index - 1)];
          const after = points[index + 2] || home;
          const control = (axis: number, value: number) => Math.max(24, Math.min((axis ? height : width) - 24, value));
          const start = previous.map((value, axis) => control(axis, value + (point[axis] - before[axis]) / 6));
          const end = point.map((value, axis) => control(axis, value - (after[axis] - previous[axis]) / 6));
          return `C ${start.join(" ")} ${end.join(" ")} ${point.join(" ")}`;
        }).join(" ");
        const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
        setLap({ path: reduced ? "" : path, width, height, duration: reduced ? 4.5 : random(8, 10) });
      }
    }
    onClick();
  };

  const motion = {
    path: lap?.path, dur: `${lap?.duration}s`, fill: "freeze" as const,
    calcMode: "spline" as const, keyPoints: "0;.3;.65;1",
    keyTimes: "0;.33;.66;1",
    keySplines: Array(3).fill(".3 .2 .7 .8").join(";"),
  };

  return <>
    <button ref={button} type="button" className={`${className}${lap?.path ? " logo-on-lap" : ""}`} onClick={activate} aria-label={label}>
      {children}
    </button>
    {lap && createPortal(
      <div className="logo-lap">
        {lap.path && <svg className="logo-lap-track" viewBox={`0 0 ${lap.width} ${lap.height}`} aria-hidden="true">
          {[6, 5, 4, 3, 2, 1].map(dot => <circle key={dot} r={3} fill="var(--signal)" stroke="var(--surface)" strokeWidth={1.5} opacity={1 - dot * .1}>
            <animateMotion {...motion} begin={`${dot * .06}s`} />
            <set attributeName="visibility" to="hidden" begin="0s" dur={`${dot * .06}s`} />
          </circle>)}
          <g shapeRendering="crispEdges" stroke="#13251c" strokeWidth={2} strokeLinejoin="miter">
            <animateMotion {...motion} rotate="auto" />
            <path d="M-22 8V-14H-8V-4H14V8Z" fill="var(--train-main, #ff9c77)" />
            <path d="M-25-14H-5M7-4V-15H14V-4M-24 8H20L15 1" fill="var(--train-detail, #d65535)" />
            <path d="M-18-10H-12V-4H-18Z" fill="#d7ffe8" stroke="none" />
            <path d="M-18 8H-10V14H-18ZM1 8H9V14H1Z" fill="#13251c" />
            <path d="M-16 10H-12V12H-16ZM3 10H7V12H3Z" fill="#d7ffe8" stroke="none" />
          </g>
        </svg>}
        <div className="logo-lap-message" role="status">
          <strong>TraceMini went off the rails.</strong>
          <span>All commits lead somewhere. Mostly to another bug.</span>
        </div>
      </div>, document.body,
    )}
  </>;
}

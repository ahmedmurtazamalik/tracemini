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
  const [lap, setLap] = useState<{ path: string; width: number; height: number } | null>(null);

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
    const timer = window.setTimeout(finish, 5000);
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
        // Visit every side of the viewport, with fresh waypoints and direction each lap.
        const points = [[.5, .1], [.85, .2], [.9, .65], [.65, .9], [.25, .85], [.1, .5]]
          .map(([x, y]) => [
            Math.max(32, Math.min(width - 32, (x + (Math.random() - .5) * .14) * width)),
            Math.max(32, Math.min(height - 32, (y + (Math.random() - .5) * .14) * height)),
          ]);
        if (Math.random() < .5) points.reverse();
        points.push(home);
        const path = `M ${home.join(" ")} ` + points.map((point, index) => {
          const next = points[index + 1] || home;
          return `Q ${point.join(" ")} ${(point[0] + next[0]) / 2} ${(point[1] + next[1]) / 2}`;
        }).join(" ");
        setLap({ path: matchMedia("(prefers-reduced-motion: reduce)").matches ? "" : path, width, height });
      }
    }
    onClick();
  };

  return <>
    <button ref={button} type="button" className={`${className}${lap?.path ? " logo-on-lap" : ""}`} onClick={activate} aria-label={label}>
      {children}
    </button>
    {lap && createPortal(
      <div className="logo-lap">
        {lap.path && <svg className="logo-lap-track" viewBox={`0 0 ${lap.width} ${lap.height}`} aria-hidden="true">
          {[5, 4, 3, 2, 1].map(dot => <circle key={dot} r={3} fill="var(--signal)" stroke="var(--surface)" strokeWidth={1.5} opacity={1 - dot * .12}>
            <animateMotion path={lap.path} dur="4.5s" begin={`${dot * .06}s`} fill="freeze" />
            <set attributeName="visibility" to="hidden" begin="0s" dur={`${dot * .06}s`} />
          </circle>)}
          <g shapeRendering="crispEdges" stroke="#13251c" strokeWidth={2} strokeLinejoin="miter">
            <animateMotion path={lap.path} dur="4.5s" rotate="auto" fill="freeze" />
            <path d="M-22 8V-14H-8V-4H14V8Z" fill="#19df91" />
            <path d="M-25-14H-5M7-4V-15H14V-4M-24 8H20L15 1" fill="#166c45" />
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

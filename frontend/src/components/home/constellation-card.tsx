import Link from "next/link";
import type { ComponentType } from "react";

type Point = { x: number; y: number };

type Props = {
  href: string;
  title: string;
  description: string;
  icon: ComponentType<{ className?: string }>;
  constellation: Point[]; // points in 0..100 viewBox
  edges: [number, number][]; // indices into constellation
};

export function ConstellationCard({
  href,
  title,
  description,
  icon: Icon,
  constellation,
  edges,
}: Props) {
  return (
    <Link href={href} className="group relative block">
      <div className="border-border/60 bg-background/40 hover:border-primary/50 hover:shadow-primary/25 relative h-full overflow-hidden rounded-xl border backdrop-blur-md transition-all duration-500 group-hover:-translate-y-1 group-hover:shadow-[0_0_40px_-8px]">
        {/* Constellation — decorative, connects on hover */}
        <svg
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 h-full w-full opacity-60 transition-opacity duration-500 group-hover:opacity-100"
        >
          {edges.map(([a, b], i) => {
            const p1 = constellation[a];
            const p2 = constellation[b];
            return (
              <line
                key={i}
                x1={p1.x}
                y1={p1.y}
                x2={p2.x}
                y2={p2.y}
                strokeWidth="0.3"
                strokeLinecap="round"
                className="origin-center opacity-0 transition-opacity duration-700 group-hover:opacity-70"
                style={{
                  stroke: "var(--brand)",
                  transitionDelay: `${i * 60}ms`,
                }}
              />
            );
          })}
          {constellation.map((p, i) => (
            <circle
              key={i}
              cx={p.x}
              cy={p.y}
              r="0.8"
              className="transition-all duration-500"
              style={{ fill: "var(--brand)" }}
            >
              <animate
                attributeName="opacity"
                values="0.4;1;0.4"
                dur={`${2 + (i % 3)}s`}
                repeatCount="indefinite"
                begin={`${i * 0.3}s`}
              />
            </circle>
          ))}
        </svg>

        <div className="relative p-6">
          <div className="mb-3 flex items-center gap-3">
            <div className="bg-brand-soft border-primary/30 text-primary shadow-primary/40 flex size-10 shrink-0 items-center justify-center rounded-lg border shadow-[0_0_20px_-4px] transition-all duration-500 group-hover:scale-110 group-hover:rotate-[8deg]">
              <Icon className="size-5" />
            </div>
            <h2 className="text-foreground text-lg font-semibold tracking-tight">
              {title}
            </h2>
          </div>
          <p className="text-muted-foreground text-sm leading-relaxed">
            {description}
          </p>
        </div>
      </div>
    </Link>
  );
}

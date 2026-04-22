import { CalendarDays } from "lucide-react";

import { ConstellationCard } from "@/components/home/constellation-card";
import { FloatingStars } from "@/components/home/floating-stars";
import { GalaxyBackground } from "@/components/home/galaxy-background";
import { LibraryIcon } from "@/components/icons/library-icon";

const tools = [
  {
    href: "/library",
    title: "Library",
    description:
      "Browse, edit, and organize your music across the filesystem and SoundCloud. Edit metadata, manage playlists, and explore likes.",
    icon: LibraryIcon,
    // Lyra-ish
    constellation: [
      { x: 18, y: 20 },
      { x: 32, y: 30 },
      { x: 24, y: 48 },
      { x: 40, y: 56 },
      { x: 58, y: 44 },
      { x: 72, y: 62 },
      { x: 84, y: 36 },
    ],
    edges: [
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 4],
      [4, 5],
      [4, 6],
    ] as [number, number][],
  },
  {
    href: "/weekly",
    title: "Weekly Favorites",
    description:
      "Browse recent tracks from followed artists and create weekly playlists.",
    icon: CalendarDays,
    // Orion-ish dipper
    constellation: [
      { x: 14, y: 28 },
      { x: 30, y: 20 },
      { x: 48, y: 30 },
      { x: 60, y: 50 },
      { x: 44, y: 62 },
      { x: 26, y: 58 },
      { x: 80, y: 40 },
    ],
    edges: [
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 4],
      [4, 5],
      [5, 0],
      [3, 6],
    ] as [number, number][],
  },
];

export default function Home() {
  return (
    <div className="relative flex h-full min-h-full w-full flex-col overflow-hidden">
      <GalaxyBackground />
      <FloatingStars />

      <div className="relative z-10 mx-auto flex w-full max-w-4xl flex-1 flex-col justify-center px-6 py-16">
        <div className="mb-16 flex flex-col items-center text-center">
          <div className="relative">
            {/* Twinkling ornaments around the title */}
            <span
              aria-hidden="true"
              className="bg-primary shadow-primary/60 absolute -top-2 -left-6 size-1.5 animate-pulse rounded-full opacity-80 shadow-[0_0_12px_2px]"
            />
            <span
              aria-hidden="true"
              className="bg-primary shadow-primary/50 absolute top-4 -right-8 size-1 animate-pulse rounded-full opacity-70 shadow-[0_0_10px_2px] [animation-delay:600ms]"
            />
            <span
              aria-hidden="true"
              className="bg-primary shadow-primary/40 absolute -bottom-1 left-10 size-1 animate-pulse rounded-full opacity-60 shadow-[0_0_8px_2px] [animation-delay:1200ms]"
            />

            {/* Decorative orbit rings with satellites circling the title */}
            <svg
              aria-hidden="true"
              viewBox="-320 -80 640 160"
              preserveAspectRatio="none"
              className="pointer-events-none absolute top-1/2 left-1/2 h-[160px] w-[640px] -translate-x-1/2 -translate-y-1/2 overflow-visible"
            >
              <ellipse
                cx="0"
                cy="0"
                rx="300"
                ry="60"
                fill="none"
                style={{
                  stroke: "var(--brand)",
                  strokeOpacity: 0.3,
                  strokeWidth: 1.5,
                  strokeDasharray: "3 6",
                }}
              />
              <ellipse
                cx="0"
                cy="0"
                rx="240"
                ry="44"
                transform="rotate(-10)"
                fill="none"
                style={{
                  stroke: "var(--brand)",
                  strokeOpacity: 0.2,
                  strokeWidth: 1.5,
                  strokeDasharray: "2 5",
                }}
              />

              {/* Satellite 1 */}
              <circle r="5" style={{ fill: "var(--brand)" }}>
                <animateMotion
                  dur="14s"
                  repeatCount="indefinite"
                  path="M 300 0 A 300 60 0 1 1 -300 0 A 300 60 0 1 1 300 0"
                />
              </circle>
              <circle r="12" style={{ fill: "var(--brand)", opacity: 0.3 }}>
                <animateMotion
                  dur="14s"
                  repeatCount="indefinite"
                  path="M 300 0 A 300 60 0 1 1 -300 0 A 300 60 0 1 1 300 0"
                />
              </circle>

              {/* Satellite 2 — opposite direction, tilted orbit */}
              <g transform="rotate(-10)">
                <circle r="4" style={{ fill: "var(--brand)" }}>
                  <animateMotion
                    dur="22s"
                    repeatCount="indefinite"
                    keyPoints="1;0"
                    keyTimes="0;1"
                    path="M 240 0 A 240 44 0 1 1 -240 0 A 240 44 0 1 1 240 0"
                  />
                </circle>
                <circle r="10" style={{ fill: "var(--brand)", opacity: 0.25 }}>
                  <animateMotion
                    dur="22s"
                    repeatCount="indefinite"
                    keyPoints="1;0"
                    keyTimes="0;1"
                    path="M 240 0 A 240 44 0 1 1 -240 0 A 240 44 0 1 1 240 0"
                  />
                </circle>
              </g>
            </svg>

            <h1 className="mb-3 flex items-center gap-0 text-8xl font-bold tracking-tight">
              <span
                className="bg-primary inline-block shrink-0 drop-shadow-[0_0_24px_var(--brand)]"
                style={{
                  maskImage: "url(/starlib-logo.svg)",
                  WebkitMaskImage: "url(/starlib-logo.svg)",
                  maskSize: "contain",
                  WebkitMaskSize: "contain",
                  maskRepeat: "no-repeat",
                  WebkitMaskRepeat: "no-repeat",
                  maskPosition: "center",
                  WebkitMaskPosition: "center",
                  width: "1.5em",
                  height: "1.5em",
                }}
                aria-hidden="true"
              />
              <span className="text-primary -ml-3 [text-shadow:0_0_40px_var(--brand-soft)]">
                Starlib
              </span>
            </h1>
          </div>
          <p className="text-muted-foreground max-w-sm text-lg">
            Music management for DJs and producers.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
          {tools.map((tool) => (
            <ConstellationCard
              key={tool.href}
              href={tool.href}
              title={tool.title}
              description={tool.description}
              icon={tool.icon}
              constellation={tool.constellation}
              edges={tool.edges}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

"use client";

import { useTheme } from "next-themes";
import { useEffect, useState } from "react";

import { useTopBar } from "@/components/layout/top-bar-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/* ──────────────────────────────────────────────────────────────────────────
   /design — dev-only showcase. Verifies DESIGN.md against the live tokens.
   Section headings link back to the relevant DESIGN.md section.
   ────────────────────────────────────────────────────────────────────────── */

const SURFACES = [
  "surface-0",
  "surface-1",
  "surface-2",
  "surface-3",
  "surface-4",
  "surface-5",
];
const TEXTS = ["text", "text-muted", "text-subtle"];
const BORDERS = ["border", "border-strong"];
const BRAND = [
  "brand",
  "brand-hover",
  "brand-active",
  "brand-soft",
  "brand-ring",
];
const SEMANTIC = ["danger", "warning", "success", "info"];
const CHARTS = ["chart-1", "chart-2", "chart-3", "chart-4", "chart-5"];

const TYPE_SCALE: Array<[string, string, number, number, number, string]> = [
  // [token, label, px, weight, line-height, tracking]
  ["text-xs", "text-xs", 11, 500, 1.45, "0.01em"],
  ["text-sm", "text-sm", 12, 500, 1.45, "0.005em"],
  ["text-base", "text-base", 14, 400, 1.55, "0"],
  ["text-md", "text-[15px]", 15, 500, 1.45, "0"],
  ["text-lg", "text-[17px]", 17, 500, 1.4, "-0.005em"],
  ["text-xl", "text-xl", 20, 600, 1.35, "-0.01em"],
  ["text-2xl", "text-2xl", 24, 600, 1.25, "-0.015em"],
  ["text-3xl", "text-3xl", 30, 600, 1.2, "-0.02em"],
  ["text-4xl", "text-4xl", 40, 600, 1.1, "-0.025em"],
];

const SPACING_STEPS = [1, 2, 3, 4, 5, 6, 8, 10, 12, 16];
const RADIUS_STEPS = ["sm", "md", "lg", "xl", "full"];
const SHADOW_STEPS = [1, 2, 3];

const KNOB_DEFAULTS = { hue: 125, chroma: 0.16, contrast: 0.6 };
const MOTION_STEPS: Array<[string, string]> = [
  ["dur-1", "80ms"],
  ["dur-2", "120ms"],
  ["dur-3", "200ms"],
  ["dur-4", "320ms"],
];

export function DesignShowcase() {
  const { theme, setTheme } = useTheme();
  const [hue, setHue] = useState(KNOB_DEFAULTS.hue);
  const [chroma, setChroma] = useState(KNOB_DEFAULTS.chroma);
  const [contrast, setContrast] = useState(KNOB_DEFAULTS.contrast);
  const [mounted, setMounted] = useState(false);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- SSR hydration flag: intentional mount signal, runs once.
  useEffect(() => setMounted(true), []);

  useTopBar({ title: "Design" });

  useEffect(() => {
    document.documentElement.style.setProperty("--accent-hue", String(hue));
  }, [hue]);
  useEffect(() => {
    document.documentElement.style.setProperty(
      "--accent-chroma",
      String(chroma),
    );
  }, [chroma]);
  useEffect(() => {
    document.documentElement.style.setProperty("--contrast", String(contrast));
  }, [contrast]);

  return (
    <div className="h-full w-full overflow-y-auto bg-[var(--surface-1)] text-[var(--text)]">
      {/* ── Sticky knob bar ──────────────────────────────────────────────── */}
      <header className="sticky top-0 z-30 border-b border-[var(--border)] bg-[var(--surface-2)]/95 backdrop-blur">
        <div className="mx-auto flex max-w-[1200px] flex-wrap items-center gap-x-6 gap-y-2 px-6 py-2">
          <div className="text-xs text-[var(--text-muted)]">
            DESIGN.md showcase — tune the knobs live
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-2">
            <KnobSlider
              label="hue"
              value={hue}
              min={0}
              max={360}
              step={1}
              onChange={setHue}
              display={`${hue}°`}
              onReset={() => setHue(KNOB_DEFAULTS.hue)}
              isDefault={hue === KNOB_DEFAULTS.hue}
            />
            <KnobSlider
              label="chroma"
              value={chroma}
              min={0}
              max={0.37}
              step={0.005}
              onChange={setChroma}
              display={chroma.toFixed(3)}
              onReset={() => setChroma(KNOB_DEFAULTS.chroma)}
              isDefault={chroma === KNOB_DEFAULTS.chroma}
            />
            <KnobSlider
              label="contrast"
              value={contrast}
              min={0}
              max={1}
              step={0.05}
              onChange={setContrast}
              display={contrast.toFixed(2)}
              onReset={() => setContrast(KNOB_DEFAULTS.contrast)}
              isDefault={contrast === KNOB_DEFAULTS.contrast}
            />
            {mounted && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
              >
                {theme === "dark" ? "Light" : "Dark"}
              </Button>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1200px] space-y-16 px-6 py-10">
        <Section id="tokens" title="Tokens" specRef="DESIGN.md §2">
          <SubSection title="Surface ramp">
            <SwatchRow names={SURFACES} bordered />
          </SubSection>
          <SubSection title="Text ramp (rendered as text)">
            <div className="flex flex-col gap-2">
              {TEXTS.map((t) => (
                <div key={t} className="flex items-baseline gap-4">
                  <span className="w-32 font-mono text-xs text-[var(--text-muted)]">
                    --{t}
                  </span>
                  <span style={{ color: `var(--${t})` }} className="text-base">
                    The quick brown fox jumps over the lazy dog
                  </span>
                </div>
              ))}
              <div className="flex items-baseline gap-4">
                <span className="w-32 font-mono text-xs text-[var(--text-muted)]">
                  --text-on-accent
                </span>
                <span
                  className="rounded-md px-2 py-1 text-base"
                  style={{
                    background: "var(--brand)",
                    color: "var(--text-on-accent)",
                  }}
                >
                  on brand fill
                </span>
              </div>
              <div className="flex items-baseline gap-4">
                <span className="w-32 font-mono text-xs text-[var(--text-muted)]">
                  --text-on-danger
                </span>
                <span
                  className="rounded-md px-2 py-1 text-base"
                  style={{
                    background: "var(--danger)",
                    color: "var(--text-on-danger)",
                  }}
                >
                  on danger fill
                </span>
              </div>
            </div>
          </SubSection>
          <SubSection title="Borders">
            <SwatchRow names={BORDERS} />
          </SubSection>
          <SubSection title="Brand + state">
            <SwatchRow names={BRAND} />
          </SubSection>
          <SubSection title="Semantic">
            <SwatchRow names={SEMANTIC} />
          </SubSection>
          <SubSection title="Charts">
            <SwatchRow names={CHARTS} />
          </SubSection>
        </Section>

        <Section id="typography" title="Typography" specRef="DESIGN.md §3">
          <div className="flex flex-col gap-3">
            {TYPE_SCALE.map(([token, , px, weight, lh, tracking]) => (
              <div
                key={token}
                className="grid grid-cols-[10rem_1fr] items-baseline gap-4 border-b border-[var(--border)] pb-3 last:border-0"
              >
                <div className="font-mono text-xs text-[var(--text-muted)]">
                  {token}
                  <div className="mt-1 text-[10px] opacity-70">
                    {px}px · {weight} · {lh} · {tracking}
                  </div>
                </div>
                <div
                  style={{
                    fontSize: `${px}px`,
                    fontWeight: weight,
                    lineHeight: lh,
                    letterSpacing: tracking,
                  }}
                >
                  Mixing tracks at twilight — Starlib
                </div>
              </div>
            ))}
            <div className="grid grid-cols-[10rem_1fr] items-baseline gap-4 pt-2">
              <div className="font-mono text-xs text-[var(--text-muted)]">
                Geist Mono
                <div className="mt-1 text-[10px] opacity-70">14px · 400</div>
              </div>
              <div className="font-mono text-sm">
                128.00 BPM · A♭ minor · 06:42 · /Users/dj/library/track.aiff
              </div>
            </div>
          </div>
        </Section>

        <Section id="spacing" title="Spacing" specRef="DESIGN.md §4">
          <div className="flex flex-col gap-2">
            {SPACING_STEPS.map((n) => (
              <div key={n} className="flex items-center gap-4">
                <div className="w-16 font-mono text-xs text-[var(--text-muted)]">
                  {n} · {n * 4}px
                </div>
                <div
                  className="h-3 rounded-sm bg-[var(--brand-soft)]"
                  style={{ width: `${n * 4}px` }}
                />
              </div>
            ))}
          </div>
        </Section>

        <Section id="radii" title="Radii" specRef="DESIGN.md §5">
          <div className="flex flex-wrap items-end gap-6">
            {RADIUS_STEPS.map((r) => (
              <div key={r} className="flex flex-col items-center gap-2">
                <div
                  className="size-20 border border-[var(--border-strong)] bg-[var(--surface-3)]"
                  style={{
                    borderRadius: r === "full" ? 9999 : `var(--radius-${r})`,
                  }}
                />
                <div className="font-mono text-xs text-[var(--text-muted)]">
                  --radius-{r}
                </div>
              </div>
            ))}
          </div>
        </Section>

        <Section id="borders" title="Borders" specRef="DESIGN.md §6">
          <div className="flex gap-4">
            <div className="flex flex-col items-center gap-2">
              <div className="size-24 rounded-md border border-[var(--border)] bg-[var(--surface-2)]" />
              <div className="font-mono text-xs text-[var(--text-muted)]">
                --border
              </div>
            </div>
            <div className="flex flex-col items-center gap-2">
              <div className="size-24 rounded-md border border-[var(--border-strong)] bg-[var(--surface-2)]" />
              <div className="font-mono text-xs text-[var(--text-muted)]">
                --border-strong
              </div>
            </div>
          </div>
        </Section>

        <Section id="shadows" title="Shadows" specRef="DESIGN.md §7">
          <div className="flex flex-wrap gap-8 py-6">
            {SHADOW_STEPS.map((n) => (
              <div key={n} className="flex flex-col items-center gap-3">
                <div
                  className="size-28 rounded-md bg-[var(--surface-2)]"
                  style={{ boxShadow: `var(--shadow-${n})` }}
                />
                <div className="font-mono text-xs text-[var(--text-muted)]">
                  --shadow-{n}
                </div>
              </div>
            ))}
          </div>
        </Section>

        <Section id="motion" title="Motion" specRef="DESIGN.md §8">
          <p className="mb-4 text-sm text-[var(--text-muted)]">
            Hover any tile.
          </p>
          <div className="flex flex-wrap gap-4">
            {MOTION_STEPS.map(([token, label]) => (
              <div
                key={token}
                className="group flex h-24 w-40 cursor-default items-center justify-center rounded-md border border-[var(--border)] bg-[var(--surface-2)] transition-transform hover:scale-105 hover:bg-[var(--surface-3)]"
                style={{
                  transitionDuration: `var(--${token})`,
                  transitionTimingFunction: "var(--ease-standard)",
                }}
              >
                <div className="text-center">
                  <div className="font-mono text-xs">--{token}</div>
                  <div className="text-[10px] text-[var(--text-muted)]">
                    {label}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Section>

        <Section id="components" title="Components" specRef="DESIGN.md §9">
          <SubSection title="Buttons — in-app action hierarchy">
            <p className="mb-3 text-xs text-[var(--text-muted)]">
              In-app pages use{" "}
              <code className="font-mono">variant=&quot;ghost&quot;</code> for
              everything. Hierarchy is carried by text color and state, not by
              switching variants. Solid{" "}
              <code className="font-mono">default</code> is reserved for
              marketing surfaces and confirmation dialogs.
            </p>
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--surface-2)] p-3">
              <Button
                variant="ghost"
                size="sm"
                className="text-primary hover:bg-primary/10 hover:text-primary h-7 gap-1.5 text-xs"
              >
                Save all (3)
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1.5 text-xs text-emerald-600 hover:bg-emerald-600/10 hover:text-emerald-600"
              >
                Apply rules
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground hover:text-foreground h-7 gap-1.5 text-xs"
              >
                Auto-fill
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground/40 h-7 gap-1.5 text-xs"
                disabled
              >
                Save all
              </Button>
            </div>
            <p className="mt-2 text-[10px] text-[var(--text-muted)]">
              Primary (brand) · Finalize (emerald) · Secondary (muted) ·
              Disabled primary (kept in slot, muted)
            </p>
          </SubSection>
          <SubSection title="Buttons — variant gallery">
            <p className="mb-3 text-xs text-[var(--text-muted)]">
              All shadcn variants for reference. Inside the app, prefer{" "}
              <code className="font-mono">ghost</code> per the table above.
            </p>
            <div className="flex flex-wrap gap-3">
              <Button variant="ghost">Ghost</Button>
              <Button variant="secondary">Secondary</Button>
              <Button variant="outline">Outline</Button>
              <Button variant="destructive">Destructive</Button>
              <Button>Default (marketing / confirm only)</Button>
              <Button variant="link">Link</Button>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <Button variant="ghost" size="sm">
                Small
              </Button>
              <Button variant="ghost">Default</Button>
              <Button variant="ghost" size="lg">
                Large
              </Button>
              <Button variant="ghost" size="icon" aria-label="icon">
                ★
              </Button>
              <Button variant="ghost" disabled>
                Disabled
              </Button>
            </div>
          </SubSection>
          <SubSection title="Inputs">
            <div className="grid max-w-md gap-3">
              <Input placeholder="Search tracks…" />
              <Input placeholder="Disabled" disabled />
              <Input aria-invalid placeholder="Invalid" />
            </div>
          </SubSection>
          <SubSection title="Badges">
            <div className="flex flex-wrap gap-2">
              <Badge>Default</Badge>
              <Badge variant="secondary">Secondary</Badge>
              <Badge variant="outline">Outline</Badge>
              <Badge variant="destructive">Destructive</Badge>
            </div>
          </SubSection>
          <SubSection title="Cards">
            <div className="grid gap-4 md:grid-cols-3">
              <Card>
                <CardHeader>
                  <CardTitle>Weekly Favorites</CardTitle>
                  <CardDescription>
                    14 new tracks from artists you follow
                  </CardDescription>
                </CardHeader>
                <CardContent className="text-sm text-[var(--text-muted)]">
                  Generated for week 16 · auto-synced from SoundCloud.
                </CardContent>
                <CardFooter>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-primary hover:bg-primary/10 hover:text-primary h-7 text-xs"
                  >
                    Open
                  </Button>
                </CardFooter>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>Library Sync</CardTitle>
                  <CardDescription>Last sync 2 minutes ago</CardDescription>
                  <CardAction>
                    <Button size="sm" variant="ghost">
                      Sync now
                    </Button>
                  </CardAction>
                </CardHeader>
                <CardContent className="text-sm">
                  <div className="flex justify-between border-b border-[var(--border)] py-1.5">
                    <span className="text-[var(--text-muted)]">Tracks</span>
                    <span className="font-mono">2,184</span>
                  </div>
                  <div className="flex justify-between border-b border-[var(--border)] py-1.5">
                    <span className="text-[var(--text-muted)]">
                      Missing metadata
                    </span>
                    <span className="font-mono">37</span>
                  </div>
                  <div className="flex justify-between py-1.5">
                    <span className="text-[var(--text-muted)]">Storage</span>
                    <span className="font-mono">68.4 GB</span>
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>Playlist · Late Night</CardTitle>
                  <CardDescription>Drafted from 12 selections</CardDescription>
                </CardHeader>
                <CardContent className="text-sm text-[var(--text-muted)]">
                  Average BPM 124 · key range A♭m to F♯m · 47 min total.
                </CardContent>
                <CardFooter className="gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-primary hover:bg-primary/10 hover:text-primary h-7 text-xs"
                  >
                    Publish
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-muted-foreground hover:text-foreground h-7 text-xs"
                  >
                    Discard
                  </Button>
                </CardFooter>
              </Card>
            </div>
          </SubSection>

          <SubSection title="Table (DESIGN.md §9.5)">
            <div className="overflow-hidden rounded-md border border-[var(--border)]">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Title</TableHead>
                    <TableHead>Artist</TableHead>
                    <TableHead>Genre</TableHead>
                    <TableHead className="text-right">BPM</TableHead>
                    <TableHead className="text-right">Key</TableHead>
                    <TableHead className="text-right">Length</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {[
                    {
                      sel: false,
                      title: "Northern Drift",
                      artist: "Auval",
                      genre: "Melodic Techno",
                      bpm: "122.0",
                      key: "F♯m",
                      len: "06:42",
                    },
                    {
                      sel: true,
                      title: "Lower Quay",
                      artist: "Mira Sand",
                      genre: "Deep House",
                      bpm: "118.5",
                      key: "A♭m",
                      len: "07:18",
                    },
                    {
                      sel: false,
                      title: "Outline of a Storm",
                      artist: "Hiver",
                      genre: "Progressive",
                      bpm: "124.0",
                      key: "C♯m",
                      len: "08:02",
                    },
                    {
                      sel: false,
                      title: "Glassgrove",
                      artist: "Lurke",
                      genre: "Organic House",
                      bpm: "120.0",
                      key: "Em",
                      len: "06:11",
                    },
                    {
                      sel: false,
                      title: "Pale Engine",
                      artist: "Vector / Two",
                      genre: "Techno",
                      bpm: "128.0",
                      key: "Gm",
                      len: "07:44",
                    },
                  ].map((r) => (
                    <TableRow
                      key={r.title}
                      data-state={r.sel ? "selected" : undefined}
                    >
                      <TableCell className="font-medium">{r.title}</TableCell>
                      <TableCell className="text-[var(--text-muted)]">
                        {r.artist}
                      </TableCell>
                      <TableCell className="text-[var(--text-muted)]">
                        {r.genre}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {r.bpm}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {r.key}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {r.len}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </SubSection>

          <SubSection title="Selected row (brand-soft)">
            <div className="overflow-hidden rounded-md border border-[var(--border)]">
              {["Track A", "Track B (selected)", "Track C"].map((t, i) => (
                <div
                  key={t}
                  className={`flex items-center justify-between border-b border-[var(--border)] px-3 py-2 text-sm last:border-0 ${
                    i === 1
                      ? "bg-[var(--brand-soft)]"
                      : "hover:bg-[var(--surface-3)]"
                  }`}
                >
                  <span>{t}</span>
                  <span className="font-mono text-xs text-[var(--text-muted)]">
                    128.0 · A♭m
                  </span>
                </div>
              ))}
            </div>
          </SubSection>
        </Section>

        <Section
          id="layout"
          title="Layout (inverted L)"
          specRef="DESIGN.md §10"
        >
          <div className="flex h-64 overflow-hidden rounded-lg border border-[var(--border)]">
            <div className="w-12 border-r border-[var(--border)] bg-[var(--surface-2)] p-2">
              <div className="size-6 rounded-md bg-[var(--brand)]" />
              <div className="mt-3 size-6 rounded-md bg-[var(--surface-3)]" />
              <div className="mt-1 size-6 rounded-md bg-[var(--brand-soft)]" />
            </div>
            <div className="flex flex-1 flex-col">
              <div className="flex h-11 items-center justify-between border-b border-[var(--border)] bg-[var(--surface-2)] px-4 text-sm">
                <span className="font-medium">View title</span>
                <span className="text-[var(--text-muted)]">action slot →</span>
              </div>
              <div className="flex-1 bg-[var(--surface-1)] p-4">
                <div className="text-sm text-[var(--text-muted)]">
                  Main view (scrolls).
                </div>
              </div>
            </div>
          </div>
        </Section>
      </main>
    </div>
  );
}

/* ── Helpers ─────────────────────────────────────────────────────────────── */

function Section({
  id,
  title,
  specRef,
  children,
}: {
  id: string;
  title: string;
  specRef: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="space-y-6">
      <div className="flex items-baseline justify-between border-b border-[var(--border)] pb-2">
        <h2 className="text-2xl font-semibold tracking-tight">{title}</h2>
        <span className="font-mono text-xs text-[var(--text-muted)]">
          {specRef}
        </span>
      </div>
      <div className="space-y-8">{children}</div>
    </section>
  );
}

function SubSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-3">
      <h3 className="text-xs font-medium tracking-[0.04em] text-[var(--text-muted)] uppercase">
        {title}
      </h3>
      {children}
    </div>
  );
}

function SwatchRow({
  names,
  bordered = false,
}: {
  names: string[];
  bordered?: boolean;
}) {
  return (
    <div className="flex flex-wrap gap-3">
      {names.map((name) => (
        <div key={name} className="flex flex-col items-center gap-2">
          <div
            className={`size-20 rounded-md ${bordered ? "border border-[var(--border)]" : ""}`}
            style={{ background: `var(--${name})` }}
          />
          <div className="font-mono text-xs text-[var(--text-muted)]">
            --{name}
          </div>
        </div>
      ))}
    </div>
  );
}

function KnobSlider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  display,
  onReset,
  isDefault,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (n: number) => void;
  display: string;
  onReset: () => void;
  isDefault: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <label className="font-mono text-xs text-[var(--text-muted)]">
        {label}
      </label>
      <div className="w-32">
        <Slider
          value={[value]}
          min={min}
          max={max}
          step={step}
          onValueChange={(v) => onChange(v[0])}
        />
      </div>
      <span className="w-14 font-mono text-xs tabular-nums">{display}</span>
      <button
        type="button"
        onClick={onReset}
        disabled={isDefault}
        title="Reset to default"
        aria-label={`Reset ${label}`}
        className="grid size-6 place-items-center rounded-md text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-3)] hover:text-[var(--text)] disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-[var(--text-muted)]"
      >
        ↺
      </button>
    </div>
  );
}

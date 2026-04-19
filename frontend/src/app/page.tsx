import { CalendarDays } from "lucide-react";
import Link from "next/link";

import { LibraryIcon } from "@/components/icons/library-icon";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

const tools = [
  {
    href: "/library",
    title: "Library",
    description:
      "Browse, edit, and organize your music across the filesystem and SoundCloud. Edit metadata, manage playlists, and explore likes.",
    available: true,
    icon: LibraryIcon,
  },
  {
    href: "/weekly",
    title: "Weekly Favorites",
    description:
      "Browse recent tracks from followed artists and create weekly playlists.",
    available: true,
    icon: CalendarDays,
  },
];

export default function Home() {
  return (
    <div className="mx-auto max-w-4xl px-6 py-16">
      <div className="mb-16 flex flex-col items-center text-center">
        <h1 className="mb-3 flex items-center gap-0 text-8xl font-bold tracking-tight">
          <span
            className="bg-primary inline-block shrink-0"
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
          <span className="text-primary -ml-3">Starlib</span>
        </h1>
        <p className="text-muted-foreground max-w-sm text-lg">
          Music management for DJs and producers.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {tools.map((tool) => {
          const Icon = tool.icon;
          return tool.available ? (
            <Link key={tool.href} href={tool.href} className="group block">
              <Card className="border-border hover:border-primary/40 hover:shadow-primary/25 h-full transition-all duration-300 group-hover:-translate-y-0.5 hover:shadow-[0_0_30px_-8px]">
                <CardHeader>
                  <div className="flex items-center gap-3">
                    <div className="bg-brand-soft border-primary/20 text-primary flex size-9 shrink-0 items-center justify-center rounded-lg border">
                      <Icon className="size-4" />
                    </div>
                    <CardTitle className="text-base">{tool.title}</CardTitle>
                  </div>
                </CardHeader>
                <CardContent>
                  <CardDescription className="leading-relaxed">
                    {tool.description}
                  </CardDescription>
                </CardContent>
              </Card>
            </Link>
          ) : (
            <div key={tool.href}>
              <Card className="border-border h-full opacity-30">
                <CardHeader>
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-3">
                      <div className="bg-muted text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-lg">
                        <Icon className="size-4" />
                      </div>
                      <CardTitle className="text-base">{tool.title}</CardTitle>
                    </div>
                    <span className="text-muted-foreground shrink-0 font-mono text-xs">
                      Soon
                    </span>
                  </div>
                </CardHeader>
                <CardContent>
                  <CardDescription className="leading-relaxed">
                    {tool.description}
                  </CardDescription>
                </CardContent>
              </Card>
            </div>
          );
        })}
      </div>
    </div>
  );
}

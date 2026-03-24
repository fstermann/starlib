import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { FilePen, Heart, Users } from "lucide-react";

const tools = [
  {
    href: "/meta-editor",
    title: "Meta Editor",
    description:
      "Edit ID3/AIFF metadata, BPM, key, genre, and artwork. Fetch metadata directly from SoundCloud.",
    available: true,
    icon: FilePen,
  },
  {
    href: "/like-explorer",
    title: "Like Explorer",
    description: "Browse and manage your SoundCloud liked tracks.",
    available: false,
    icon: Heart,
  },
  {
    href: "/artist-manager",
    title: "Artist Manager",
    description: "Manage artist shortcuts and track collections.",
    available: false,
    icon: Users,
  },
];

export default function Home() {
  return (
    <div className="max-w-4xl mx-auto px-6 py-16">
      <div className="mb-16 flex flex-col items-center text-center">
        <div className="size-24 rounded-3xl bg-primary shadow-xl shadow-primary/30 flex items-center justify-center mb-7">
          <div
            className="size-[4.5rem] bg-white"
            style={{
              maskImage: 'url(/starlib.svg)',
              WebkitMaskImage: 'url(/starlib.svg)',
              maskSize: 'contain',
              WebkitMaskSize: 'contain',
              maskRepeat: 'no-repeat',
              WebkitMaskRepeat: 'no-repeat',
              maskPosition: 'center',
              WebkitMaskPosition: 'center',
            }}
          />
        </div>
        <h1 className="text-8xl font-bold tracking-tight mb-3">
          <span className="bg-gradient-to-r from-primary to-chart-2 bg-clip-text text-transparent">
            Starlib
          </span>
        </h1>
        <p className="text-muted-foreground text-lg max-w-sm">
          Music management for DJs and producers.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
        {tools.map((tool) => {
          const Icon = tool.icon;
          return tool.available ? (
            <Link key={tool.href} href={tool.href} className="block group">
              <Card className="h-full transition-all duration-300 border-border/60 hover:border-primary/40 hover:shadow-[0_0_30px_-8px] hover:shadow-primary/25 group-hover:-translate-y-0.5">
                <CardHeader>
                  <div className="flex items-center gap-3">
                    <div className="size-9 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center text-primary shrink-0">
                      <Icon className="size-4" />
                    </div>
                    <CardTitle className="text-base">{tool.title}</CardTitle>
                  </div>
                </CardHeader>
                <CardContent>
                  <CardDescription className="leading-relaxed">{tool.description}</CardDescription>
                </CardContent>
              </Card>
            </Link>
          ) : (
            <div key={tool.href}>
              <Card className="h-full opacity-30 border-border/30">
                <CardHeader>
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-3">
                      <div className="size-9 rounded-lg bg-muted flex items-center justify-center text-muted-foreground shrink-0">
                        <Icon className="size-4" />
                      </div>
                      <CardTitle className="text-base">{tool.title}</CardTitle>
                    </div>
                    <span className="text-[10px] text-muted-foreground font-mono uppercase tracking-widest shrink-0">
                      Soon
                    </span>
                  </div>
                </CardHeader>
                <CardContent>
                  <CardDescription className="leading-relaxed">{tool.description}</CardDescription>
                </CardContent>
              </Card>
            </div>
          );
        })}
      </div>
    </div>
  );
}

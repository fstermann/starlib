import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const tools = [
  {
    href: "/meta-editor",
    title: "Meta Editor",
    description:
      "Edit ID3/AIFF metadata, BPM, key, genre, and artwork. Fetch metadata directly from SoundCloud.",
    available: true,
  },
  {
    href: "/like-explorer",
    title: "Like Explorer",
    description: "Browse and manage your SoundCloud liked tracks.",
    available: false,
  },
  {
    href: "/artist-manager",
    title: "Artist Manager",
    description: "Manage artist shortcuts and track collections.",
    available: false,
  },
];

export default function Home() {
  return (
    <div className="max-w-4xl mx-auto px-6 py-16">
      <div className="mb-12">
        <h1 className="text-3xl font-bold text-zinc-900 dark:text-zinc-100 mb-3">Tools</h1>
        <p className="text-zinc-500 dark:text-zinc-400">
          Music management tools for DJs and producers.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {tools.map((tool) =>
          tool.available ? (
            <Link key={tool.href} href={tool.href} className="block group">
              <Card className="h-full transition-all hover:shadow-md group-hover:border-zinc-300 dark:group-hover:border-zinc-600">
                <CardHeader>
                  <CardTitle className="text-base">{tool.title}</CardTitle>
                </CardHeader>
                <CardContent>
                  <CardDescription>{tool.description}</CardDescription>
                </CardContent>
              </Card>
            </Link>
          ) : (
            <div key={tool.href}>
              <Card className="h-full opacity-50">
                <CardHeader>
                  <div className="flex items-start justify-between gap-2">
                    <CardTitle className="text-base">{tool.title}</CardTitle>
                    <span className="text-xs text-zinc-400 dark:text-zinc-500 font-medium bg-zinc-100 dark:bg-zinc-800 px-2 py-0.5 rounded-full shrink-0">
                      Soon
                    </span>
                  </div>
                </CardHeader>
                <CardContent>
                  <CardDescription>{tool.description}</CardDescription>
                </CardContent>
              </Card>
            </div>
          )
        )}
      </div>
    </div>
  );
}

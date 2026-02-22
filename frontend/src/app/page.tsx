import Link from "next/link";

export default function Home() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 font-sans dark:bg-black">
      <main className="flex min-h-screen w-full max-w-3xl flex-col items-center justify-center gap-8 py-32 px-16 bg-white dark:bg-black">
        <h1 className="text-4xl font-bold tracking-tight text-black dark:text-zinc-50">
          SoundCloud Tools
        </h1>
        <p className="text-lg text-zinc-600 dark:text-zinc-400 text-center max-w-md">
          Music management tools for DJs and producers
        </p>
        <div className="flex flex-col gap-4 w-full max-w-sm">
          <Link
            href="/meta-editor"
            className="px-6 py-3 bg-black dark:bg-white text-white dark:text-black rounded-lg hover:opacity-90 transition-opacity text-center font-medium"
          >
            Meta Editor
          </Link>
          <Link
            href="/like-explorer"
            className="px-6 py-3 border border-zinc-200 dark:border-zinc-800 rounded-lg hover:bg-zinc-50 dark:hover:bg-zinc-900 transition-colors text-center font-medium"
          >
            Like Explorer (Coming Soon)
          </Link>
        </div>
      </main>
    </div>
  );
}

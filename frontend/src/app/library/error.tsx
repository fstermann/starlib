"use client";

import { useEffect } from "react";

export default function LibraryError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Library error:", error);
  }, [error]);

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-8">
      <h2 className="text-lg font-semibold">Library Error</h2>
      <p className="text-muted-foreground max-w-md text-center text-sm">
        Something went wrong loading the library. Your files are safe.
      </p>
      <button
        onClick={reset}
        className="bg-primary text-primary-foreground hover:bg-primary/90 rounded-md px-4 py-2 text-sm"
      >
        Try again
      </button>
    </div>
  );
}

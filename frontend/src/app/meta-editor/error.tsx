'use client';

import { useEffect } from 'react';

export default function MetaEditorError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Meta editor error:', error);
  }, [error]);

  return (
    <div className="flex flex-col items-center justify-center h-full gap-4 p-8">
      <h2 className="text-lg font-semibold">Meta Editor Error</h2>
      <p className="text-sm text-muted-foreground max-w-md text-center">
        Something went wrong loading the meta editor. Your files are safe.
      </p>
      <button
        onClick={reset}
        className="px-4 py-2 text-sm rounded-md bg-primary text-primary-foreground hover:bg-primary/90"
      >
        Try again
      </button>
    </div>
  );
}

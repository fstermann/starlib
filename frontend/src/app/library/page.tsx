"use client";

import { useQueryState } from "nuqs";
import { Suspense } from "react";

import { FilesystemView } from "./filesystem-view";
import { SoundcloudView } from "./soundcloud-view";
import { DEFAULT_SOURCE, isSourceId } from "./sources";

function LibraryContent() {
  const [sourceParam] = useQueryState("source", {
    defaultValue: DEFAULT_SOURCE,
  });
  const source = isSourceId(sourceParam) ? sourceParam : DEFAULT_SOURCE;

  return source === "soundcloud" ? <SoundcloudView /> : <FilesystemView />;
}

export default function LibraryPage() {
  return (
    <Suspense>
      <LibraryContent />
    </Suspense>
  );
}

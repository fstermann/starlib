"use client";

import { useQueryState } from "nuqs";
import { Suspense } from "react";

import { FilesystemView } from "./filesystem-view";
import { RekordboxView } from "./rekordbox-view";
import { SoundcloudView } from "./soundcloud-view";
import { DEFAULT_SOURCE, isSourceId } from "./sources";

function LibraryContent() {
  const [sourceParam] = useQueryState("source", {
    defaultValue: DEFAULT_SOURCE,
  });
  const source = isSourceId(sourceParam) ? sourceParam : DEFAULT_SOURCE;

  if (source === "soundcloud") return <SoundcloudView />;
  if (source === "rekordbox") return <RekordboxView />;
  return <FilesystemView />;
}

export default function LibraryPage() {
  return (
    <Suspense>
      <LibraryContent />
    </Suspense>
  );
}

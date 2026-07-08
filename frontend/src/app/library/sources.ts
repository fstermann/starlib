export const SOURCE_IDS = ["filesystem", "soundcloud", "rekordbox"] as const;

export type SourceId = (typeof SOURCE_IDS)[number];

export function isSourceId(
  value: string | null | undefined,
): value is SourceId {
  return (
    value === "filesystem" || value === "soundcloud" || value === "rekordbox"
  );
}

export const DEFAULT_SOURCE: SourceId = "filesystem";

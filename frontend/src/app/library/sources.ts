export const SOURCE_IDS = ["filesystem", "soundcloud"] as const;

export type SourceId = (typeof SOURCE_IDS)[number];

export function isSourceId(
  value: string | null | undefined,
): value is SourceId {
  return value === "filesystem" || value === "soundcloud";
}

export const DEFAULT_SOURCE: SourceId = "filesystem";

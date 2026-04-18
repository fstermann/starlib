import { soundCloudSource } from "./soundcloud";
import type { MusicSource } from "./types";

export type { MusicSource, SourceTrack, SourceMetadata } from "./types";
export { soundCloudSource } from "./soundcloud";

export const SOURCES: MusicSource[] = [soundCloudSource];

export function getSource(id: string): MusicSource | undefined {
  return SOURCES.find((s) => s.id === id);
}

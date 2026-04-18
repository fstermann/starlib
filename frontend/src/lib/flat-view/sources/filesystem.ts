import { api } from "@/lib/api";
import type { TreeSource } from "@/lib/flat-view/types";

export const filesystemSource: TreeSource = {
  id: "filesystem",
  label: "Filesystem",
  dedupTracks: false,
  pathColumnLabel: "Folder",
  loadTree: () => api.getFolderTree(),
};

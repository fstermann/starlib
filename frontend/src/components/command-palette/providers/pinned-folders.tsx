"use client";

import { Folder } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { CommandProvider } from "@/components/command-palette/types";
import { api, type FolderConfig } from "@/lib/api";

import { useRegisterProvider } from "../use-register-provider";

function effectivePath(f: FolderConfig, rootFolder: string): string {
  if (f.path) return f.path;
  if (f.name.startsWith("/")) return f.name;
  return rootFolder ? `${rootFolder}/${f.name}` : f.name;
}

/** Sync provider: one command per pinned folder shortcut. */
export function PinnedFoldersProvider({
  onSelect,
}: {
  onSelect: (path: string, folder: FolderConfig) => void;
}) {
  const [folders, setFolders] = useState<FolderConfig[]>([]);
  const [rootFolder, setRootFolder] = useState("");

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.getFoldersConfig(), api.getRootMusicFolder()])
      .then(([cfg, root]) => {
        if (cancelled) return;
        setFolders(cfg.folders.filter((f) => f.visible !== false));
        setRootFolder(root ?? "");
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const provider = useMemo<CommandProvider>(
    () => ({
      id: "pinned-folders",
      order: 25,
      mode: "sync",
      provide: () =>
        folders.map((f) => {
          const absPath = effectivePath(f, rootFolder);
          return {
            id: `folder:${f.path ?? f.name}`,
            label: `Open folder: ${f.label ?? f.name}`,
            description: absPath,
            icon: Folder,
            group: "Folders",
            keywords: [
              "folder",
              "shortcut",
              "pinned",
              f.name ?? "",
              f.label ?? "",
            ],
            run: ({ close }) => {
              onSelect(absPath, f);
              close();
            },
          };
        }),
    }),
    [folders, rootFolder, onSelect],
  );

  useRegisterProvider(provider);
  return null;
}

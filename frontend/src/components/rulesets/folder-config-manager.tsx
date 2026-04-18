"use client";

import { useState, useEffect } from "react";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  arrayMove,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Eye, EyeOff, GripVertical, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { api, type FolderConfig } from "@/lib/api";
import { toast } from "sonner";

// ─── Single row ────────────────────────────────────────────────────────────────

function FolderRow({
  folder,
  onChange,
  onDelete,
}: {
  folder: FolderConfig;
  onChange: (f: FolderConfig) => void;
  onDelete: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: folder.name,
  });
  const style = { transform: CSS.Transform.toString(transform), transition };

  return (
    <TooltipProvider delayDuration={600}>
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "flex items-center gap-2 rounded-md border border-border bg-card px-2.5 py-2",
        isDragging && "opacity-50 shadow-lg"
      )}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            {...attributes}
            {...listeners}
            tabIndex={-1}
            className="shrink-0 cursor-grab text-muted-foreground/25 transition-colors hover:text-muted-foreground/50 active:cursor-grabbing"
          >
            <GripVertical className="size-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top">Drag to reorder</TooltipContent>
      </Tooltip>

      {/* Visibility toggle */}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={() => onChange({ ...folder, visible: !folder.visible })}
            className="cursor-pointer shrink-0 text-muted-foreground/40 transition-colors hover:text-foreground"
          >
            {folder.visible ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
          </button>
        </TooltipTrigger>
        <TooltipContent side="top">
          {folder.visible ? "Hide from meta editor" : "Show in meta editor"}
        </TooltipContent>
      </Tooltip>

      {/* Label input */}
      <Input
        value={folder.label}
        onChange={(e) => onChange({ ...folder, label: e.target.value })}
        className={cn("h-6 flex-1 text-xs", !folder.visible && "opacity-40")}
        placeholder="Label"
      />

      {/* Folder name badge */}
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={cn(
              "w-24 shrink-0 truncate rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground text-right cursor-default",
              !folder.visible && "opacity-40"
            )}
          >
            {folder.name}/
          </span>
        </TooltipTrigger>
        <TooltipContent side="top">Subdirectory name in your music library root</TooltipContent>
      </Tooltip>

      {/* Delete */}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={onDelete}
            className="shrink-0 cursor-pointer text-muted-foreground/20 transition-colors hover:text-destructive"
            aria-label="Remove folder"
          >
            <Trash2 className="size-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top">Remove folder</TooltipContent>
      </Tooltip>
    </div>
    </TooltipProvider>
  );
}

// ─── Add folder form ───────────────────────────────────────────────────────────

function AddFolderRow({ onAdd }: { onAdd: (name: string, label: string) => void }) {
  const [name, setName] = useState("");
  const [label, setLabel] = useState("");

  const isValid = /^[a-zA-Z0-9_-]+$/.test(name);

  function submit() {
    if (!isValid) return;
    onAdd(name, label || name.charAt(0).toUpperCase() + name.slice(1));
    setName("");
    setLabel("");
  }

  return (
    <div className="flex items-center gap-2">
      <Plus className="size-3.5 shrink-0 text-muted-foreground/40" />
      <Input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="folder-name"
        className="h-8 flex-1 font-mono text-xs"
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
        }}
      />
      <Input
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder="Display label (optional)"
        className="h-8 flex-1 text-xs"
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
        }}
      />
      <Button
        size="sm"
        variant="outline"
        className="h-8 cursor-pointer px-3 text-xs"
        disabled={!isValid}
        onClick={submit}
      >
        Add
      </Button>
    </div>
  );
}

// ─── Manager ──────────────────────────────────────────────────────────────────

export function FolderConfigManager() {
  const [folders, setFolders] = useState<FolderConfig[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.getFoldersConfig().then((c) => setFolders(c.folders));
  }, []);

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  async function save(updated: FolderConfig[]) {
    setSaving(true);
    try {
      const result = await api.updateFoldersConfig({ folders: updated });
      setFolders(result.folders);
      window.dispatchEvent(new CustomEvent("folders-config-changed"));
    } catch {
      toast.error("Failed to save folder config");
    } finally {
      setSaving(false);
    }
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIdx = folders.findIndex((f) => f.name === String(active.id));
    const newIdx = folders.findIndex((f) => f.name === String(over.id));
    const reordered = arrayMove(folders, oldIdx, newIdx).map((f, i) => ({ ...f, order: i }));
    save(reordered);
  }

  function handleChange(name: string, updated: FolderConfig) {
    const next = folders.map((f) => (f.name === name ? updated : f));
    save(next);
  }

  function handleDelete(name: string) {
    save(folders.filter((f) => f.name !== name));
  }

  function handleAdd(name: string, label: string) {
    if (folders.some((f) => f.name === name)) {
      toast.error(`Folder "${name}" already exists`);
      return;
    }
    const next = [...folders, { name, label, visible: true, order: folders.length }];
    save(next);
  }

  const ids = folders.map((f) => f.name);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2 px-2.5 text-xs uppercase tracking-wider text-muted-foreground/60">
          <span className="w-3.5 shrink-0" />
          <span className="w-3.5 shrink-0" />
          <span className="flex-1">Label</span>
          <span className="w-24 shrink-0 text-right">Folder</span>
          <span className="w-3.5 shrink-0" />
        </div>

        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={ids} strategy={verticalListSortingStrategy}>
            <div className="flex flex-col gap-1.5">
              {folders.map((folder) => (
                <FolderRow
                  key={folder.name}
                  folder={folder}
                  onChange={(updated) => handleChange(folder.name, updated)}
                  onDelete={() => handleDelete(folder.name)}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>

        {folders.length === 0 && !saving && (
          <p className="py-2 text-center text-xs text-muted-foreground">No folders configured.</p>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <Label className="text-xs text-muted-foreground">Add folder</Label>
        <AddFolderRow onAdd={handleAdd} />
        <p className="text-xs text-muted-foreground/50">
          Folder name must match the subdirectory name in your music library root.
        </p>
      </div>
    </div>
  );
}

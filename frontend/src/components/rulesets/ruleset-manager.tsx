"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { api, type Ruleset } from "@/lib/api";
import { RulesetEditor } from "./ruleset-editor";

export function RulesetManager() {
  const [rulesets, setRulesets] = useState<Ruleset[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [pendingEdit, setPendingEdit] = useState<Ruleset | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api.getRulesets();
      setRulesets(data.rulesets);
      if (!selectedId) setSelectedId(data.active_ruleset_id);
    } catch {
      toast.error("Failed to load rulesets");
    } finally {
      setLoading(false);
    }
  }, [selectedId]);

  useEffect(() => { load(); }, []);

  const selectedRuleset = rulesets.find((r) => r.id === selectedId) ?? null;

  async function handleDelete(id: string) {
    try {
      await api.deleteRuleset(id);
      const updated = rulesets.filter((r) => r.id !== id);
      setRulesets(updated);
      if (selectedId === id) setSelectedId(updated[0]?.id ?? "");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to delete";
      toast.error(msg);
    }
  }

  async function handleCreate() {
    const baseName = "New Ruleset";
    const taken = new Set(rulesets.map((r) => r.name));
    let name = baseName;
    let i = 2;
    while (taken.has(name)) name = `${baseName} ${i++}`;
    try {
      const created = await api.createRuleset({ name, rules: [] });
      setRulesets((prev) => [...prev, created]);
      setSelectedId(created.id);
      setPendingEdit(created);
    } catch {
      toast.error("Failed to create ruleset");
    }
  }

  async function handleSave() {
    if (!pendingEdit) return;
    const duplicate = rulesets.some((r) => r.id !== pendingEdit.id && r.name === pendingEdit.name);
    if (duplicate) {
      toast.error(`A ruleset named "${pendingEdit.name}" already exists`);
      return;
    }
    setSaving(true);
    try {
      const saved = await api.updateRuleset(pendingEdit.id, {
        name: pendingEdit.name,
        rules: pendingEdit.rules,
        required_attributes: pendingEdit.required_attributes,
      });
      setRulesets((prev) => prev.map((r) => (r.id === saved.id ? saved : r)));
      setPendingEdit(null);
      toast.success("Saved");
    } catch {
      toast.error("Failed to save");
    } finally {
      setSaving(false);
    }
  }

  function handleEditorChange(updated: Ruleset) {
    setPendingEdit(updated);
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground text-sm py-4">
        <Loader2 className="size-4 animate-spin" />
        Loading rulesets…
      </div>
    );
  }

  const displayRuleset = pendingEdit?.id === selectedId ? pendingEdit : selectedRuleset;

  return (
    <div className="flex gap-4 min-h-70">
      {/* Sidebar: ruleset list */}
      <div className="w-36 shrink-0 flex flex-col gap-1">
        {rulesets.map((r) => (
          <div key={r.id} className="group relative flex items-center">
            <button
              onClick={() => {
                setSelectedId(r.id);
                setPendingEdit(null);
              }}
              className={cn(
                "flex-1 flex items-center gap-1.5 truncate rounded-md py-1.5 px-2 text-left text-sm transition-colors",
                selectedId === r.id
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-accent"
              )}
            >
              <span className="truncate">{r.name}</span>
            </button>

            {!r.is_builtin && selectedId === r.id && (
              <button
                onClick={() => handleDelete(r.id)}
                className="absolute right-1 hidden group-hover:flex items-center justify-center size-5 rounded text-muted-foreground/50 hover:text-destructive"
                aria-label={`Delete ${r.name}`}
              >
                <Trash2 className="size-3" />
              </button>
            )}
          </div>
        ))}

        <Separator className="my-1" />

        <Button variant="ghost" size="sm" className="justify-start gap-1.5 px-2 text-xs" onClick={handleCreate}>
          <Plus className="size-3" />
          New ruleset
        </Button>
      </div>

      {/* Editor panel */}
      <div className="flex-1 flex flex-col gap-4 min-w-0">
        {displayRuleset ? (
          <RulesetEditor
            key={displayRuleset.id}
            ruleset={displayRuleset}
            onChange={handleEditorChange}
            onSave={handleSave}
            saving={saving}
            hasPendingEdit={!!pendingEdit}
          />
        ) : (
          <p className="text-sm text-muted-foreground">Select a ruleset to view or edit.</p>
        )}
      </div>
    </div>
  );
}

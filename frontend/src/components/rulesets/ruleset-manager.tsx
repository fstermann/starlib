"use client";

import { Loader2, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { api, type Ruleset } from "@/lib/api";
import { dispatchRulesetsChanged } from "@/lib/rulesets-events";
import { cn } from "@/lib/utils";

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

  // Load once on mount. `load` depends on `selectedId`; re-running on every
  // selection change would re-fetch on click.
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedRuleset = rulesets.find((r) => r.id === selectedId) ?? null;

  async function handleDelete(id: string) {
    try {
      await api.deleteRuleset(id);
      const updated = rulesets.filter((r) => r.id !== id);
      setRulesets(updated);
      if (selectedId === id) setSelectedId(updated[0]?.id ?? "");
      dispatchRulesetsChanged();
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
      dispatchRulesetsChanged();
    } catch {
      toast.error("Failed to create ruleset");
    }
  }

  async function handleSave() {
    if (!pendingEdit) return;
    const duplicate = rulesets.some(
      (r) => r.id !== pendingEdit.id && r.name === pendingEdit.name,
    );
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
      dispatchRulesetsChanged();
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
      <div className="text-muted-foreground flex items-center gap-2 py-4 text-sm">
        <Loader2 className="size-4 animate-spin" />
        Loading rulesets…
      </div>
    );
  }

  const displayRuleset =
    pendingEdit?.id === selectedId ? pendingEdit : selectedRuleset;

  return (
    <div className="flex min-h-70 gap-4">
      {/* Sidebar: ruleset list */}
      <div className="flex w-36 shrink-0 flex-col gap-1">
        {rulesets.map((r) => (
          <div key={r.id} className="group relative flex items-center">
            <button
              onClick={() => {
                setSelectedId(r.id);
                setPendingEdit(null);
              }}
              className={cn(
                "flex flex-1 items-center gap-1.5 truncate rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                selectedId === r.id
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-accent",
              )}
            >
              <span className="truncate">{r.name}</span>
            </button>

            {!r.is_builtin && selectedId === r.id && (
              <button
                onClick={() => handleDelete(r.id)}
                className="text-muted-foreground hover:text-destructive absolute right-1 hidden size-5 items-center justify-center rounded group-hover:flex"
                aria-label={`Delete ${r.name}`}
              >
                <Trash2 className="size-3" />
              </button>
            )}
          </div>
        ))}

        <Separator className="my-1" />

        <Button
          variant="ghost"
          size="sm"
          className="justify-start gap-1.5 px-2 text-xs"
          onClick={handleCreate}
        >
          <Plus className="size-3" />
          New ruleset
        </Button>
      </div>

      {/* Editor panel */}
      <div className="flex min-w-0 flex-1 flex-col gap-4">
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
          <p className="text-muted-foreground text-sm">
            Select a ruleset to view or edit.
          </p>
        )}
      </div>
    </div>
  );
}

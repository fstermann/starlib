"use client";

import { Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { UserSearch } from "@/components/user-search";
import { api } from "@/lib/api";
import {
  profileGroupsApi,
  type ProfileGroup,
  type ProfileGroupMember,
} from "@/lib/profile-groups";
import type { SCUser } from "@/lib/soundcloud";

export const MAX_MEMBERS = 10;

interface Props {
  /** Group being edited. Pass `{ id: "", name: "", members: [...] }` for a
   * new (or transient) group; the dialog calls `create` on save. */
  group: { id: string; name: string; members: ProfileGroupMember[] };
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the persisted group after a successful save. */
  onSaved?: (group: ProfileGroup) => void;
  /** Called after a successful delete. Hidden in the UI when omitted. */
  onDeleted?: () => void;
}

function userToMember(user: SCUser): ProfileGroupMember {
  if (!user) return { user_urn: "", permalink: "", username: "" };
  return {
    user_urn: user.urn ?? "",
    permalink: user.permalink ?? "",
    username: user.username ?? "",
    avatar_url: user.avatar_url ?? null,
  };
}

export function ProfileGroupDialog({
  group,
  open,
  onOpenChange,
  onSaved,
  onDeleted,
}: Props) {
  const [name, setName] = useState(group.name);
  const [members, setMembers] = useState<ProfileGroupMember[]>(group.members);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset form whenever the dialog re-opens with a different group.
  useEffect(() => {
    if (open) {
      setName(group.name);
      setMembers(group.members);
      setError(null);
    }
  }, [open, group.id, group.name, group.members]);

  const isNew = !group.id;
  const canAddMore = members.length < MAX_MEMBERS;

  function addMember(user: SCUser) {
    const m = userToMember(user);
    if (!m.user_urn) return;
    if (members.some((x) => x.user_urn === m.user_urn)) {
      toast.info(`${m.username} is already in this group`);
      return;
    }
    if (members.length >= MAX_MEMBERS) {
      toast.warning(`A group can have at most ${MAX_MEMBERS} members`);
      return;
    }
    setMembers([...members, m]);
  }

  function removeMember(urn: string) {
    setMembers(members.filter((m) => m.user_urn !== urn));
  }

  async function handleSave() {
    if (!name.trim() || members.length === 0) return;
    setSaving(true);
    setError(null);
    try {
      const saved = isNew
        ? await profileGroupsApi.create({ name: name.trim(), members })
        : await profileGroupsApi.update(group.id, {
            name: name.trim(),
            members,
          });
      toast.success(isNew ? `Group "${saved.name}" created` : `Group saved`);
      onSaved?.(saved);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save group");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!group.id) return;
    if (!confirm(`Delete group "${group.name}"?`)) return;
    setSaving(true);
    try {
      await profileGroupsApi.delete(group.id);
      toast.success(`Group "${group.name}" deleted`);
      onDeleted?.();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete group");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg" data-testid="profile-group-dialog">
        <DialogHeader>
          <DialogTitle>
            {isNew ? "New profile group" : "Manage group"}
          </DialogTitle>
          <DialogDescription>
            Aggregate likes from up to {MAX_MEMBERS} SoundCloud profiles.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="group-name">Name</Label>
            <Input
              id="group-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="DJs I follow"
              data-testid="profile-group-name-input"
            />
          </div>

          <div className="space-y-2">
            <Label>
              Members ({members.length}/{MAX_MEMBERS})
            </Label>
            {members.length === 0 ? (
              <p className="text-muted-foreground text-xs">
                Add at least one profile below.
              </p>
            ) : (
              <ul className="space-y-1.5">
                {members.map((m) => {
                  const avatarUrl = m.avatar_url
                    ? api.proxyImageUrl(m.avatar_url)
                    : null;
                  return (
                    <li
                      key={m.user_urn}
                      className="border-border flex items-center gap-2 rounded-md border px-2 py-1.5"
                      data-testid="profile-group-member-row"
                    >
                      <div className="bg-muted flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-full">
                        {avatarUrl ? (
                          <img
                            src={avatarUrl}
                            alt=""
                            className="size-7 object-cover"
                          />
                        ) : (
                          <span className="text-muted-foreground text-xs font-medium">
                            {(m.username ?? "?")[0]?.toUpperCase()}
                          </span>
                        )}
                      </div>
                      <span className="truncate text-sm">{m.username}</span>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        className="ml-auto"
                        onClick={() => removeMember(m.user_urn)}
                        title={`Remove ${m.username}`}
                        aria-label={`Remove ${m.username}`}
                      >
                        <X className="size-3.5" />
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {canAddMore && (
            <div className="space-y-1.5">
              <Label>Add a profile</Label>
              <UserSearch onSelect={addMember} />
            </div>
          )}

          {error && (
            <p className="text-destructive text-xs" role="alert">
              {error}
            </p>
          )}
        </div>

        <DialogFooter className="sm:justify-between">
          {!isNew && onDeleted ? (
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive"
              onClick={handleDelete}
              disabled={saving}
              data-testid="profile-group-delete"
            >
              <Trash2 className="mr-1 size-3.5" />
              Delete
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => onOpenChange(false)}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={handleSave}
              disabled={saving || !name.trim() || members.length === 0}
              data-testid="profile-group-save"
            >
              {isNew ? "Create" : "Save"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

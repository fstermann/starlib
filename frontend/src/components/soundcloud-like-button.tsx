"use client";

import { Heart } from "lucide-react";
import { useState } from "react";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { likeTrack, unlikeTrack } from "@/lib/soundcloud";
import { cn } from "@/lib/utils";

interface Props {
  trackUrn: string;
  initialLiked: boolean;
  onChange?: (liked: boolean) => void;
}

export function SoundcloudLikeButton({
  trackUrn,
  initialLiked,
  onChange,
}: Props) {
  const [liked, setLiked] = useState(initialLiked);
  const [pending, setPending] = useState(false);

  async function toggle(e: React.MouseEvent) {
    e.stopPropagation();
    if (pending) return;
    const next = !liked;
    setLiked(next);
    setPending(true);
    try {
      if (next) await likeTrack(trackUrn);
      else await unlikeTrack(trackUrn);
      onChange?.(next);
    } catch (err) {
      console.error("SoundCloud like toggle failed", err);
      setLiked(!next);
    } finally {
      setPending(false);
    }
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={toggle}
          disabled={pending}
          aria-pressed={liked}
          aria-label={liked ? "Unlike track" : "Like track"}
          data-testid="soundcloud-like-button"
          data-liked={liked ? "true" : "false"}
          className={cn(
            "flex size-5 items-center justify-center transition-colors",
            liked
              ? "text-[#f50] hover:text-[#ff7a33]"
              : "text-muted-foreground hover:text-foreground",
            pending && "opacity-60",
          )}
        >
          <Heart
            className={cn("size-3", liked && "fill-current")}
            strokeWidth={liked ? 0 : 2}
          />
        </button>
      </TooltipTrigger>
      <TooltipContent>{liked ? "Unlike" : "Like"}</TooltipContent>
    </Tooltip>
  );
}

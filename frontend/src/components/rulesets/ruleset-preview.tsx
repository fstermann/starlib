import {
  RULE_ICON_COLORS,
  RULE_ICONS,
  StepBadge,
} from "@/components/rulesets/rule-card";
import type { RequiredAttribute, Ruleset } from "@/lib/api";

const REQUIRED_ATTR_LABEL: Record<RequiredAttribute, string> = {
  title: "Title",
  artist: "Artist",
  genre: "Genre",
  bpm: "BPM",
  key: "Key",
  release_date: "Release date",
  remixer: "Remixer",
  comment: "Comment",
  artwork: "Artwork",
};

interface RulesetPreviewProps {
  ruleset: Ruleset;
  /** When provided and non-empty, renders a "Missing required" warning block. */
  missingRequired?: RequiredAttribute[];
}

export function RulesetPreview({
  ruleset,
  missingRequired,
}: RulesetPreviewProps) {
  const hasMissing = !!missingRequired && missingRequired.length > 0;
  return (
    <>
      <div className="border-border border-b px-3 py-2">
        <p className="text-xs font-medium">{ruleset.name}</p>
      </div>
      {hasMissing && (
        <div className="border-border bg-warning/10 border-b px-3 py-2">
          <p className="text-warning mb-1 text-xs font-semibold">
            Missing required
          </p>
          <p className="text-foreground text-xs">
            {missingRequired!.map((a) => REQUIRED_ATTR_LABEL[a]).join(", ")}
          </p>
        </div>
      )}
      <div className="flex flex-col gap-0.5 px-1.5 py-1.5">
        {ruleset.rules.map((rule, i) => {
          const Icon = RULE_ICONS[rule.type];
          const folderParam = rule.params.folder as string | undefined;
          const formatParam = rule.params.format as string | undefined;
          const detail =
            rule.type === "convert"
              ? formatParam
                ? formatParam.toUpperCase()
                : "preferred"
              : folderParam
                ? `${folderParam}/`
                : "";
          const isConditional = rule.requires.length > 0;
          return (
            <div
              key={i}
              className={`flex items-center gap-2 rounded px-1.5 py-1 text-xs ${
                isConditional ? "border-info/30 ml-4 border-l-2 pl-2.5" : ""
              }`}
            >
              <StepBadge step={i + 1} type={rule.type} />
              <Icon
                className={`size-3.5 shrink-0 ${RULE_ICON_COLORS[rule.type]}`}
              />
              <span className="capitalize">{rule.type}</span>
              {detail && (
                <span className="font-mono text-xs opacity-70">{detail}</span>
              )}
              {isConditional && (
                <span className="bg-info/20 text-info rounded px-1 text-xs font-medium">
                  if converted
                </span>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

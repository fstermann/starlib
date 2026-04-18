import type { RequiredAttribute, Ruleset } from '@/lib/api';
import { StepBadge, RULE_ICONS, RULE_ICON_COLORS } from '@/components/rulesets/rule-card';

const REQUIRED_ATTR_LABEL: Record<RequiredAttribute, string> = {
  title: 'Title',
  artist: 'Artist',
  genre: 'Genre',
  bpm: 'BPM',
  key: 'Key',
  release_date: 'Release date',
  remixer: 'Remixer',
  comment: 'Comment',
  artwork: 'Artwork',
};

interface RulesetPreviewProps {
  ruleset: Ruleset;
  /** When provided and non-empty, renders a "Missing required" warning block. */
  missingRequired?: RequiredAttribute[];
}

export function RulesetPreview({ ruleset, missingRequired }: RulesetPreviewProps) {
  const hasMissing = !!missingRequired && missingRequired.length > 0;
  return (
    <>
      <div className="px-3 py-2 border-b border-border">
        <p className="text-xs font-medium">{ruleset.name}</p>
      </div>
      {hasMissing && (
        <div className="px-3 py-2 border-b border-border bg-amber-500/10">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-amber-500 mb-1">
            Missing required
          </p>
          <p className="text-xs text-foreground/90">
            {missingRequired!.map((a) => REQUIRED_ATTR_LABEL[a]).join(', ')}
          </p>
        </div>
      )}
      <div className="py-1.5 flex flex-col gap-0.5 px-1.5">
        {ruleset.rules.map((rule, i) => {
          const Icon = RULE_ICONS[rule.type];
          const folderParam = rule.params.folder as string | undefined;
          const formatParam = rule.params.format as string | undefined;
          const detail = rule.type === 'convert'
            ? formatParam ? formatParam.toUpperCase() : 'preferred'
            : folderParam ? `${folderParam}/` : '';
          const isConditional = rule.requires.length > 0;
          return (
            <div
              key={i}
              className={`flex items-center gap-2 rounded px-1.5 py-1 text-xs ${
                isConditional ? 'ml-4 border-l-2 border-blue-400/30 pl-2.5' : ''
              }`}
            >
              <StepBadge step={i + 1} type={rule.type} />
              <Icon className={`size-3.5 shrink-0 ${RULE_ICON_COLORS[rule.type]}`} />
              <span className="capitalize">{rule.type}</span>
              {detail && <span className="font-mono text-[10px] opacity-70">{detail}</span>}
              {isConditional && (
                <span className="text-[9px] rounded bg-blue-400/20 text-blue-300 px-1 font-medium">
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

import { cn } from '@/lib/utils';

interface PageHeaderProps {
  title: string;
  /** Controls rendered to the right of the title (tabs, toggles, etc.) */
  controls?: React.ReactNode;
  /** Actions rendered on the far right of the header row */
  actions?: React.ReactNode;
  /** Optional content below the title row, still within the header region (filter bars, contextual controls) */
  children?: React.ReactNode;
  className?: string;
}

/**
 * Shared page-level header used by Meta Editor, Like Explorer, and similar full-height pages.
 *
 * Layout:
 *   ┌─────────────────────────────────────────────┐
 *   │ [Title] | [controls]          [actions]     │  ← h-11, px-4
 *   ├─────────────────────────────────────────────┤
 *   │ [children]                                  │  ← optional sub-header
 *   └─ border-b ───────────────────────────────────┘
 */
export function PageHeader({ title, controls, actions, children, className }: PageHeaderProps) {
  return (
    <div className={cn('shrink-0', className)}>
      <div className="flex items-center justify-between px-4 h-14 border-b border-border/50">
        <div className="flex items-center gap-3 min-w-0">
          <h1 className="text-sm font-semibold tracking-tight shrink-0">{title}</h1>
          {controls && (
            <>
              <div className="w-px h-5 bg-border/50 shrink-0" />
              {controls}
            </>
          )}
        </div>
        {actions && (
          <div className="flex items-center gap-2 shrink-0">
            {actions}
          </div>
        )}
      </div>
      {children}
    </div>
  );
}

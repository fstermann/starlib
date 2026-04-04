'use client';

import { useState, useRef } from 'react';
import { Search, X, ChevronDown, SlidersHorizontal, FolderCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Slider } from '@/components/ui/slider';
import { Checkbox } from '@/components/ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from '@/components/ui/dropdown-menu';

interface LikesFilterBarProps {
  search: string;
  onSearchChange: (value: string) => void;
  genres: string[];
  onGenresChange: (genres: string[]) => void;
  availableGenres: string[];
  minDuration: number | null;
  maxDuration: number | null;
  onMinDurationChange: (value: number | null) => void;
  onMaxDurationChange: (value: number | null) => void;
  excludeMyLikes: boolean;
  onExcludeMyLikesChange: (value: boolean) => void;
  showExcludeMyLikes: boolean;
  excludeMyLikesLabel?: string;
  trackType?: 'track' | 'set' | null;
  onTrackTypeChange?: (value: 'track' | 'set' | null) => void;
  excludeOwnLikes?: boolean;
  onExcludeOwnLikesChange?: (value: boolean) => void;
  showExcludeOwnLikes?: boolean;
  inCollection: boolean | null;
  onInCollectionChange: (value: boolean | null) => void;
  showInCollection: boolean;
  filteredCount: number;
  totalCount: number;
  loading: boolean;
  selectedCount?: number;
  actions?: React.ReactNode;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

const DURATION_MAX = 1800; // 30 minutes

export function LikesFilterBar({
  search,
  onSearchChange,
  genres,
  onGenresChange,
  availableGenres,
  minDuration,
  maxDuration,
  onMinDurationChange,
  onMaxDurationChange,
  excludeMyLikes,
  onExcludeMyLikesChange,
  showExcludeMyLikes,
  excludeMyLikesLabel = 'Exclude my likes',
  trackType = null,
  onTrackTypeChange,
  excludeOwnLikes = false,
  onExcludeOwnLikesChange,
  showExcludeOwnLikes = false,
  inCollection,
  onInCollectionChange,
  showInCollection,
  filteredCount,
  totalCount,
  loading,
  selectedCount = 0,
  actions,
}: LikesFilterBarProps) {
  const [searchInput, setSearchInput] = useState(search);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [durationValue, setDurationValue] = useState<[number, number]>([
    minDuration ?? 0,
    maxDuration ?? DURATION_MAX,
  ]);

  function handleSearchChange(value: string) {
    setSearchInput(value);
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(() => {
      onSearchChange(value);
    }, 300);
  }

  function toggleGenre(genre: string) {
    onGenresChange(
      genres.includes(genre) ? genres.filter((g) => g !== genre) : [...genres, genre],
    );
  }

  function handleDurationEnd(value: number[]) {
    onMinDurationChange(value[0] === 0 ? null : value[0]);
    onMaxDurationChange(value[1] === DURATION_MAX ? null : value[1]);
  }

  function cycleInCollection() {
    // null -> true -> false -> null
    if (inCollection === null) onInCollectionChange(true);
    else if (inCollection === true) onInCollectionChange(false);
    else onInCollectionChange(null);
  }

  const durationActive = minDuration !== null || maxDuration !== null;

  function cycleTrackType() {
    if (trackType === null) onTrackTypeChange?.('track');
    else if (trackType === 'track') onTrackTypeChange?.('set');
    else onTrackTypeChange?.(null);
  }

  const hasActiveFilters =
    search.length > 0 ||
    genres.length > 0 ||
    durationActive ||
    trackType !== null ||
    excludeMyLikes ||
    excludeOwnLikes ||
    inCollection !== null;

  function clearAll() {
    setSearchInput('');
    onSearchChange('');
    onGenresChange([]);
    onMinDurationChange(null);
    onMaxDurationChange(null);
    setDurationValue([0, DURATION_MAX]);
    onTrackTypeChange?.(null);
    onExcludeMyLikesChange(false);
    onExcludeOwnLikesChange?.(false);
    onInCollectionChange(null);
  }

  return (
    <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-border/50 bg-background/80 backdrop-blur-sm">
      {/* Search */}
      <div className="relative flex-1 min-w-40 max-w-64">
        <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
        <Input
          value={searchInput}
          onChange={(e) => handleSearchChange(e.target.value)}
          placeholder="Search title, artist…"
          className="h-7 pl-7 text-xs"
        />
        {search && (
          <button
            onClick={() => { setSearchInput(''); onSearchChange(''); }}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          >
            <X className="size-3" />
          </button>
        )}
      </div>

      {/* Genre filter */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className={`h-7 text-xs gap-1 ${genres.length ? 'border-primary text-primary' : ''}`}>
            Genre
            {genres.length > 0 && (
              <Badge variant="default" className="h-4 px-1 text-[10px] rounded-full ml-0.5">
                {genres.length}
              </Badge>
            )}
            <ChevronDown className="size-3 opacity-50" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-40 p-0">
          <div className="px-1 pt-1">
            <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Genre
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
          </div>
          <div className="max-h-56 overflow-y-auto px-1 pb-1">
            {availableGenres.map((g) => (
              <DropdownMenuCheckboxItem
                key={g}
                checked={genres.includes(g)}
                onCheckedChange={() => toggleGenre(g)}
                onSelect={(e) => e.preventDefault()}
                className="text-xs"
              >
                {g}
              </DropdownMenuCheckboxItem>
            ))}
            {availableGenres.length === 0 && (
              <div className="px-2 py-1 text-xs text-muted-foreground">No genres</div>
            )}
          </div>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Duration filter */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className={`h-7 text-xs gap-1 ${durationActive ? 'border-primary text-primary' : ''}`}
          >
            <SlidersHorizontal className="size-3" />
            Duration
            {durationActive && (
              <span className="text-[10px] ml-0.5">
                {formatDuration(minDuration ?? 0)}–{formatDuration(maxDuration ?? DURATION_MAX)}
              </span>
            )}
            <ChevronDown className="size-3 opacity-50" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56 p-3">
          <div className="flex justify-between text-[10px] text-muted-foreground mb-2">
            <span>{formatDuration(durationValue[0])}</span>
            <span>{formatDuration(durationValue[1])}</span>
          </div>
          <Slider
            min={0}
            max={DURATION_MAX}
            step={30}
            value={durationValue}
            onValueChange={(v) => setDurationValue([v[0], v[1]])}
            onValueCommit={handleDurationEnd}
            className="mt-1"
          />
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Track / Set filter */}
      <Button
        variant="outline"
        size="sm"
        className={`h-7 text-xs gap-1 cursor-pointer ${trackType !== null ? 'border-primary text-primary' : ''}`}
        onClick={cycleTrackType}
        title="Filter by track type: Track (<12 min) or Set (≥12 min)"
      >
        {trackType === 'track' ? 'Track' : trackType === 'set' ? 'Set' : 'Track / Set'}
      </Button>

      {/* In Collection filter */}
      {showInCollection && (
        <Button
          variant="outline"
          size="sm"
          className={`h-7 text-xs gap-1 cursor-pointer ${inCollection !== null ? 'border-primary text-primary' : ''}`}
          onClick={cycleInCollection}
          title={inCollection === null ? 'All tracks' : inCollection ? 'In collection' : 'Not in collection'}
        >
          <FolderCheck className="size-3" />
          {inCollection === null ? 'Collection' : inCollection ? 'In collection' : 'Not in collection'}
        </Button>
      )}

      {/* Exclude my likes */}
      {showExcludeMyLikes && (
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none">
          <Checkbox
            checked={excludeMyLikes}
            onCheckedChange={(v) => onExcludeMyLikesChange(v === true)}
            className="size-3.5"
          />
          {excludeMyLikesLabel}
        </label>
      )}

      {/* Exclude own liked tracks */}
      {showExcludeOwnLikes && (
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none">
          <Checkbox
            checked={excludeOwnLikes}
            onCheckedChange={(v) => onExcludeOwnLikesChange?.(v === true)}
            className="size-3.5"
          />
          Exclude my liked tracks
        </label>
      )}

      {/* Active genre chips */}
      {genres.map((g) => (
        <Badge key={g} variant="secondary" className="h-6 text-[10px] gap-1 cursor-pointer" onClick={() => toggleGenre(g)}>
          {g} <X className="size-2.5" />
        </Badge>
      ))}

      {/* Clear all */}
      {hasActiveFilters && (
        <Button variant="ghost" size="sm" className="h-7 text-xs text-muted-foreground" onClick={clearAll}>
          Clear all
        </Button>
      )}

      {/* Track count */}
      <div className="ml-auto text-[10px] text-muted-foreground tabular-nums">
        {selectedCount > 0
          ? `${selectedCount.toLocaleString()} / ${filteredCount.toLocaleString()} selected`
          : filteredCount === totalCount
            ? `${totalCount.toLocaleString()} track${totalCount !== 1 ? 's' : ''}`
            : `${filteredCount.toLocaleString()} of ${totalCount.toLocaleString()}`}
        {loading && ' (loading…)'}
      </div>

      {/* Slot for page-level actions (e.g. Create Playlist) */}
      {actions}
    </div>
  );
}

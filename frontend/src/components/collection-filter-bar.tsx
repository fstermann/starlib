'use client';

import { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Search, X, ChevronDown, SlidersHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Slider } from '@/components/ui/slider';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from '@/components/ui/dropdown-menu';
import { useQueryState } from 'nuqs';
import { searchParams } from '@/lib/search-params';
import { api, type FilterValues } from '@/lib/api';

interface CollectionFilterBarProps {
  mode: string;
}

export function CollectionFilterBar({ mode }: CollectionFilterBarProps) {
  const [filterValues, setFilterValues] = useState<FilterValues | null>(null);
  const [bpmRange, setBpmRange] = useState<[number, number] | null>(null);
  const [bpmValue, setBpmValue] = useState<[number, number] | null>(null);
  const [search, setSearch] = useQueryState('search', searchParams.search);
  const [searchInput, setSearchInput] = useState(search);
  const [genres, setGenres] = useQueryState('genres', searchParams.genres);
  const [keys, setKeys] = useQueryState('keys', searchParams.keys);
  const [bpmMin, setBpmMin] = useQueryState('bpmMin', searchParams.bpmMin);
  const [bpmMax, setBpmMax] = useQueryState('bpmMax', searchParams.bpmMax);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const filterFetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevModeRef = useRef<string>(mode);
  const genreScrollRef = useRef<HTMLDivElement>(null);
  const keyScrollRef = useRef<HTMLDivElement>(null);
  const savedGenreScroll = useRef<number>(0);
  const savedKeyScroll = useRef<number>(0);
  const restoreGenreScroll = useRef(false);
  const restoreKeyScroll = useRef(false);

  useLayoutEffect(() => {
    if (restoreGenreScroll.current && genreScrollRef.current) {
      genreScrollRef.current.scrollTop = savedGenreScroll.current;
      restoreGenreScroll.current = false;
    }
    if (restoreKeyScroll.current && keyScrollRef.current) {
      keyScrollRef.current.scrollTop = savedKeyScroll.current;
      restoreKeyScroll.current = false;
    }
  });

  // Reset state and clear URL filter params when mode changes
  useEffect(() => {
    if (prevModeRef.current !== mode) {
      prevModeRef.current = mode;
      setBpmRange(null);
      setBpmValue(null);
      setFilterValues(null);
      setSearchInput('');
      setSearch('');
      setGenres([]);
      setKeys([]);
      setBpmMin(null);
      setBpmMax(null);
    }
  }, [mode, setSearch, setGenres, setKeys, setBpmMin, setBpmMax]);

  // Re-fetch filter values whenever mode or any active filter changes.
  // Debounced so rapid filter changes don't cause double layout animations.
  useEffect(() => {
    const doFetch = () => {
      api.getFilterValues(mode, {
        search: search || undefined,
        genres: genres.length ? genres : undefined,
        keys: keys.length ? keys : undefined,
        bpmMin: bpmMin ?? undefined,
        bpmMax: bpmMax ?? undefined,
      }).then((vals) => {
        setFilterValues(vals);
        if (vals.bpm_min !== undefined && vals.bpm_max !== undefined) {
          const range: [number, number] = [vals.bpm_min, vals.bpm_max];
          setBpmRange((prev) => prev ?? range);
          setBpmValue((prev) => prev ?? [bpmMin ?? range[0], bpmMax ?? range[1]]);
        }
      }).catch(() => {});
    };

    if (filterFetchTimerRef.current) clearTimeout(filterFetchTimerRef.current);
    filterFetchTimerRef.current = setTimeout(doFetch, 250);
    return () => {
      if (filterFetchTimerRef.current) clearTimeout(filterFetchTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, search, genres, keys, bpmMin, bpmMax]);

  function handleSearchChange(value: string) {
    setSearchInput(value);
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(() => {
      setSearch(value);
    }, 300);
  }

  function toggleGenre(genre: string) {
    savedGenreScroll.current = genreScrollRef.current?.scrollTop ?? 0;
    restoreGenreScroll.current = true;
    setGenres(genres.includes(genre) ? genres.filter((g) => g !== genre) : [...genres, genre]);
  }

  function toggleKey(key: string) {
    savedKeyScroll.current = keyScrollRef.current?.scrollTop ?? 0;
    restoreKeyScroll.current = true;
    setKeys(keys.includes(key) ? keys.filter((k) => k !== key) : [...keys, key]);
  }

  function handleBpmEnd(value: number[]) {
    setBpmMin(value[0]);
    setBpmMax(value[1]);
  }

  function clearAll() {
    setSearchInput('');
    setSearch('');
    setGenres([]);
    setKeys([]);
    setBpmMin(null);
    setBpmMax(null);
    if (bpmRange) setBpmValue(bpmRange);
  }

  const hasActiveFilters =
    search.length > 0 ||
    genres.length > 0 ||
    keys.length > 0 ||
    bpmMin !== null ||
    bpmMax !== null;

  const bpmActive = bpmMin !== null || bpmMax !== null;

  return (
    <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-border/50 bg-background/80 backdrop-blur-sm">
      {/* Search */}
      <div className="relative flex-1 min-w-40 max-w-64">
        <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
        <Input
          value={searchInput}
          onChange={(e) => handleSearchChange(e.target.value)}
          placeholder="Search title, artist, genre…"
          className="h-7 pl-7 text-xs"
        />
        {search && (
          <button
            onClick={() => { setSearchInput(''); setSearch(''); }}
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
          <motion.div ref={genreScrollRef} layoutScroll className="max-h-56 overflow-y-auto px-1 pb-1">
          <AnimatePresence initial={false}>
          {filterValues && [...filterValues.genres]
            .sort((a, b) => {
              const aSelected = genres.includes(a);
              const bSelected = genres.includes(b);
              if (aSelected !== bSelected) return aSelected ? -1 : 1;
              const aCount = filterValues.genre_counts?.[a] ?? 0;
              const bCount = filterValues.genre_counts?.[b] ?? 0;
              return bCount - aCount || a.localeCompare(b);
            })
            .map((g) => {
              const count = filterValues.genre_counts?.[g] ?? 0;
              const isSelected = genres.includes(g);
              const isDisabled = !isSelected && count === 0;
              return (
                <motion.div key={g} layout transition={{ duration: 0.2, ease: 'easeOut' }}>
                <DropdownMenuCheckboxItem
                  checked={isSelected}
                  onCheckedChange={() => toggleGenre(g)}
                  onSelect={(e) => e.preventDefault()}
                  disabled={isDisabled}
                  className="text-xs"
                >
                  {g}
                  {filterValues.genre_counts?.[g] !== undefined && (
                    <span className="ml-1.5 text-muted-foreground/60">
                      ({count})
                    </span>
                  )}
                </DropdownMenuCheckboxItem>
                </motion.div>
              );
            })}
          </AnimatePresence>
          </motion.div>
          {!filterValues && <div className="px-2 py-1 text-xs text-muted-foreground">Loading…</div>}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Key filter */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className={`h-7 text-xs gap-1 ${keys.length ? 'border-primary text-primary' : ''}`}>
            Key
            {keys.length > 0 && (
              <Badge variant="default" className="h-4 px-1 text-[10px] rounded-full ml-0.5">
                {keys.length}
              </Badge>
            )}
            <ChevronDown className="size-3 opacity-50" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-32 p-0">
          <div className="px-1 pt-1">
            <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Key
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
          </div>
          <motion.div ref={keyScrollRef} layoutScroll className="max-h-56 overflow-y-auto px-1 pb-1">
          <AnimatePresence initial={false}>
          {filterValues && [...filterValues.keys]
            .sort((a, b) => {
              const aSelected = keys.includes(a);
              const bSelected = keys.includes(b);
              if (aSelected !== bSelected) return aSelected ? -1 : 1;
              const camelotRank = (k: string) => {
                const m = k.match(/^(\d{1,2})(A|B)$/);
                if (!m) return Infinity;
                return parseInt(m[1], 10) * 2 + (m[2] === 'A' ? 0 : 1);
              };
              return camelotRank(a) - camelotRank(b) || a.localeCompare(b);
            })
            .map((k) => {
              const count = filterValues.key_counts?.[k] ?? 0;
              const isSelected = keys.includes(k);
              const isDisabled = !isSelected && count === 0;
              return (
                <motion.div key={k} layout transition={{ duration: 0.2, ease: 'easeOut' }}>
                <DropdownMenuCheckboxItem
                  checked={isSelected}
                  onCheckedChange={() => toggleKey(k)}
                  onSelect={(e) => e.preventDefault()}
                  disabled={isDisabled}
                  className="text-xs"
                >
                  {k}
                  {filterValues.key_counts?.[k] !== undefined && (
                    <span className="ml-1.5 text-muted-foreground/60">
                      ({count})
                    </span>
                  )}
                </DropdownMenuCheckboxItem>
                </motion.div>
              );
            })}
          </AnimatePresence>
          </motion.div>
          {!filterValues && <div className="px-2 py-1 text-xs text-muted-foreground">Loading…</div>}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* BPM range filter */}
      {bpmRange && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className={`h-7 text-xs gap-1 ${bpmActive ? 'border-primary text-primary' : ''}`}
            >
              <SlidersHorizontal className="size-3" />
              BPM
              {bpmActive && (
                <span className="text-[10px] ml-0.5">
                  {bpmMin ?? bpmRange?.[0]}–{bpmMax ?? bpmRange?.[1]}
                </span>
              )}
              <ChevronDown className="size-3 opacity-50" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56 p-3">
            <div className="flex justify-between text-[10px] text-muted-foreground mb-2">
              <span>{bpmValue?.[0] ?? bpmRange[0]} BPM</span>
              <span>{bpmValue?.[1] ?? bpmRange[1]} BPM</span>
            </div>
            <Slider
              min={bpmRange[0]}
              max={bpmRange[1]}
              step={1}
              value={bpmValue ?? bpmRange}
              onValueChange={(v) => setBpmValue([v[0], v[1]])}
              onValueCommit={handleBpmEnd}
              className="mt-1"
            />
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {/* Active filter chips */}
      {genres.map((g) => (
        <Badge key={g} variant="secondary" className="h-6 text-[10px] gap-1 cursor-pointer" onClick={() => toggleGenre(g)}>
          {g} <X className="size-2.5" />
        </Badge>
      ))}
      {keys.map((k) => (
        <Badge key={k} variant="secondary" className="h-6 text-[10px] gap-1 cursor-pointer" onClick={() => toggleKey(k)}>
          {k} <X className="size-2.5" />
        </Badge>
      ))}

      {/* Clear all */}
      {hasActiveFilters && (
        <Button variant="ghost" size="sm" className="h-7 text-xs text-muted-foreground" onClick={clearAll}>
          Clear all
        </Button>
      )}
    </div>
  );
}

import { useMemo } from 'react';
import type { SCTrack } from '@/lib/soundcloud';

export type GroupingMode = 'weekly' | 'biweekly';

export interface WeekGroup {
  key: string;
  label: string;
  /** Short title for the SoundCloud playlist, e.g. "Weekly Favorites Mar/4" */
  playlistTitle: string;
  start: Date;
  end: Date;
  tracks: SCTrack[];
  isCurrent: boolean;
}

/**
 * Returns the Sunday (start-of-day, UTC midnight) at or before the given date.
 * Sunday = 0, Monday = 1, ... Saturday = 6.
 */
function getPrevSunday(date: Date): Date {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay(); // 0 = Sunday
  d.setUTCDate(d.getUTCDate() - day);
  return d;
}

function getNextSunday(date: Date): Date {
  const prev = getPrevSunday(date);
  const next = new Date(prev);
  next.setUTCDate(prev.getUTCDate() + 7);
  return next;
}

function getWeekOfMonth(date: Date): number {
  // Week of month: week containing the 1st is week 1
  const firstDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  const firstDayOfWeek = firstDay.getUTCDay(); // 0=Sun
  return Math.ceil((date.getUTCDate() + firstDayOfWeek) / 7);
}

function getMonthAbbrev(date: Date): string {
  return date.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
}

function formatDateShort(date: Date): string {
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function getIsoWeek(date: Date): number {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
}

function buildPlaylistTitle(end: Date, groupingMode: GroupingMode, half?: 1 | 2): string {
  const labelDate = new Date(end);
  labelDate.setUTCDate(labelDate.getUTCDate() - 1);
  const month = getMonthAbbrev(labelDate);
  const week = getWeekOfMonth(labelDate);
  const halfSuffix = groupingMode === 'biweekly' ? `/${half}` : '';
  return `Weekly Favorites ${month}/${week}${halfSuffix}`;
}

function buildLabel(start: Date, end: Date, groupingMode: GroupingMode, half?: 1 | 2): string {
  // end is exclusive (next Sunday), label against the Sunday that ends this week
  const labelDate = new Date(end);
  labelDate.setUTCDate(labelDate.getUTCDate() - 1); // Saturday = last day
  const month = getMonthAbbrev(labelDate);
  const week = getWeekOfMonth(labelDate);
  const cw = getIsoWeek(labelDate);
  const halfSuffix = groupingMode === 'biweekly' ? `/${half}` : '';
  return `Weekly Favorites ${month}/${week}${halfSuffix} — ${formatDateShort(start)} – ${formatDateShort(new Date(end.getTime() - 86400000))} · CW ${cw}`;
}

function buildKey(start: Date, end: Date, half?: 1 | 2): string {
  return `${start.toISOString()}_${end.toISOString()}${half ? `_${half}` : ''}`;
}

export function useWeeklyGroups(
  tracks: SCTrack[],
  mode: GroupingMode,
): WeekGroup[] {
  return useMemo(() => {
    if (tracks.length === 0) return [];

    const now = new Date();
    const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);

    // Determine period boundaries: from two-weeks-ago-Sunday to next Sunday
    const periodStart = getPrevSunday(twoWeeksAgo);
    const currentWeekStart = getPrevSunday(now);
    const currentWeekEnd = getNextSunday(now);

    // Build weekly buckets covering the period
    interface Bucket {
      start: Date;
      end: Date;
      half?: 1 | 2;
      weekStart: Date;
      weekEnd: Date;
    }

    const buckets: Bucket[] = [];
    let cursor = new Date(periodStart);

    while (cursor < currentWeekEnd) {
      const weekStart = new Date(cursor);
      const weekEnd = getNextSunday(cursor);

      if (mode === 'biweekly') {
        const midMs = weekStart.getTime() + (weekEnd.getTime() - weekStart.getTime()) / 2;
        const mid = new Date(midMs);
        buckets.push({ start: weekStart, end: mid, half: 1, weekStart, weekEnd });
        buckets.push({ start: mid, end: weekEnd, half: 2, weekStart, weekEnd });
      } else {
        buckets.push({ start: weekStart, end: weekEnd, weekStart, weekEnd });
      }

      cursor = new Date(weekEnd);
    }

    // Assign tracks to buckets
    const bucketTracks = new Map<string, SCTrack[]>();
    for (const bucket of buckets) {
      bucketTracks.set(buildKey(bucket.start, bucket.end, bucket.half), []);
    }

    for (const track of tracks) {
      if (!track.created_at) continue;
      const created = new Date(track.created_at);
      for (const bucket of buckets) {
        if (created >= bucket.start && created < bucket.end) {
          bucketTracks.get(buildKey(bucket.start, bucket.end, bucket.half))!.push(track);
          break;
        }
      }
    }

    // Build result — most recent first, skip empty buckets
    return buckets
      .reverse()
      .filter((b) => (bucketTracks.get(buildKey(b.start, b.end, b.half))?.length ?? 0) > 0)
      .map((b) => {
        const key = buildKey(b.start, b.end, b.half);
        const isCurrent = b.weekStart >= currentWeekStart && b.weekStart < currentWeekEnd;
        return {
          key,
          label: buildLabel(b.start, b.end, mode, b.half),
          playlistTitle: buildPlaylistTitle(b.end, mode, b.half),
          start: b.start,
          end: b.end,
          tracks: bucketTracks.get(key) ?? [],
          isCurrent,
        };
      });
  }, [tracks, mode]);
}

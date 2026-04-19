"use client";

import {
  parseAsArrayOf,
  parseAsInteger,
  parseAsString,
  useQueryStates,
  type ParserBuilder,
} from "nuqs";
import * as React from "react";

import {
  emptyStateFor,
  type FilterAttribute,
  type FilterSchemaResponse,
  type FilterState,
  type FilterValue,
} from "@/lib/filters/schema";

interface QueryShape {
  [key: string]: string | string[] | number | null;
}

/**
 * Schema-driven URL state. Each attribute maps to nuqs params per its kind:
 *   enum  → `{id}` (array of string)
 *   range → `{id}Min` + `{id}Max` (integer)
 *   bool  → `{id}` (string "true" | "false"; null when unset)
 *   text  → `{id}` (string)
 *
 * Parsers are rebuilt only when the attribute set or kinds change.
 */
export function useFilterState(schema: FilterSchemaResponse): {
  state: FilterState;
  set: (id: string, value: FilterValue) => void;
  clearAll: () => void;
} {
  const parsers = React.useMemo(
    () => buildParsers(schema),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- signature-keyed memo
    [schema.attributes.map((a) => `${a.id}:${a.kind}`).join("|")],
  );

  const [query, setQuery] = useQueryStates(parsers);

  const state = React.useMemo<FilterState>(() => {
    const q = query as QueryShape;
    const out: FilterState = {};
    for (const attr of schema.attributes) {
      out[attr.id] = readValue(attr, q);
    }
    return out;
  }, [schema, query]);

  const set = React.useCallback(
    (id: string, value: FilterValue) => {
      const attr = schema.attributes.find((a) => a.id === id);
      if (!attr) return;
      setQuery(writePatch(attr, value) as Parameters<typeof setQuery>[0]);
    },
    [schema, setQuery],
  );

  const clearAll = React.useCallback(() => {
    const empty = emptyStateFor(schema);
    const patch: QueryShape = {};
    for (const attr of schema.attributes) {
      Object.assign(patch, writePatch(attr, empty[attr.id]));
    }
    setQuery(patch as Parameters<typeof setQuery>[0]);
  }, [schema, setQuery]);

  return { state, set, clearAll };
}

type AnyParser = ParserBuilder<unknown>;

function buildParsers(schema: FilterSchemaResponse): Record<string, AnyParser> {
  const parsers: Record<string, AnyParser> = {};
  for (const attr of schema.attributes) {
    for (const [k, v] of Object.entries(parserFor(attr))) {
      parsers[k] = v;
    }
  }
  return parsers;
}

function parserFor(attr: FilterAttribute): Record<string, AnyParser> {
  switch (attr.kind) {
    case "enum":
      return {
        [attr.id]: parseAsArrayOf(parseAsString).withDefault(
          [],
        ) as unknown as AnyParser,
      };
    case "range":
      return {
        [`${attr.id}Min`]: parseAsInteger as unknown as AnyParser,
        [`${attr.id}Max`]: parseAsInteger as unknown as AnyParser,
      };
    case "bool":
      return { [attr.id]: parseAsString as unknown as AnyParser };
    case "text":
      return {
        [attr.id]: parseAsString.withDefault("") as unknown as AnyParser,
      };
  }
}

function readValue(attr: FilterAttribute, query: QueryShape): FilterValue {
  switch (attr.kind) {
    case "enum":
      return (query[attr.id] as string[] | undefined) ?? [];
    case "range": {
      const lo = query[`${attr.id}Min`] as number | null | undefined;
      const hi = query[`${attr.id}Max`] as number | null | undefined;
      return [lo ?? null, hi ?? null];
    }
    case "bool": {
      const v = query[attr.id] as string | null | undefined;
      if (v === "true") return true;
      if (v === "false") return false;
      return null;
    }
    case "text":
      return (query[attr.id] as string | undefined) ?? "";
  }
}

function writePatch(attr: FilterAttribute, value: FilterValue): QueryShape {
  switch (attr.kind) {
    case "enum": {
      const arr = value as string[];
      return { [attr.id]: arr.length ? arr : null };
    }
    case "range": {
      const [lo, hi] = value as [number | null, number | null];
      return {
        [`${attr.id}Min`]: lo,
        [`${attr.id}Max`]: hi,
      };
    }
    case "bool": {
      const v = value as boolean | null;
      return { [attr.id]: v === null ? null : String(v) };
    }
    case "text": {
      const v = value as string;
      return { [attr.id]: v.length ? v : null };
    }
  }
}

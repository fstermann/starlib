import { describe, expect, it } from "vitest";

import { keyFromSoundcloud } from "./camelot";

describe("keyFromSoundcloud", () => {
  it.each([
    ["A:min", "Am", "8A"],
    ["Ab:min", "Abm", "1A"],
    ["G:min", "Gm", "6A"],
    ["Db:min", "Dbm", "12A"],
    ["C:maj", "C", "8B"],
    ["Db:maj", "Db", "3B"],
    ["B:maj", "B", "1B"],
  ])("%s → %s / %s", (sig, name, camelot) => {
    expect(keyFromSoundcloud(sig)).toEqual({ name, camelot });
  });

  it("rejects unknown formats", () => {
    expect(keyFromSoundcloud("")).toBeNull();
    expect(keyFromSoundcloud("8A")).toBeNull();
    expect(keyFromSoundcloud(null)).toBeNull();
  });
});

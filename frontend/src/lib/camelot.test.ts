import { describe, expect, it } from "vitest";

import {
  keyFromSoundcloud,
  keyNameFromCamelot,
  soundcloudKeyRank,
} from "./camelot";

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

describe("keyNameFromCamelot", () => {
  it("inverts keyFromSoundcloud for every key", () => {
    for (const note of [
      "C",
      "Db",
      "D",
      "Eb",
      "E",
      "F",
      "Gb",
      "G",
      "Ab",
      "A",
      "Bb",
      "B",
    ]) {
      for (const mode of ["maj", "min"]) {
        const key = keyFromSoundcloud(`${note}:${mode}`)!;
        expect(keyNameFromCamelot(key.camelot)).toBe(key.name);
      }
    }
  });

  it("rejects unknown formats", () => {
    expect(keyNameFromCamelot("13A")).toBeNull();
    expect(keyNameFromCamelot("Am")).toBeNull();
  });
});

describe("soundcloudKeyRank", () => {
  it("orders by wheel position, minor before major, unknown last", () => {
    const sigs = ["C:maj", "junk", "A:min", "Ab:min", "B:maj"];
    expect(
      [...sigs].sort((a, b) => soundcloudKeyRank(a) - soundcloudKeyRank(b)),
    ).toEqual(["Ab:min", "B:maj", "A:min", "C:maj", "junk"]);
  });
});

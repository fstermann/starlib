import { describe, expect, it } from "vitest";

import { levelMatchGainsDb } from "./level-match";

describe("levelMatchGainsDb", () => {
  it("turns louder sets down to the quietest", () => {
    expect(levelMatchGainsDb([-9.2, -7.3, -12])).toEqual([
      -12 - -9.2,
      -12 - -7.3,
      0,
    ]);
  });

  it("leaves unmeasured sets alone", () => {
    expect(levelMatchGainsDb([-8, null, -10])).toEqual([-2, 0, 0]);
    expect(levelMatchGainsDb([null, null])).toEqual([0, 0]);
  });
});

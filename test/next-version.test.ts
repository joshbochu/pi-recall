import { describe, expect, it } from "vitest";
import { bumpPatch, chooseNextVersion, compareSemver, parseSemver } from "../scripts/next-version.mjs";

describe("next-version", () => {
  it("parses and compares semver", () => {
    expect(parseSemver("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(compareSemver("0.3.0", "0.3.1")).toBe(-1);
    expect(compareSemver("0.4.0", "0.3.9")).toBe(1);
    expect(bumpPatch("0.3.0")).toBe("0.3.1");
  });

  it("bumps when local is already published", () => {
    expect(chooseNextVersion("0.3.0", "0.3.0")).toBe("0.3.1");
    expect(chooseNextVersion("0.3.0", "0.3.5")).toBe("0.3.6");
  });

  it("keeps an unpublished local ahead of npm", () => {
    expect(chooseNextVersion("0.4.0", "0.3.0")).toBe("0.4.0");
    expect(chooseNextVersion("0.3.0", null)).toBe("0.3.0");
  });
});

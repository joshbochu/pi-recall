import { describe, expect, it } from "vitest";
import { HELP_SUBCOMMANDS, RECALL_HELP } from "../src/help.js";

describe("recall help", () => {
  it("documents install, picker, tags, and the help entrypoints", () => {
    expect(RECALL_HELP).toContain("pi install npm:@joshbochu/pi-recall");
    expect(RECALL_HELP).toContain("/recall help");
    expect(RECALL_HELP).toContain("/recall-reindex");
    expect(RECALL_HELP).toContain("/recall tag");
    expect(RECALL_HELP).toContain("/recall autotag");
    expect(RECALL_HELP).toContain("Tab");
    expect(RECALL_HELP).toContain("prefix matching");
  });

  it("treats common help aliases as help subcommands", () => {
    for (const value of ["help", "?", "manual", "--help", "-h"]) {
      expect(HELP_SUBCOMMANDS.has(value)).toBe(true);
    }
    expect(HELP_SUBCOMMANDS.has("search")).toBe(false);
    expect(HELP_SUBCOMMANDS.has("tag")).toBe(false);
  });
});

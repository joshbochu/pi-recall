import { describe, expect, it } from "vitest";
import {
  bundledPrebuiltPath,
  nativeTarget,
  openNativeEngine,
  prebuiltPackageName,
} from "../src/native-binding.js";

describe("nativeTarget", () => {
  it("names the prebuilt package for each published platform", () => {
    expect(nativeTarget("darwin", "arm64")).toBe("darwin-arm64");
    expect(nativeTarget("darwin", "x64")).toBe("darwin-x64");
    expect(nativeTarget("linux", "x64", "glibc")).toBe("linux-x64-gnu");
    expect(nativeTarget("linux", "arm64", "glibc")).toBe("linux-arm64-gnu");
    expect(nativeTarget("linux", "x64", "musl")).toBe("linux-x64-musl");
    expect(nativeTarget("win32", "x64")).toBe("win32-x64-msvc");
    expect(prebuiltPackageName("darwin-arm64")).toBe("@joshbochu/pi-recall-native-darwin-arm64");
    expect(bundledPrebuiltPath("darwin-arm64")).toMatch(
      /native[/\\]prebuilds[/\\]darwin-arm64[/\\]pi-recall-native\.node$/u,
    );
  });
});

describe("openNativeEngine", () => {
  it("loads the addon this checkout built", () => {
    const engine = openNativeEngine("node_modules/.cache/pi-recall-binding-test");
    expect(engine.documentCount()).toBeGreaterThanOrEqual(0);
  });
});

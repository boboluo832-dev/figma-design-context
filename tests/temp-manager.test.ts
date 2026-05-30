import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { TempManager, isFigmaDebugEnabled } from "../src/temp-manager.js";

describe("isFigmaDebugEnabled", () => {
  it("should enable debug for truthy flag values", () => {
    expect(isFigmaDebugEnabled("1")).toBe(true);
    expect(isFigmaDebugEnabled("true")).toBe(true);
    expect(isFigmaDebugEnabled("YES")).toBe(true);
    expect(isFigmaDebugEnabled("on")).toBe(true);
  });

  it("should disable debug for empty or non-truthy values", () => {
    expect(isFigmaDebugEnabled(undefined)).toBe(false);
    expect(isFigmaDebugEnabled("")).toBe(false);
    expect(isFigmaDebugEnabled("0")).toBe(false);
    expect(isFigmaDebugEnabled("false")).toBe(false);
  });
});

describe("TempManager", () => {
  let tempManager: TempManager;
  let testRoot: string;

  beforeEach(() => {
    testRoot = path.join(os.tmpdir(), `figma-test-${Date.now()}`);
    fs.mkdirSync(testRoot, { recursive: true });
    tempManager = new TempManager(testRoot, true);
    tempManager.init();
  });

  afterEach(() => {
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  it("should create directory structure on init", () => {
    expect(fs.existsSync(tempManager.logsDir)).toBe(true);
    expect(fs.existsSync(tempManager.svgDir)).toBe(true);
    expect(fs.existsSync(tempManager.rawDir)).toBe(true);
    expect(fs.existsSync(tempManager.optimizedDir)).toBe(true);
    expect(fs.existsSync(tempManager.condensedDir)).toBe(true);
    expect(fs.existsSync(tempManager.condensedV2Dir)).toBe(true);
    expect(fs.existsSync(tempManager.condensedV3Dir)).toBe(true);
    expect(fs.existsSync(tempManager.iconsDir)).toBe(true);
  });

  it("should clean previous temp dir on init", () => {
    const testFile = path.join(tempManager.svgDir, "old.svg");
    fs.writeFileSync(testFile, "<svg></svg>");
    tempManager.init();
    expect(fs.existsSync(testFile)).toBe(false);
  });

  it("should write SVG files", () => {
    const filePath = tempManager.writeSvg("test.svg", "<svg>hello</svg>");
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.readFileSync(filePath, "utf-8")).toBe("<svg>hello</svg>");
  });

  it("should write raw JSON files", () => {
    const filePath = tempManager.writeRaw("fileKey1", "1:2", { test: true });
    expect(fs.existsSync(filePath)).toBe(true);
    const content = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(content.test).toBe(true);
  });

  it("should write optimized JSON files", () => {
    const filePath = tempManager.writeOptimized("fileKey1", "3:4", { optimized: true });
    expect(fs.existsSync(filePath)).toBe(true);
    const content = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(content.optimized).toBe(true);
  });

  it("should recreate directories before writing node artifacts", () => {
    fs.rmSync(tempManager.tempDir, { recursive: true, force: true });

    const rawPath = tempManager.writeRaw("fileKey1", "1:2", { test: true });
    const optimizedPath = tempManager.writeOptimized("fileKey1", "3:4", { optimized: true });
    const condensedPath = tempManager.writeCondensed("fileKey1", "5:6", "A compressed tree");
    const condensedV2Path = tempManager.writeCondensedV2("fileKey1", "5:6", "@format condensed-v2");
    const condensedV3Path = tempManager.writeCondensedV3("fileKey1", "5:6", "@format condensed-v3");

    expect(fs.existsSync(rawPath)).toBe(true);
    expect(fs.existsSync(optimizedPath)).toBe(true);
    expect(fs.existsSync(condensedPath)).toBe(true);
    expect(fs.existsSync(condensedV2Path)).toBe(true);
    expect(fs.existsSync(condensedV3Path)).toBe(true);
  });

  it("should write condensed text files", () => {
    const filePath = tempManager.writeCondensed("fileKey1", "5:6", "A compressed tree");
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.readFileSync(filePath, "utf-8")).toBe("A compressed tree");
  });

  it("should write condensed-v2 text files separately", () => {
    const filePath = tempManager.writeCondensedV2("fileKey1", "5:6", "@format condensed-v2");
    expect(fs.existsSync(filePath)).toBe(true);
    expect(filePath).toContain("condensed-v2");
    expect(fs.readFileSync(filePath, "utf-8")).toBe("@format condensed-v2");
  });

  it("should write condensed-v3 text files separately", () => {
    const filePath = tempManager.writeCondensedV3("fileKey1", "5:6", "@format condensed-v3");
    expect(fs.existsSync(filePath)).toBe(true);
    expect(filePath).toContain("condensed-v3");
    expect(fs.readFileSync(filePath, "utf-8")).toBe("@format condensed-v3");
  });

  it("should still write node artifacts when debug mode is disabled", () => {
    const manager = new TempManager(testRoot, false);
    manager.init();

    const rawPath = manager.writeRaw("fileKey1", "1:2", { test: true });
    const optimizedPath = manager.writeOptimized("fileKey1", "3:4", { optimized: true });
    const condensedPath = manager.writeCondensed("fileKey1", "5:6", "text");
    const condensedV2Path = manager.writeCondensedV2("fileKey1", "5:6", "@format condensed-v2");
    const condensedV3Path = manager.writeCondensedV3("fileKey1", "5:6", "@format condensed-v3");
    const logPath = manager.writeLog("tool", "raw", { response: true });

    expect(rawPath).not.toBeNull();
    expect(optimizedPath).not.toBeNull();
    expect(condensedPath).not.toBeNull();
    expect(condensedV2Path).not.toBeNull();
    expect(condensedV3Path).not.toBeNull();
    expect(fs.existsSync(rawPath!)).toBe(true);
    expect(fs.existsSync(optimizedPath!)).toBe(true);
    expect(fs.existsSync(condensedPath!)).toBe(true);
    expect(fs.existsSync(condensedV2Path!)).toBe(true);
    expect(fs.existsSync(condensedV3Path!)).toBe(true);
    expect(logPath).toBeNull();
    expect(fs.readdirSync(manager.logsDir)).toHaveLength(0);
  });

  it("should still write SVG files and icon index when debug mode is disabled", () => {
    const manager = new TempManager(testRoot, false);
    manager.init();

    const svgPath = manager.writeSvg("icon.svg", "<svg />");
    manager.addIcon({
      fileKey: "fk1",
      nodeId: "1:1",
      name: "icon",
      svgPath,
      source: "test",
    });

    expect(fs.existsSync(svgPath)).toBe(true);
    expect(manager.getIconsIndex().icons).toHaveLength(1);
  });

  it("should add and retrieve icons", () => {
    tempManager.addIcon({
      fileKey: "fk1",
      nodeId: "1:1",
      name: "icon-home",
      svgPath: "/tmp/icon.svg",
      source: "test",
    });

    const index = tempManager.getIconsIndex();
    expect(index.icons).toHaveLength(1);
    expect(index.icons[0].name).toBe("icon-home");
  });

  it("should update existing icon entry", () => {
    tempManager.addIcon({
      fileKey: "fk1",
      nodeId: "1:1",
      name: "icon-v1",
      svgPath: "/tmp/v1.svg",
      source: "test",
    });
    tempManager.addIcon({
      fileKey: "fk1",
      nodeId: "1:1",
      name: "icon-v2",
      svgPath: "/tmp/v2.svg",
      source: "test",
    });

    const index = tempManager.getIconsIndex();
    expect(index.icons).toHaveLength(1);
    expect(index.icons[0].name).toBe("icon-v2");
  });

  it("should batch add icons", () => {
    tempManager.addIcons([
      { fileKey: "fk1", nodeId: "1:1", name: "a", svgPath: null, source: "test" },
      { fileKey: "fk1", nodeId: "1:2", name: "b", svgPath: null, source: "test" },
    ]);

    const index = tempManager.getIconsIndex();
    expect(index.icons).toHaveLength(2);
  });

  it("should recreate icon index before reading or writing icons", () => {
    fs.rmSync(tempManager.tempDir, { recursive: true, force: true });

    expect(tempManager.getIconsIndex().icons).toHaveLength(0);

    tempManager.addIcon({
      fileKey: "fk1",
      nodeId: "1:1",
      name: "icon-home",
      svgPath: null,
      source: "test",
    });

    expect(fs.existsSync(tempManager.iconsIndexPath)).toBe(true);
    expect(tempManager.getIconsIndex().icons).toHaveLength(1);
  });

  it("should return correct directory paths", () => {
    expect(tempManager.tempDir).toContain(".figma-temp");
    expect(tempManager.logsDir).toContain("logs");
    expect(tempManager.svgDir).toContain("svg");
    expect(tempManager.rawDir).toContain("raw");
    expect(tempManager.optimizedDir).toContain("optimized");
    expect(tempManager.condensedDir).toContain("condensed");
    expect(tempManager.condensedV2Dir).toContain("condensed-v2");
    expect(tempManager.condensedV3Dir).toContain("condensed-v3");
    expect(tempManager.iconsDir).toContain("icons");
  });

  it("should default temp directory under the runtime module root", () => {
    const moduleRoot = path.join(testRoot, "dist");
    const manager = new TempManager(moduleRoot, false);

    expect(manager.tempDir).toBe(path.join(moduleRoot, ".figma-temp"));
  });

  it("should use explicit temp directory override", () => {
    const customTempDir = path.join(testRoot, "shared-temp");
    const manager = new TempManager(testRoot, false, customTempDir);
    manager.ensure();

    const rawPath = manager.writeRaw("fileKey1", "1:2", { test: true });

    expect(manager.tempDir).toBe(customTempDir);
    expect(rawPath).toContain(customTempDir);
    expect(fs.existsSync(rawPath)).toBe(true);
  });
});

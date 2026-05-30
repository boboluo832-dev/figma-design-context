import { describe, it, expect } from "vitest";
import { SvgExporter, FigmaNode } from "../src/svg-exporter.js";
import { FigmaClient } from "../src/figma-client.js";
import { TempManager } from "../src/temp-manager.js";

describe("SvgExporter", () => {
  const mockClient = {} as FigmaClient;
  const mockTempManager = {} as TempManager;

  describe("detectExportableNodes", () => {
    it("should return empty array for null node", () => {
      const exporter = new SvgExporter(mockClient, mockTempManager);
      expect(exporter.detectExportableNodes(null as any)).toEqual([]);
    });

    it("should not auto-detect loose vector nodes by default", () => {
      const exporter = new SvgExporter(mockClient, mockTempManager);
      const node: FigmaNode = {
        id: "1:1",
        name: "arrow",
        type: "VECTOR",
        absoluteBoundingBox: { x: 0, y: 0, width: 24, height: 24 },
      };
      const result = exporter.detectExportableNodes(node);
      expect(result).toHaveLength(0);
    });

    it("should detect vector nodes when explicitly enabled", () => {
      const exporter = new SvgExporter(mockClient, mockTempManager);
      const node: FigmaNode = {
        id: "1:1",
        name: "arrow",
        type: "VECTOR",
        absoluteBoundingBox: { x: 0, y: 0, width: 24, height: 24 },
      };
      const result = exporter.detectExportableNodes(node, 0, { includeVectorNodes: true });
      expect(result).toHaveLength(1);
      expect(result[0].role).toBe("vector");
    });

    it("should detect icon nodes by name", () => {
      const exporter = new SvgExporter(mockClient, mockTempManager);
      const node: FigmaNode = {
        id: "1:2",
        name: "icon-search",
        type: "FRAME",
        absoluteBoundingBox: { x: 0, y: 0, width: 24, height: 24 },
      };
      const result = exporter.detectExportableNodes(node);
      expect(result).toHaveLength(1);
      expect(result[0].role).toBe("icon");
    });

    it("should detect nodes whose name starts with icon without a separator", () => {
      const exporter = new SvgExporter(mockClient, mockTempManager);
      const node: FigmaNode = {
        id: "1:2",
        name: "iconSearch",
        type: "FRAME",
        absoluteBoundingBox: { x: 0, y: 0, width: 24, height: 24 },
      };
      const result = exporter.detectExportableNodes(node);
      expect(result).toEqual([{ id: "1:2", name: "iconSearch", role: "icon" }]);
    });

    it("should detect Element Plus style icon names", () => {
      const exporter = new SvgExporter(mockClient, mockTempManager);
      const node: FigmaNode = {
        id: "1:2",
        name: "左导航图标/工作台",
        type: "INSTANCE",
        componentId: "component-workbench",
        absoluteBoundingBox: { x: 0, y: 0, width: 24, height: 24 },
        children: [{ id: "1:3", name: "Vector", type: "VECTOR" }],
      };
      const result = exporter.detectExportableNodes(node);
      expect(result).toEqual([{ id: "1:2", name: "左导航图标/工作台", role: "icon" }]);
    });

    it("should detect export-marked nodes", () => {
      const exporter = new SvgExporter(mockClient, mockTempManager);
      const node: FigmaNode = {
        id: "1:3",
        name: "logo",
        type: "FRAME",
        exportSettings: [{ format: "SVG" }],
      };
      const result = exporter.detectExportableNodes(node);
      expect(result).toHaveLength(1);
      expect(result[0].role).toBe("export-marked");
    });

    it("should skip instance internal nodes (ID with semicolon)", () => {
      const exporter = new SvgExporter(mockClient, mockTempManager);
      const node: FigmaNode = {
        id: "1:1;2:2",
        name: "icon-internal",
        type: "VECTOR",
      };
      const result = exporter.detectExportableNodes(node);
      expect(result).toHaveLength(0);
    });

    it("should detect semicolon instance icon containers using componentId as export id", () => {
      const exporter = new SvgExporter(mockClient, mockTempManager);
      const node: FigmaNode = {
        id: "1:1;2:2",
        name: "Basics/setting",
        type: "INSTANCE",
        componentId: "900:100",
        absoluteBoundingBox: { x: 0, y: 0, width: 24, height: 24 },
        children: [{ id: "1:1;2:3", name: "Vector", type: "VECTOR" }],
      };

      const result = exporter.detectExportableNodes(node);
      expect(result).toEqual([
        { id: "1:1;2:2", name: "Basics/setting", role: "icon", exportId: "900:100" },
      ]);
    });

    it("should recurse into children", () => {
      const exporter = new SvgExporter(mockClient, mockTempManager);
      const node: FigmaNode = {
        id: "1:1",
        name: "container",
        type: "FRAME",
        children: [
          { id: "2:1", name: "icon-home", type: "FRAME", absoluteBoundingBox: { x: 0, y: 0, width: 24, height: 24 } },
          { id: "2:2", name: "arrow", type: "VECTOR", absoluteBoundingBox: { x: 0, y: 0, width: 24, height: 24 } },
        ],
      };
      const result = exporter.detectExportableNodes(node);
      expect(result).toHaveLength(1);
    });

    it("should treat Icons frames as collections and export child icon containers", () => {
      const exporter = new SvgExporter(mockClient, mockTempManager);
      const node: FigmaNode = {
        id: "1:1",
        name: "Icons / 24",
        type: "FRAME",
        absoluteBoundingBox: { x: 0, y: 0, width: 400, height: 80 },
        children: [
          {
            id: "2:1",
            name: "home",
            type: "COMPONENT",
            absoluteBoundingBox: { x: 0, y: 0, width: 24, height: 24 },
            children: [{ id: "3:1", name: "Vector", type: "VECTOR" }],
          },
          {
            id: "2:2",
            name: "settings",
            type: "FRAME",
            absoluteBoundingBox: { x: 32, y: 0, width: 24, height: 24 },
            children: [{ id: "3:2", name: "Vector", type: "VECTOR" }],
          },
        ],
      };

      const result = exporter.detectExportableNodes(node);
      expect(result).toEqual([
        { id: "2:1", name: "home", role: "icon" },
        { id: "2:2", name: "settings", role: "icon" },
      ]);
    });

    it("should detect common-size icon instances and ignore visual guide children", () => {
      const exporter = new SvgExporter(mockClient, mockTempManager);
      const node: FigmaNode = {
        id: "1:1",
        name: "screen",
        type: "FRAME",
        children: [
          {
            id: "2:1",
            name: "Module/CPU",
            type: "INSTANCE",
            componentId: "component-cpu",
            absoluteBoundingBox: { x: 0, y: 0, width: 24, height: 24 },
            children: [
              {
                id: "3:1",
                name: "视觉基准参考",
                type: "FRAME",
                absoluteBoundingBox: { x: 0, y: 0, width: 24, height: 24 },
                children: [{ id: "4:1", name: "Ellipse 1", type: "ELLIPSE", absoluteBoundingBox: { x: 2, y: 2, width: 20, height: 20 } }],
              },
              { id: "3:2", name: "Vector", type: "VECTOR", absoluteBoundingBox: { x: 2, y: 2, width: 20, height: 20 } },
            ],
          },
        ],
      };

      const result = exporter.detectExportableNodes(node);
      expect(result).toEqual([
        { id: "2:1", name: "Module/CPU", role: "icon" },
      ]);
    });

    it("should dedupe repeated component instances by default", () => {
      const exporter = new SvgExporter(mockClient, mockTempManager);
      const node: FigmaNode = {
        id: "1:1",
        name: "screen",
        type: "FRAME",
        children: [
          {
            id: "2:1",
            name: "Basics/settings",
            type: "INSTANCE",
            componentId: "component-settings",
            absoluteBoundingBox: { x: 0, y: 0, width: 24, height: 24 },
            children: [{ id: "3:1", name: "Vector", type: "VECTOR" }],
          },
          {
            id: "2:2",
            name: "Basics/settings",
            type: "INSTANCE",
            componentId: "component-settings",
            absoluteBoundingBox: { x: 32, y: 0, width: 24, height: 24 },
            children: [{ id: "3:2", name: "Vector", type: "VECTOR" }],
          },
        ],
      };

      const result = exporter.detectExportableNodes(node);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("2:1");
    });

    it("should limit results to MAX_EXPORT_NODES (20)", () => {
      const exporter = new SvgExporter(mockClient, mockTempManager);
      const children: FigmaNode[] = Array.from({ length: 30 }, (_, i) => ({
        id: `${i}:1`,
        name: `icon-${i}`,
        type: "FRAME",
        absoluteBoundingBox: { x: i * 32, y: 0, width: 24, height: 24 },
      }));
      const node: FigmaNode = {
        id: "0:1",
        name: "container",
        type: "FRAME",
        children,
      };
      const result = exporter.detectExportableNodes(node);
      expect(result).toHaveLength(20);
    });
  });

  describe("formatExportResults", () => {
    it("should return empty string for empty results", () => {
      const exporter = new SvgExporter(mockClient, mockTempManager);
      expect(exporter.formatExportResults(new Map())).toBe("");
    });

    it("should format inline SVG results", () => {
      const exporter = new SvgExporter(mockClient, mockTempManager);
      const results = new Map([
        ["1:1", { path: "/tmp/icon.svg", content: "<svg></svg>", filename: "icon.svg", inline: true }],
      ]);
      const output = exporter.formatExportResults(results);
      expect(output).toContain("# Exported SVGs");
      expect(output).toContain("icon.svg");
      expect(output).toContain("<svg></svg>");
    });

    it("should note large SVGs as not inline", () => {
      const exporter = new SvgExporter(mockClient, mockTempManager);
      const results = new Map([
        ["1:1", { path: "/tmp/big.svg", content: "x".repeat(20000), filename: "big.svg", inline: false }],
      ]);
      const output = exporter.formatExportResults(results);
      expect(output).toContain("too large to inline");
    });
  });
});

import { describe, it, expect } from "vitest";
import {
  inferSemanticRole,
  simplifyNode,
  buildComponentMap,
  generateSummary,
  toCondensedFormat,
  toCondensedWithBudget,
  toCondensedV2Format,
  toCondensedV2WithBudget,
  toCondensedV3Format,
  toSemanticJson,
  buildSemanticVariableDefinitions,
  colorToString,
  gradientToCSS,
  parseEffects,
  effectsToCSS,
  fillsToCSS,
  buildVariableMap,
  buildVariableMapFromNodes,
  estimateTokens,
  FigmaNode,
} from "../src/transformer.js";

describe("inferSemanticRole", () => {
  it("should return null for null input", () => {
    expect(inferSemanticRole(null as any)).toBeNull();
  });

  it("should detect HEADER from name", () => {
    const node = { id: "1", name: "header", type: "FRAME" } as FigmaNode;
    expect(inferSemanticRole(node)).toEqual({ role: "HEADER", html: "header" });
  });

  it("should detect BUTTON from name", () => {
    const node = { id: "1", name: "btn-submit", type: "FRAME" } as FigmaNode;
    expect(inferSemanticRole(node)).toEqual({ role: "BUTTON", html: "button" });
  });

  it("should detect NAV from name", () => {
    const node = { id: "1", name: "navbar", type: "FRAME" } as FigmaNode;
    expect(inferSemanticRole(node)).toEqual({ role: "HEADER", html: "header" });
  });

  it("should detect TEXT type", () => {
    const node = { id: "1", name: "label", type: "TEXT" } as FigmaNode;
    expect(inferSemanticRole(node)).toEqual({ role: "TEXT", html: "span" });
  });

  it("should detect IMAGE from fills", () => {
    const node = { id: "1", name: "photo-bg", type: "FRAME", fills: [{ type: "IMAGE", visible: true }] } as any;
    expect(inferSemanticRole(node)).toEqual({ role: "IMG", html: "img" });
  });

  it("should detect COMPONENT type", () => {
    const node = { id: "1", name: "MyWidget", type: "COMPONENT" } as FigmaNode;
    expect(inferSemanticRole(node)).toEqual({ role: "COMPONENT", html: "div" });
  });

  it("should detect CARD from name", () => {
    const node = { id: "1", name: "card-item", type: "FRAME" } as FigmaNode;
    expect(inferSemanticRole(node)).toEqual({ role: "CARD", html: "article" });
  });

  it("should detect ICON from name", () => {
    const node = { id: "1", name: "icon-search", type: "FRAME" } as FigmaNode;
    expect(inferSemanticRole(node)).toEqual({ role: "ICON", html: "svg" });
  });

  it("should detect ICON from any icon prefix", () => {
    const node = { id: "1", name: "iconSearch", type: "FRAME" } as FigmaNode;
    expect(inferSemanticRole(node)).toEqual({ role: "ICON", html: "svg" });
  });
});

// PLACEHOLDER_TEST_1

describe("colorToString", () => {
  it("should convert solid color to hex", () => {
    expect(colorToString({ r: 1, g: 0, b: 0 })).toBe("#ff0000");
  });

  it("should convert color with alpha to rgba", () => {
    expect(colorToString({ r: 1, g: 0, b: 0 }, 0.5)).toBe("rgba(255, 0, 0, 0.5)");
  });

  it("should return null for undefined color", () => {
    expect(colorToString(undefined)).toBeNull();
  });

  it("should handle white color", () => {
    expect(colorToString({ r: 1, g: 1, b: 1 })).toBe("#ffffff");
  });

  it("should handle black color", () => {
    expect(colorToString({ r: 0, g: 0, b: 0 })).toBe("#000000");
  });

  it("should use color.a when opacity not provided", () => {
    expect(colorToString({ r: 1, g: 0, b: 0, a: 0.3 })).toBe("rgba(255, 0, 0, 0.3)");
  });
});

describe("simplifyNode", () => {
  it("should return null for null input", () => {
    expect(simplifyNode(null as any)).toBeNull();
  });

  it("should return null for hidden nodes", () => {
    const node = { id: "1", name: "hidden", type: "FRAME", visible: false } as FigmaNode;
    expect(simplifyNode(node)).toBeNull();
  });

  it("should simplify a basic frame", () => {
    const node: FigmaNode = {
      id: "1:1",
      name: "Container",
      type: "FRAME",
      absoluteBoundingBox: { x: 0, y: 0, width: 400, height: 300 },
    };
    const result = simplifyNode(node);
    expect(result).not.toBeNull();
    expect(result!.id).toBe("1:1");
    expect(result!.name).toBe("Container");
    expect(result!.bounds).toEqual({ x: 0, y: 0, w: 400, h: 300 });
  });

  it("should include fill color", () => {
    const node: FigmaNode = {
      id: "1:2",
      name: "Box",
      type: "RECTANGLE",
      fills: [{ type: "SOLID", color: { r: 1, g: 0, b: 0 }, visible: true }],
    };
    const result = simplifyNode(node);
    expect(result!.fill).toBe("#ff0000");
  });

  it("should include text content", () => {
    const node: FigmaNode = {
      id: "1:3",
      name: "Title",
      type: "TEXT",
      characters: "Hello World",
      style: { fontSize: 16, fontWeight: 700 },
    };
    const result = simplifyNode(node);
    expect(result!.text).toBe("Hello World");
    expect(result!.textStyle?.size).toBe(16);
    expect(result!.textStyle?.weight).toBe(700);
  });

  it("should include layout info", () => {
    const node: FigmaNode = {
      id: "1:4",
      name: "Row",
      type: "FRAME",
      layoutMode: "HORIZONTAL",
      itemSpacing: 8,
      paddingTop: 16,
      paddingRight: 16,
      paddingBottom: 16,
      paddingLeft: 16,
    };
    const result = simplifyNode(node);
    expect(result!.layout).toBeDefined();
    expect(result!.layout.mode).toBe("row");
    expect(result!.layout.gap).toBe(8);
  });

  it("should mark absolute-positioned nodes in optimized JSON", () => {
    const node: FigmaNode = {
      id: "1:4abs",
      name: "Floating Glow",
      type: "ELLIPSE",
      layoutPositioning: "ABSOLUTE",
      absoluteBoundingBox: { x: 10, y: 20, width: 168, height: 168 },
    };
    const result = simplifyNode(node);
    expect(result!.position).toBe("absolute");
  });

  it("should infer row layout from child bounds when auto layout is absent", () => {
    const node: FigmaNode = {
      id: "1:4",
      name: "Manual Row",
      type: "FRAME",
      children: [
        { id: "1:4a", name: "A", type: "RECTANGLE", absoluteBoundingBox: { x: 0, y: 0, width: 40, height: 24 } },
        { id: "1:4b", name: "B", type: "RECTANGLE", absoluteBoundingBox: { x: 56, y: 0, width: 40, height: 24 } },
      ],
    };
    const result = simplifyNode(node);
    expect(result!.layout).toBeUndefined();
    expect(result!.inferredLayout).toEqual({
      mode: "row",
      confidence: "high",
      source: "bounds",
      gap: 16,
    });
  });

  it("should not add inferred layout when auto layout exists", () => {
    const node: FigmaNode = {
      id: "1:4",
      name: "Auto Row",
      type: "FRAME",
      layoutMode: "HORIZONTAL",
      children: [
        { id: "1:4a", name: "A", type: "RECTANGLE", absoluteBoundingBox: { x: 0, y: 0, width: 40, height: 24 } },
        { id: "1:4b", name: "B", type: "RECTANGLE", absoluteBoundingBox: { x: 56, y: 0, width: 40, height: 24 } },
      ],
    };
    const result = simplifyNode(node);
    expect(result!.layout?.mode).toBe("row");
    expect(result!.inferredLayout).toBeUndefined();
  });

  it("should recurse into children", () => {
    const node: FigmaNode = {
      id: "1:5",
      name: "Parent",
      type: "FRAME",
      children: [
        { id: "1:6", name: "Child", type: "RECTANGLE" } as FigmaNode,
      ],
    };
    const result = simplifyNode(node);
    expect(result!.children).toHaveLength(1);
    expect(result!.children![0].name).toBe("Child");
  });

  it("should respect maxDepth", () => {
    const node: FigmaNode = {
      id: "1:7",
      name: "Deep",
      type: "FRAME",
      children: [{ id: "1:8", name: "Child", type: "FRAME" } as FigmaNode],
    };
    const result = simplifyNode(node, 0, 0);
    expect(result).not.toBeNull();
    expect(result!.children).toBeUndefined();
  });

  it("should skip VECTOR types at depth > 2", () => {
    const node: FigmaNode = { id: "1:9", name: "vec", type: "VECTOR" };
    expect(simplifyNode(node, 3)).toBeNull();
    expect(simplifyNode(node, 1)).not.toBeNull();
  });
});

describe("buildComponentMap", () => {
  it("should collect components", () => {
    const node: FigmaNode = {
      id: "1:1",
      name: "Page",
      type: "FRAME",
      children: [
        { id: "2:1", name: "Button", type: "COMPONENT", description: "Primary button" } as FigmaNode,
        { id: "2:2", name: "Card", type: "COMPONENT" } as FigmaNode,
      ],
    };
    const map = buildComponentMap(node);
    expect(map["2:1"]).toEqual({ name: "Button", description: "Primary button" });
    expect(map["2:2"]).toEqual({ name: "Card", description: null });
  });

  it("should return empty map for no components", () => {
    const node: FigmaNode = { id: "1:1", name: "Page", type: "FRAME" };
    expect(buildComponentMap(node)).toEqual({});
  });
});

describe("generateSummary", () => {
  it("should return null for null input", () => {
    expect(generateSummary(null)).toBeNull();
  });

  it("should generate summary for a tree", () => {
    const simplified = simplifyNode({
      id: "1:1",
      name: "Frame",
      type: "FRAME",
      absoluteBoundingBox: { x: 0, y: 0, width: 800, height: 600 },
      children: [
        { id: "1:2", name: "Title", type: "TEXT", characters: "Hello" } as FigmaNode,
      ],
    });
    const summary = generateSummary(simplified);
    expect(summary).not.toBeNull();
    expect(summary.rootName).toBe("Frame");
    expect(summary.totalNodes).toBe(2);
  });
});

describe("toCondensedFormat", () => {
  it("should return empty string for null", () => {
    expect(toCondensedFormat(null as any)).toBe("");
  });

  it("should produce condensed output", () => {
    const node: FigmaNode = {
      id: "1:1",
      name: "Box",
      type: "FRAME",
      absoluteBoundingBox: { x: 0, y: 0, width: 200, height: 100 },
    };
    const output = toCondensedFormat(node);
    expect(output).toContain("Box");
    expect(output).toContain("200x100");
  });

  it("should respect maxDepth", () => {
    const node: FigmaNode = {
      id: "1:1",
      name: "Parent",
      type: "FRAME",
      children: [{
        id: "1:2",
        name: "Child",
        type: "FRAME",
        children: [{ id: "1:3", name: "GrandChild", type: "FRAME" } as FigmaNode],
      } as FigmaNode],
    };
    const output = toCondensedFormat(node, 0, 1);
    expect(output).toContain("Parent");
    expect(output).toContain("Child");
    expect(output).not.toContain("GrandChild");
  });

  it("should mark common-size icon instances explicitly", () => {
    const output = toCondensedFormat({
      id: "1:1",
      name: "Module/CPU",
      type: "INSTANCE",
      absoluteBoundingBox: { x: 0, y: 0, width: 24, height: 24 },
      componentId: "900:1",
    } as FigmaNode);

    expect(output).toContain("[MODULE_CPU \"Module/CPU\" 24x24 icon");
  });

  it("should mark icon-prefixed nodes without separators", () => {
    const output = toCondensedFormat({
      id: "1:1",
      name: "iconSearch",
      type: "FRAME",
      absoluteBoundingBox: { x: 0, y: 0, width: 24, height: 24 },
    } as FigmaNode);

    expect(output).toContain('[ICON "iconSearch" 24x24 icon');
  });

  it("should mark Element Plus style icon names", () => {
    const output = toCondensedFormat({
      id: "1:1",
      name: "左导航图标/工作台",
      type: "INSTANCE",
      absoluteBoundingBox: { x: 0, y: 0, width: 24, height: 24 },
      componentId: "900:1",
    } as FigmaNode);

    expect(output).toContain('"左导航图标/工作台" 24x24 icon');
  });

  it("should not mark ordinary same-size frames as icons", () => {
    const output = toCondensedFormat({
      id: "1:1",
      name: "Status",
      type: "FRAME",
      absoluteBoundingBox: { x: 0, y: 0, width: 24, height: 24 },
    } as FigmaNode);

    expect(output).toContain("24x24");
    expect(output).not.toContain(" icon");
  });

  it("should include SVG references on matching icon lines", () => {
    const output = toCondensedFormat(
      {
        id: "1:1",
        name: "Row",
        type: "FRAME",
        children: [
          {
            id: "2:1",
            name: "Basics/settings",
            type: "INSTANCE",
            absoluteBoundingBox: { x: 0, y: 0, width: 24, height: 24 },
            componentId: "900:1",
          } as FigmaNode,
          { id: "2:2", name: "Label", type: "TEXT", characters: "Settings" } as FigmaNode,
        ],
      } as FigmaNode,
      0,
      10,
      null,
      {
        "2:1": {
          filename: "icon-Basics-settings_2-1.svg",
          path: "/tmp/figma-design-context/.figma-temp/svg/icon-Basics-settings_2-1.svg",
          href: "/debug-assets/svg/icon-Basics-settings_2-1.svg",
        },
      }
    );

    expect(output).toContain('[BASICS_SETTINGS "Basics/settings" 24x24 icon');
    expect(output).toContain('svg:"icon-Basics-settings_2-1.svg"');
    expect(output).toContain('svgPath:"/tmp/figma-design-context/.figma-temp/svg/icon-Basics-settings_2-1.svg"');
    expect(output).toContain('svgHref:"/debug-assets/svg/icon-Basics-settings_2-1.svg"');
  });
});

describe("toCondensedWithBudget", () => {
  it("should ignore token budget and return full output up to max depth", () => {
    const makeDeep = (depth: number): FigmaNode => {
      if (depth === 0) return { id: "leaf", name: "Leaf", type: "TEXT", characters: "hello" } as FigmaNode;
      return {
        id: `d${depth}`,
        name: `Level${depth}`,
        type: "FRAME",
        absoluteBoundingBox: { x: 0, y: 0, width: 200, height: 50 },
        children: [makeDeep(depth - 1), makeDeep(depth - 1), makeDeep(depth - 1)],
      } as FigmaNode;
    };
    const node = makeDeep(8);
    const full = toCondensedFormat(node, 0, 15);
    const budgeted = toCondensedWithBudget(node, 50);
    expect(budgeted).toBe(full);
  });

  it("should return full output when within budget", () => {
    const node: FigmaNode = {
      id: "1:1",
      name: "Small",
      type: "FRAME",
      absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 50 },
    };
    const full = toCondensedFormat(node, 0, 15);
    const budgeted = toCondensedWithBudget(node, 4000);
    expect(budgeted).toBe(full);
  });

  it("should respect caller supplied max depth", () => {
    const node: FigmaNode = {
      id: "1:1",
      name: "Parent",
      type: "FRAME",
      children: [{
        id: "1:2",
        name: "Child",
        type: "FRAME",
        children: [{ id: "1:3", name: "GrandChild", type: "FRAME" } as FigmaNode],
      } as FigmaNode],
    };

    const budgeted = toCondensedWithBudget(node, 4000, null, null, 1);

    expect(budgeted).toContain("Parent");
    expect(budgeted).toContain("Child");
    expect(budgeted).not.toContain("GrandChild");
  });

  it("should not hard trim output when budget is small", () => {
    const node: FigmaNode = {
      id: "1:1",
      name: "Root",
      type: "FRAME",
      children: Array.from({ length: 20 }, (_, i) => ({
        id: `1:${i + 2}`,
        name: `VeryLongChildName${i}${"x".repeat(40)}`,
        type: "FRAME",
      })),
    };

    const budgeted = toCondensedWithBudget(node, 30, null, null, 1);

    expect(budgeted).toContain("Root");
    expect(budgeted).toContain("VeryLongChildName19");
    expect(budgeted).not.toContain("truncated");
  });

  it("should include variable bindings from fills, strokes, and effects", () => {
    const node: FigmaNode = {
      id: "1:1",
      name: "Themed",
      type: "FRAME",
      fills: [{
        type: "SOLID",
        color: { r: 1, g: 0, b: 0 },
        boundVariables: { color: { id: "var:fill" } },
      }],
      strokes: [{
        type: "SOLID",
        color: { r: 0, g: 0, b: 1 },
        boundVariables: { color: { id: "var:stroke" } },
      }],
      effects: [{
        type: "DROP_SHADOW",
        color: { r: 0, g: 0, b: 0, a: 0.2 },
        offset: { x: 0, y: 2 },
        radius: 8,
        boundVariables: { color: { id: "var:effect" } },
      }],
    };
    const variableMap = {
      "var:fill": "--bg-primary",
      "var:stroke": "--border-primary",
      "var:effect": "--shadow-primary",
    };

    const output = toCondensedWithBudget(node, 4000, variableMap);

    expect(output).toContain("fill[0].color:var(--bg-primary)");
    expect(output).toContain("stroke[0].color:var(--border-primary)");
    expect(output).toContain("effect[0].color:var(--shadow-primary)");
  });
});

describe("toCondensedV2Format", () => {
  it("should extract shared svg base and icon references", () => {
    const output = toCondensedV2Format(
      {
        id: "1:1",
        name: "Row",
        type: "FRAME",
        children: [
          {
            id: "2:1",
            name: "Module/CPU",
            type: "INSTANCE",
            absoluteBoundingBox: { x: 0, y: 0, width: 24, height: 24 },
            componentId: "900:1",
          } as FigmaNode,
          {
            id: "2:2",
            name: "Module/GPU",
            type: "INSTANCE",
            absoluteBoundingBox: { x: 32, y: 0, width: 24, height: 24 },
            componentId: "900:2",
          } as FigmaNode,
        ],
      } as FigmaNode,
      0,
      10,
      null,
      {
        "2:1": {
          filename: "icon-Module-CPU.svg",
          path: "C:\\tmp\\.figma-temp\\svg\\icon-Module-CPU.svg",
        },
        "2:2": {
          filename: "icon-Module-GPU.svg",
          path: "C:\\tmp\\.figma-temp\\svg\\icon-Module-GPU.svg",
        },
      }
    );

    expect(output).toContain("@format condensed-v2");
    expect(output).toContain('@assets\nsvgBase:"C:/tmp/.figma-temp/svg/"');
    expect(output).toContain("@sizes");
    expect(output).toContain("z1=24x24");
    expect(output).toContain('@icons');
    expect(output).toContain('i1 node:"2:1" name:"Module/CPU" svg:"icon-Module-CPU.svg"');
    expect(output).toContain('[MODULE_CPU "Module/CPU" size:z1 icon:i1');
    expect(output).not.toContain('svgPath:"C:/tmp/.figma-temp/svg/icon-Module-CPU.svg"');
  });

  it("should extract colors, gradients, effects, and repeated style refs", () => {
    const card = (id: string, name: string): FigmaNode => ({
      id,
      name,
      type: "FRAME",
      absoluteBoundingBox: { x: 0, y: 0, width: 200, height: 100 },
      fills: [{ type: "SOLID", color: { r: 0.1, g: 0.1, b: 0.1 }, visible: true }],
      cornerRadius: 20,
      layoutMode: "VERTICAL",
      itemSpacing: 16,
      paddingTop: 24,
      paddingRight: 24,
      paddingBottom: 24,
      paddingLeft: 24,
      children: [
        {
          id: `${id}:text`,
          name: "Title",
          type: "TEXT",
          characters: name,
          style: { fontSize: 16, fontWeight: 400 },
          fills: [{ type: "SOLID", color: { r: 0.925, g: 0.933, b: 0.929 }, visible: true }],
        } as FigmaNode,
      ],
    } as FigmaNode);

    const output = toCondensedV2Format({
      id: "1:1",
      name: "Dashboard",
      type: "FRAME",
      fills: [{
        type: "GRADIENT_LINEAR",
        visible: true,
        gradientStops: [
          { color: { r: 0, g: 0.55, b: 0.55, a: 0.28 }, position: 0 },
          { color: { r: 0.07, g: 0.07, b: 0.07, a: 0.28 }, position: 1 },
        ],
        gradientHandlePositions: [
          { x: 0, y: 0 },
          { x: 1, y: 1 },
        ],
      }],
      effects: [{ type: "LAYER_BLUR", visible: true, radius: 12 }],
      children: [card("2:1", "CPU"), card("2:2", "GPU")],
    } as FigmaNode);

    expect(output).toContain("@colors");
    expect(output).toContain("@sizes");
    expect(output).toContain("z1=200x100");
    expect(output).toContain("c1=");
    expect(output).toContain("@gradients");
    expect(output).toContain("g1=linear-gradient");
    expect(output).toContain("@effects");
    expect(output).toContain("e1=blur:12");
    expect(output).toContain("@styles");
    expect(output).toContain("s1=bg:c1 radius:20 flex-col gap:16 p:24");
    expect(output).toContain('[FRAME "CPU" size:z1 @s1]');
    expect(output).toContain('[FRAME "GPU" size:z1 @s1]');
  });

  it("should mark glow layers as overlay hints without changing the tree", () => {
    const glowFill = {
      type: "GRADIENT_LINEAR",
      visible: true,
      gradientStops: [
        { color: { r: 0.9, g: 0.96, b: 0.33, a: 1 }, position: 0 },
        { color: { r: 0.44, g: 0.69, b: 0, a: 1 }, position: 1 },
      ],
      gradientHandlePositions: [
        { x: 0, y: 0.5 },
        { x: 1, y: 0.5 },
      ],
    } as any;

    const output = toCondensedV2Format({
      id: "1:1",
      name: "Progress Row",
      type: "FRAME",
      absoluteBoundingBox: { x: 0, y: 0, width: 486, height: 36 },
      layoutMode: "HORIZONTAL",
      itemSpacing: 8,
      children: [
        {
          id: "2:1",
          name: "发光",
          type: "FRAME",
          absoluteBoundingBox: { x: 0, y: 0, width: 77, height: 36 },
          fills: [glowFill],
          effects: [{ type: "LAYER_BLUR", visible: true, radius: 12 }],
          cornerRadius: 9999,
          opacity: 0.5,
        } as FigmaNode,
        {
          id: "2:2",
          name: "Frame 1",
          type: "FRAME",
          absoluteBoundingBox: { x: 0, y: 0, width: 77, height: 36 },
          fills: [glowFill],
          cornerRadius: 9999,
          layoutMode: "HORIZONTAL",
          itemSpacing: 4,
          children: [
            {
              id: "3:1",
              name: "Module/CPU Load",
              type: "INSTANCE",
              absoluteBoundingBox: { x: 0, y: 0, width: 20, height: 20 },
              componentId: "900:1",
            } as FigmaNode,
            { id: "3:2", name: "7%", type: "TEXT", characters: "7%" } as FigmaNode,
          ],
        } as FigmaNode,
        {
          id: "2:3",
          name: "Label",
          type: "FRAME",
          absoluteBoundingBox: { x: 85, y: 0, width: 401, height: 20 },
          children: [{ id: "3:3", name: "Load", type: "TEXT", characters: "Load" } as FigmaNode],
        } as FigmaNode,
      ],
    } as FigmaNode);

    expect(output).toContain('"Progress Row" 486x36 has-overlay flex-row gap:8]');
    expect(output).toContain('[FRAME "发光" size:z1 overlay:next layer:decor');
    expect(output).toContain('[FRAME "Frame 1" size:z1 layer:content');
    expect(output).toContain('[FRAME "Label" 401x20]');
  });

  it("should mark large blurred ellipses as parent background decor", () => {
    const output = toCondensedV2Format({
      id: "1:1",
      name: "Card",
      type: "FRAME",
      absoluteBoundingBox: { x: 0, y: 0, width: 534, height: 296 },
      layoutMode: "VERTICAL",
      itemSpacing: 16,
      fills: [{ type: "SOLID", color: { r: 0.1, g: 0.1, b: 0.1 }, visible: true }],
      children: [
        {
          id: "2:1",
          name: "Ellipse 1",
          type: "ELLIPSE",
          absoluteBoundingBox: { x: 40, y: 20, width: 168, height: 168 },
          fills: [{ type: "SOLID", color: { r: 1, g: 0.84, b: 0.04 }, visible: true }],
          effects: [{ type: "LAYER_BLUR", visible: true, radius: 80 }],
          opacity: 0.2,
        } as FigmaNode,
        {
          id: "2:2",
          name: "标题",
          type: "FRAME",
          absoluteBoundingBox: { x: 24, y: 24, width: 486, height: 24 },
          children: [{ id: "3:1", name: "Title", type: "TEXT", characters: "CPU" } as FigmaNode],
        } as FigmaNode,
      ],
    } as FigmaNode);

    expect(output).toContain('"Card" 534x296 has-overlay');
    expect(output).toContain('[ELLIPSE "Ellipse 1" 168x168 overlay:parent layer:decor');
    expect(output).toContain('[FRAME "标题" 486x24]');
  });

  it("should mark absolute-positioned nodes in condensed formats", () => {
    const node = {
      id: "1:1",
      name: "Floating Glow",
      type: "ELLIPSE",
      layoutPositioning: "ABSOLUTE",
      absoluteBoundingBox: { x: 10, y: 20, width: 168, height: 168 },
      fills: [{ type: "SOLID", color: { r: 1, g: 0.84, b: 0.04 }, visible: true }],
      effects: [{ type: "LAYER_BLUR", visible: true, radius: 80 }],
      opacity: 0.2,
    } as FigmaNode;

    expect(toCondensedFormat(node)).toContain('[ELLIPSE "Floating Glow" 168x168 pos:absolute');
    expect(toCondensedV2Format(node)).toContain('[ELLIPSE "Floating Glow" 168x168 pos:absolute');
  });

  it("should not mark small icon ellipses as parent background decor", () => {
    const output = toCondensedV2Format({
      id: "1:1",
      name: "Icon/status",
      type: "FRAME",
      absoluteBoundingBox: { x: 0, y: 0, width: 24, height: 24 },
      children: [
        {
          id: "2:1",
          name: "Ellipse 1",
          type: "ELLIPSE",
          absoluteBoundingBox: { x: 2, y: 2, width: 20, height: 20 },
          fills: [{ type: "SOLID", color: { r: 0, g: 1, b: 0 }, visible: true }],
          opacity: 0.5,
        } as FigmaNode,
        { id: "2:2", name: "Vector", type: "VECTOR" } as FigmaNode,
      ],
    } as FigmaNode);

    expect(output).not.toContain("overlay:parent");
  });

  it("should not mark ordinary same-size siblings as overlays", () => {
    const output = toCondensedV2Format({
      id: "1:1",
      name: "Cards",
      type: "FRAME",
      layoutMode: "HORIZONTAL",
      itemSpacing: 12,
      children: [
        {
          id: "2:1",
          name: "Card A",
          type: "FRAME",
          absoluteBoundingBox: { x: 0, y: 0, width: 200, height: 100 },
          fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1 }, visible: true }],
          children: [{ id: "3:1", name: "A", type: "TEXT", characters: "A" } as FigmaNode],
        } as FigmaNode,
        {
          id: "2:2",
          name: "Card B",
          type: "FRAME",
          absoluteBoundingBox: { x: 212, y: 0, width: 200, height: 100 },
          fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1 }, visible: true }],
          children: [{ id: "3:2", name: "B", type: "TEXT", characters: "B" } as FigmaNode],
        } as FigmaNode,
      ],
    } as FigmaNode);

    expect(output).not.toContain("has-overlay");
    expect(output).not.toContain("overlay:next");
    expect(output).not.toContain("layer:decor");
  });

  it("should include Hug/Fill/Fixed resize semantics in v2 tree", () => {
    const output = toCondensedV2Format({
      id: "1:1",
      name: "Responsive Item",
      type: "FRAME",
      layoutSizingHorizontal: "FILL",
      layoutSizingVertical: "HUG",
    } as FigmaNode);

    expect(output).toContain("resize:x-fill/y-hug");
  });

  it("should include variable bindings from paint-level variables", () => {
    const output = toCondensedV2Format(
      {
        id: "1:1",
        name: "Themed",
        type: "FRAME",
        fills: [{
          type: "SOLID",
          color: { r: 0.2, g: 0.3, b: 0.4 },
          boundVariables: { color: { id: "var:fill" } },
        }],
      } as FigmaNode,
      0,
      10,
      { "var:fill": "--bg-primary" }
    );

    expect(output).toContain("vars:{fill[0].color=var(--bg-primary)}");
  });
});

describe("toCondensedV2WithBudget", () => {
  it("should ignore token budget and return full output up to max depth", () => {
    const makeDeep = (depth: number): FigmaNode => {
      if (depth === 0) {
        return { id: "leaf", name: "Leaf", type: "TEXT", characters: "hello" } as FigmaNode;
      }
      return {
        id: `d${depth}`,
        name: `Level${depth}`,
        type: "FRAME",
        absoluteBoundingBox: { x: 0, y: 0, width: 200, height: 50 },
        children: [makeDeep(depth - 1), makeDeep(depth - 1), makeDeep(depth - 1)],
      } as FigmaNode;
    };
    const node = makeDeep(8);

    const full = toCondensedV2Format(node, 0, 15);
    const budgeted = toCondensedV2WithBudget(node, 80);

    expect(budgeted).toBe(full);
  });

  it("should respect caller supplied max depth", () => {
    const node: FigmaNode = {
      id: "1:1",
      name: "Parent",
      type: "FRAME",
      children: [{
        id: "1:2",
        name: "Child",
        type: "FRAME",
        children: [{ id: "1:3", name: "GrandChild", type: "FRAME" } as FigmaNode],
      } as FigmaNode],
    };

    const budgeted = toCondensedV2WithBudget(node, 4000, null, null, 1);

    expect(budgeted).toContain("Parent");
    expect(budgeted).toContain("Child");
    expect(budgeted).not.toContain("GrandChild");
  });

  it("should not hard trim v2 output when budget is small", () => {
    const node: FigmaNode = {
      id: "1:1",
      name: "Root",
      type: "FRAME",
      children: Array.from({ length: 20 }, (_, i) => ({
        id: `1:${i + 2}`,
        name: `VeryLongChildName${i}${"x".repeat(40)}`,
        type: "FRAME",
      })),
    };

    const budgeted = toCondensedV2WithBudget(node, 30, null, null, 1);

    expect(budgeted).toContain("Root");
    expect(budgeted).toContain("VeryLongChildName19");
    expect(budgeted).not.toContain("@note truncated");
  });
});

describe("semantic formats", () => {
  const variablesData = {
    meta: {
      variableCollections: {
        coll1: {
          name: "Colors",
          modes: [{ modeId: "m1", name: "Light" }],
        },
      },
      variables: {
        "var:fill": {
          name: "Brand/Primary",
          resolvedType: "COLOR",
          variableCollectionId: "coll1",
          valuesByMode: { m1: { r: 0.1, g: 0.2, b: 0.3, a: 1 } },
          codeSyntax: { WEB: "--color-brand-primary" },
        },
      },
    },
  };

  const semanticNode = {
    id: "1:1",
    name: "Card",
    type: "INSTANCE",
    componentId: "900:1",
    componentProperties: {
      State: { type: "VARIANT", value: "Default" },
    },
    layoutMode: "GRID",
    layoutSizingHorizontal: "FILL",
    layoutSizingVertical: "HUG",
    gridColumnCount: 2,
    gridRowCount: 1,
    fills: [{
      type: "SOLID",
      color: { r: 0.1, g: 0.2, b: 0.3 },
      boundVariables: { color: { id: "var:fill" } },
    }],
    children: [{
      id: "1:2",
      name: "Title",
      type: "TEXT",
      characters: "Hello",
      style: { fontSize: 16, fontWeight: 700, textCase: "UPPER" },
      textAutoResize: "WIDTH_AND_HEIGHT",
    }],
  } as FigmaNode;

  it("should build semantic variable definitions from variables API data", () => {
    const definitions = buildSemanticVariableDefinitions(variablesData);

    expect(definitions["var:fill"].cssVar).toBe("--color-brand-primary");
    expect(definitions["var:fill"].values?.Light).toBe("#1a334d");
  });

  it("should produce semantic-json with layout, component, text, and variable semantics", () => {
    const definitions = buildSemanticVariableDefinitions(variablesData);
    const output = toSemanticJson(semanticNode, {
      maxDepth: 3,
      variableDefinitions: definitions,
    });

    expect(output.capabilities.variables).toBe(true);
    expect(output.tree.resize).toEqual({ horizontal: "fill", vertical: "hug", source: "layoutSizing" });
    expect(output.tree.layout.grid.gridColumnCount).toBe(2);
    expect(output.tree.component.componentId).toBe("900:1");
    expect(output.tree.visual.fills[0].variables[0].cssVar).toBe("--color-brand-primary");
    expect(output.tree.children[0].text.style.textCase).toBe("UPPER");
  });

  it("should produce condensed-v3 semantic sections", () => {
    const definitions = buildSemanticVariableDefinitions(variablesData);
    const output = toCondensedV3Format(semanticNode, {
      maxDepth: 3,
      variableDefinitions: definitions,
    });

    expect(output).toContain("@format condensed-v3");
    expect(output).toContain("@tokens");
    expect(output).toContain("@layout");
    expect(output).toContain("resize:x-fill/y-hug");
    expect(output).toContain("@components");
    expect(output).toContain("@text");
    expect(output).toContain("@tree");
  });
});

describe("gradientToCSS", () => {
  it("should return null for null input", () => {
    expect(gradientToCSS(null as any)).toBeNull();
  });

  it("should convert linear gradient", () => {
    const fill = {
      type: "GRADIENT_LINEAR",
      gradientStops: [
        { color: { r: 1, g: 0, b: 0, a: 1 }, position: 0 },
        { color: { r: 0, g: 0, b: 1, a: 1 }, position: 1 },
      ],
      gradientHandlePositions: [
        { x: 0.5, y: 0 },
        { x: 0.5, y: 1 },
      ],
    };
    const result = gradientToCSS(fill as any);
    expect(result).toContain("linear-gradient");
    expect(result).toContain("#ff0000");
    expect(result).toContain("#0000ff");
  });

  it("should convert radial gradient", () => {
    const fill = {
      type: "GRADIENT_RADIAL",
      gradientStops: [
        { color: { r: 1, g: 1, b: 1, a: 1 }, position: 0 },
        { color: { r: 0, g: 0, b: 0, a: 1 }, position: 1 },
      ],
      gradientHandlePositions: [
        { x: 0.5, y: 0.5 },
        { x: 0.5, y: 1 },
        { x: 1, y: 0.5 },
      ],
    };
    const result = gradientToCSS(fill as any);
    expect(result).toContain("radial-gradient");
  });
});

describe("parseEffects", () => {
  it("should return null for empty effects", () => {
    expect(parseEffects([])).toBeNull();
    expect(parseEffects(undefined)).toBeNull();
  });

  it("should parse drop shadow", () => {
    const effects = [{
      type: "DROP_SHADOW",
      visible: true,
      color: { r: 0, g: 0, b: 0, a: 0.25 },
      offset: { x: 0, y: 4 },
      radius: 8,
      spread: 0,
    }];
    const result = parseEffects(effects as any);
    expect(result).toHaveLength(1);
    expect(result![0].type).toBe("drop-shadow");
    expect(result![0].offset).toEqual({ x: 0, y: 4 });
    expect(result![0].radius).toBe(8);
  });

  it("should parse blur", () => {
    const effects = [{ type: "LAYER_BLUR", visible: true, radius: 10 }];
    const result = parseEffects(effects as any);
    expect(result).toHaveLength(1);
    expect(result![0].type).toBe("blur");
    expect(result![0].radius).toBe(10);
  });

  it("should skip invisible effects", () => {
    const effects = [{ type: "DROP_SHADOW", visible: false, radius: 8 }];
    const result = parseEffects(effects as any);
    expect(result).toBeNull();
  });
});

describe("effectsToCSS", () => {
  it("should return empty for no effects", () => {
    expect(effectsToCSS(undefined)).toEqual({});
  });

  it("should generate box-shadow CSS", () => {
    const effects = [{
      type: "DROP_SHADOW",
      visible: true,
      color: { r: 0, g: 0, b: 0, a: 0.5 },
      offset: { x: 2, y: 4 },
      radius: 6,
      spread: 0,
    }];
    const css = effectsToCSS(effects as any);
    expect(css["box-shadow"]).toContain("2px 4px 6px");
  });
});

describe("fillsToCSS", () => {
  it("should return empty for no fills", () => {
    expect(fillsToCSS(undefined)).toEqual({});
  });

  it("should generate background for solid fill", () => {
    const fills = [{ type: "SOLID", color: { r: 1, g: 0, b: 0 }, visible: true }];
    const css = fillsToCSS(fills as any);
    expect(css["background"]).toBe("#ff0000");
  });
});

describe("buildVariableMap", () => {
  it("should return empty map for null input", () => {
    expect(buildVariableMap(null)).toEqual({});
  });

  it("should build variable map from API data", () => {
    const data = {
      meta: {
        variables: {
          "var1": { name: "primary", variableCollectionId: "coll1" },
          "var2": { name: "secondary", variableCollectionId: "coll1" },
        },
        variableCollections: {
          "coll1": { name: "colors" },
        },
      },
    };
    const map = buildVariableMap(data);
    expect(map["var1"]).toBe("--colors-primary");
    expect(map["var2"]).toBe("--colors-secondary");
  });
});

describe("buildVariableMapFromNodes", () => {
  it("should extract variables from fills", () => {
    const node: FigmaNode = {
      id: "1:1",
      name: "Box",
      type: "FRAME",
      fills: [{
        type: "SOLID",
        color: { r: 1, g: 0, b: 0 },
        boundVariables: { color: { id: "VariableID:1:1" } },
      }],
    };
    const result = buildVariableMapFromNodes(node);
    expect(result["VariableID:1:1"]).toBeDefined();
    expect(result["VariableID:1:1"].color).toBe("#ff0000");
    expect(result["VariableID:1:1"].cssVar).toContain("--bg-");
  });
});

describe("estimateTokens", () => {
  it("should estimate tokens as length / 4", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("")).toBe(0);
  });
});

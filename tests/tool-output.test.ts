/**
 * 集成测试：验证 MCP 工具输出格式的完整度
 * 使用 mock 数据模拟 Figma API 响应，测试各工具的输出结构
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  textResponse,
  normalizeNodeId,
  formatError,
  fetchNodeDocument,
  isErrorResponse,
  exportAndRegisterIcons,
} from "../src/tools/shared.js";
import { FigmaApiError } from "../src/figma-client.js";
import {
  simplifyNode,
  generateSummary,
  toCondensedFormat,
  toCondensedV3WithBudget,
  toCondensedWithBudget,
  toCondensedV2WithBudget,
  buildVariableMapFromNodes,
} from "../src/transformer.js";
import { extractAllTexts, searchNodes, extractDesignInfo } from "../src/helpers.js";

// --- Mock Figma 节点数据 ---
const mockButtonNode = {
  id: "100:1",
  name: "Button",
  type: "FRAME",
  visible: true,
  absoluteBoundingBox: { x: 0, y: 0, width: 200, height: 48 },
  constraints: { vertical: "TOP", horizontal: "LEFT" },
  fills: [{ type: "SOLID", color: { r: 0.2, g: 0.4, b: 1, a: 1 } }],
  cornerRadius: 8,
  paddingLeft: 16,
  paddingRight: 16,
  paddingTop: 12,
  paddingBottom: 12,
  layoutMode: "HORIZONTAL",
  primaryAxisAlignItems: "CENTER",
  counterAxisAlignItems: "CENTER",
  itemSpacing: 8,
  children: [
    {
      id: "100:2",
      name: "icon-star",
      type: "VECTOR",
      visible: true,
      absoluteBoundingBox: { x: 16, y: 14, width: 20, height: 20 },
      fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1, a: 1 } }],
    },
    {
      id: "100:3",
      name: "Label",
      type: "TEXT",
      visible: true,
      characters: "Submit",
      absoluteBoundingBox: { x: 44, y: 14, width: 60, height: 20 },
      style: {
        fontFamily: "Inter",
        fontSize: 16,
        fontWeight: 600,
        lineHeightPx: 20,
      },
      fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1, a: 1 } }],
    },
  ],
};

const mockCardNode = {
  id: "200:1",
  name: "ProductCard",
  type: "FRAME",
  visible: true,
  absoluteBoundingBox: { x: 0, y: 0, width: 320, height: 400 },
  layoutMode: "VERTICAL",
  primaryAxisAlignItems: "MIN",
  counterAxisAlignItems: "MIN",
  itemSpacing: 16,
  paddingLeft: 16,
  paddingRight: 16,
  paddingTop: 16,
  paddingBottom: 16,
  fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1, a: 1 } }],
  cornerRadius: 12,
  effects: [
    { type: "DROP_SHADOW", visible: true, radius: 8, offset: { x: 0, y: 4 }, color: { r: 0, g: 0, b: 0, a: 0.1 } },
  ],
  children: [
    {
      id: "200:2",
      name: "Image",
      type: "RECTANGLE",
      visible: true,
      absoluteBoundingBox: { x: 16, y: 16, width: 288, height: 180 },
      fills: [{ type: "IMAGE", imageRef: "img_abc123" }],
      cornerRadius: 8,
    },
    {
      id: "200:3",
      name: "Content",
      type: "FRAME",
      visible: true,
      absoluteBoundingBox: { x: 16, y: 212, width: 288, height: 172 },
      layoutMode: "VERTICAL",
      itemSpacing: 8,
      children: [
        {
          id: "200:4",
          name: "Title",
          type: "TEXT",
          visible: true,
          characters: "Premium Headphones",
          absoluteBoundingBox: { x: 16, y: 212, width: 288, height: 24 },
          style: { fontFamily: "Inter", fontSize: 20, fontWeight: 700, lineHeightPx: 24 },
          fills: [{ type: "SOLID", color: { r: 0.1, g: 0.1, b: 0.1, a: 1 } }],
        },
        {
          id: "200:5",
          name: "Description",
          type: "TEXT",
          visible: true,
          characters: "High-quality wireless headphones with noise cancellation",
          absoluteBoundingBox: { x: 16, y: 244, width: 288, height: 40 },
          style: { fontFamily: "Inter", fontSize: 14, fontWeight: 400, lineHeightPx: 20 },
          fills: [{ type: "SOLID", color: { r: 0.4, g: 0.4, b: 0.4, a: 1 } }],
        },
        {
          id: "200:6",
          name: "Price",
          type: "TEXT",
          visible: true,
          characters: "$299.99",
          absoluteBoundingBox: { x: 16, y: 292, width: 100, height: 28 },
          style: { fontFamily: "Inter", fontSize: 24, fontWeight: 700, lineHeightPx: 28 },
          fills: [{ type: "SOLID", color: { r: 0.2, g: 0.4, b: 1, a: 1 } }],
        },
        mockButtonNode,
      ],
    },
  ],
};

const mockComponentSetNode = {
  id: "300:1",
  name: "Button",
  type: "COMPONENT_SET",
  visible: true,
  absoluteBoundingBox: { x: 0, y: 0, width: 600, height: 200 },
  children: [
    { id: "300:2", name: "Size=Large, State=Default", type: "COMPONENT", visible: true },
    { id: "300:3", name: "Size=Large, State=Hover", type: "COMPONENT", visible: true },
    { id: "300:4", name: "Size=Small, State=Default", type: "COMPONENT", visible: true },
    { id: "300:5", name: "Size=Small, State=Hover", type: "COMPONENT", visible: true },
  ],
};

// --- Tests ---

describe("MCP 工具输出完整度测试", () => {
  describe("textResponse 格式", () => {
    it("返回标准 MCP 响应结构", () => {
      const result = textResponse("hello");
      expect(result).toHaveProperty("content");
      expect(result.content).toHaveLength(1);
      expect(result.content[0]).toEqual({ type: "text", text: "hello" });
    });
  });

  describe("formatError 错误处理", () => {
    it("401/403 返回权限提示", () => {
      const result = formatError(new FigmaApiError(403, "Forbidden"));
      expect(result.content[0].text).toContain("无权限");
    });

    it("404 返回不存在提示", () => {
      const result = formatError(new FigmaApiError(404, "Not found"));
      expect(result.content[0].text).toContain("不存在");
    });

    it("429 返回限流提示", () => {
      const result = formatError(new FigmaApiError(429, "Rate limited"));
      expect(result.content[0].text).toContain("频繁");
    });

    it("网络错误返回连接提示", () => {
      const result = formatError(new Error("fetch failed: ECONNREFUSED"));
      expect(result.content[0].text).toContain("网络");
    });

    it("未知错误返回通用提示", () => {
      const result = formatError("something weird");
      expect(result.content[0].text).toContain("未知错误");
    });
  });

  describe("get_node 输出模拟 (condensed-v3)", () => {
    it("生成完整的 condensed-v3 结构", () => {
      const condensed = toCondensedV3WithBudget(mockCardNode, 4000, { maxDepth: 10 });
      expect(condensed).toBeTruthy();
      expect(condensed.length).toBeGreaterThan(50);
      // 应包含节点名称
      expect(condensed).toContain("ProductCard");
      // 应包含文字内容
      expect(condensed).toContain("Premium Headphones");
      expect(condensed).toContain("$299.99");
      // 应包含布局信息
      expect(condensed).toMatch(/col|vertical|VERTICAL/i);
    });

    it("生成节点概览 summary", () => {
      const simplified = simplifyNode(mockCardNode, 0, 10);
      const summary = generateSummary(simplified);
      expect(summary.rootName).toBe("ProductCard");
      expect(summary.rootType).toBe("FRAME");
      expect(summary.totalNodes).toBeGreaterThan(5);
      expect(summary.rootSize).toContain("320");
      expect(summary.rootSize).toContain("400");
    });

    it("condensed 格式包含关键信息", () => {
      const condensed = toCondensedWithBudget(mockCardNode, 4000, null, {}, 10);
      expect(condensed).toContain("ProductCard");
      expect(condensed).toContain("Submit");
    });

    it("condensed-v2 格式包含关键信息", () => {
      const condensed = toCondensedV2WithBudget(mockCardNode, 4000, null, {}, 10);
      expect(condensed).toContain("ProductCard");
      expect(condensed).toContain("Premium Headphones");
    });
  });

  describe("get_texts 输出模拟", () => {
    it("提取所有文字内容", () => {
      const texts = extractAllTexts(mockCardNode, 20);
      expect(texts.length).toBeGreaterThanOrEqual(4);
      const textValues = texts.map((t) => t.text);
      expect(textValues).toContain("Submit");
      expect(textValues).toContain("Premium Headphones");
      expect(textValues).toContain("$299.99");
      expect(textValues).toContain("High-quality wireless headphones with noise cancellation");
    });

    it("文字包含路径信息", () => {
      const texts = extractAllTexts(mockCardNode, 20);
      const titleText = texts.find((t) => t.text === "Premium Headphones");
      expect(titleText).toBeDefined();
      expect(titleText!.path).toContain("ProductCard");
    });
  });

  describe("search_nodes 输出模拟", () => {
    it("按名称搜索", () => {
      const results = searchNodes(mockCardNode, { query: "title", maxResults: 10 });
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].name).toBe("Title");
      expect(results[0].type).toBe("TEXT");
      expect(results[0].id).toBe("200:4");
    });

    it("按类型搜索", () => {
      const results = searchNodes(mockCardNode, { type: "TEXT", maxResults: 10 });
      expect(results.length).toBeGreaterThanOrEqual(4);
    });

    it("组合搜索", () => {
      const results = searchNodes(mockCardNode, { query: "price", type: "TEXT", maxResults: 10 });
      expect(results.length).toBe(1);
      expect(results[0].name).toBe("Price");
    });
  });

  describe("get_page_for_codegen 输出模拟", () => {
    it("提取设计信息完整", () => {
      const colors = new Set<string>();
      const fonts = new Set<string>();
      const components: { name: string; componentId: string }[] = [];
      extractDesignInfo(mockCardNode, colors, fonts, components);

      // 应提取到颜色
      expect(colors.size).toBeGreaterThan(0);
      // 应提取到字体
      expect(fonts.has("Inter")).toBe(true);
    });

    it("condensed 结构包含完整层级", () => {
      const structure = toCondensedFormat(mockCardNode, 0, 12, null);
      expect(structure).toContain("ProductCard");
      expect(structure).toContain("Content");
      expect(structure).toContain("Button");
      expect(structure).toContain("Submit");
    });
  });

  describe("get_component_variants 输出模拟", () => {
    it("解析 variant 属性", () => {
      const node = mockComponentSetNode;
      const properties: Record<string, Set<string>> = {};
      const variants: Array<{ name: string; id: string; props: Record<string, string> }> = [];

      for (const child of node.children || []) {
        if (child.type !== "COMPONENT") continue;
        const props: Record<string, string> = {};
        const parts = child.name.split(",").map((s: string) => s.trim());
        for (const part of parts) {
          const [key, value] = part.split("=").map((s: string) => s.trim());
          if (key && value) {
            props[key] = value;
            if (!properties[key]) properties[key] = new Set();
            properties[key].add(value);
          }
        }
        variants.push({ name: child.name, id: child.id, props });
      }

      expect(variants).toHaveLength(4);
      expect(Object.keys(properties)).toContain("Size");
      expect(Object.keys(properties)).toContain("State");
      expect(properties["Size"]).toEqual(new Set(["Large", "Small"]));
      expect(properties["State"]).toEqual(new Set(["Default", "Hover"]));
    });
  });

  describe("fetchNodeDocument + isErrorResponse", () => {
    it("节点不存在时返回错误响应", async () => {
      const mockFigma = {
        getFileNodes: vi.fn().mockResolvedValue({ nodes: {} }),
      } as any;

      const result = await fetchNodeDocument(mockFigma, "file123", "999:1");
      expect(isErrorResponse(result)).toBe(true);
      if (isErrorResponse(result)) {
        expect(result.content[0].text).toContain("不存在");
      }
    });

    it("节点存在时返回 document", async () => {
      const mockFigma = {
        getFileNodes: vi.fn().mockResolvedValue({
          nodes: { "100:1": { document: mockButtonNode } },
        }),
      } as any;

      const result = await fetchNodeDocument(mockFigma, "file123", "100-1");
      expect(isErrorResponse(result)).toBe(false);
      if (!isErrorResponse(result)) {
        expect(result.document.name).toBe("Button");
        expect(result.document.type).toBe("FRAME");
      }
    });
  });

  describe("normalizeNodeId", () => {
    it("将连字符转为冒号", () => {
      expect(normalizeNodeId("100-1")).toBe("100:1");
      expect(normalizeNodeId("312-33667")).toBe("312:33667");
    });

    it("已是冒号格式不变", () => {
      expect(normalizeNodeId("100:1")).toBe("100:1");
    });
  });
});

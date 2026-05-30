#!/usr/bin/env node
/**
 * MCP Server 入口文件
 *
 * 职责：
 * 1. 初始化所有核心服务实例（FigmaClient、TempManager、Logger、SvgExporter）
 * 2. 注册 14 个 MCP 工具（tool），每个工具对应一种 Figma 数据获取/转换能力
 * 3. 通过 stdio 传输层与 MCP Client（如 Claude Desktop）建立通信
 *
 * 数据流：Client 调用 tool → handler 执行 → FigmaClient 请求 API → transformer 转换格式 → 返回文本结果
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod"; // 参数校验库，MCP SDK 要求用 zod 定义 tool 的输入 schema
import { FigmaClient } from "./figma-client.js";
import type { FigmaNodesResponse, FigmaVersionsResponse } from "./figma-client.js";
import { TempManager } from "./temp-manager.js";
import { Logger } from "./logger.js";
import { SvgExporter } from "./svg-exporter.js";
import { simplifyNode, buildComponentMap, generateSummary, toCondensedFormat, inferSemanticRole, buildVariableMap, buildVariableMapFromNodes, buildSemanticVariableDefinitions, semanticDefinitionsToVariableMap, toSemanticJson, toCondensedV3WithBudget, toCondensedWithBudget, toCondensedV2WithBudget, gradientToCSS, parseEffects, effectsToCSS, fillsToCSS, colorToString, type CondensedSvgMap, type CondensedVariableMap, type SemanticCapabilities } from "./transformer.js";
import { parseFigmaUrl, extractAllTexts, formatVariableValues, formatValue, extractDesignInfo, toCSSClass, nodeToCSS, nodeToCSSRecursive, nodeToTailwind, nodeToTailwindRecursive, searchNodes } from "./helpers.js";
import { diffNodes, formatDiffOutput } from "./diff.js";
import { textResponse, normalizeNodeId, formatError, fetchNodeDocument, isErrorResponse, exportAndRegisterIcons } from "./tools/shared.js";

// 启动前置检查：必须提供 Figma API Token
if (!process.env.FIGMA_TOKEN) {
  process.stderr.write(
    "Error: FIGMA_TOKEN 环境变量未设置。\n" +
    "请在 MCP 配置中添加: \"env\": { \"FIGMA_TOKEN\": \"your-token\" }\n" +
    "获取 token: https://www.figma.com/developers/api#access-tokens\n"
  );
  process.exit(1);
}

/**
 * 将变量数据转换为 condensed 格式的变量映射
 * 输入：{ variableId: { cssVar: "--color-primary" } }
 * 输出：{ variableId: "--color-primary" } （扁平化，只保留 CSS 变量名）
 */
function toCondensedVariableMap(
  variables: Record<string, { cssVar: string }> | null | undefined
): CondensedVariableMap | null {
  if (!variables) return null;

  const result: CondensedVariableMap = {};
  for (const [id, variable] of Object.entries(variables)) {
    if (variable.cssVar) result[id] = variable.cssVar;
  }

  return Object.keys(result).length > 0 ? result : null;
}

/**
 * 加载文件的语义变量定义（Design Tokens）
 * 调用 Figma Variables API，构建变量定义和映射
 * 如果 API 不可用（如免费版账号），优雅降级返回空值
 */
async function loadSemanticVariables(fileKey: string): Promise<{
  definitions: ReturnType<typeof buildSemanticVariableDefinitions> | null;
  variableMap: CondensedVariableMap | null;
  capabilities: Partial<SemanticCapabilities>;
}> {
  try {
    const variablesData = await figma.getVariables(fileKey);
    const definitions = buildSemanticVariableDefinitions(variablesData);
    const variableMap = semanticDefinitionsToVariableMap(definitions);
    return {
      definitions,
      variableMap,
      capabilities: {
        variables: Object.keys(definitions).length > 0,
        variableModeValues: Object.keys(definitions).length > 0,
      },
    };
  } catch (error) {
    return {
      definitions: null,
      variableMap: null,
      capabilities: {
        variables: false,
        variableModeValues: false,
        variablesReason: error instanceof Error ? error.message : "variables endpoint unavailable",
      },
    };
  }
}

// 从 package.json 读取版本号，避免手动同步
import { createRequire } from "node:module";
const __require = createRequire(import.meta.url);
const __pkg = __require("../package.json");

// 创建 MCP Server 实例，name 和 version 会在 Client 的 tools/list 中展示
const server = new McpServer({
  name: "figma-design-context",
  version: __pkg.version,
});

// 初始化核心服务
const tempManager = new TempManager(); // 临时文件管理（.figma-temp/ 目录）
tempManager.init(); // 清理旧数据，创建目录结构

const logger = new Logger(tempManager); // 结构化日志（仅 debug 模式写入）
const figma = new FigmaClient(process.env.FIGMA_TOKEN); // Figma REST 客户端（带缓存/重试/并发控制）
const svgExporter = new SvgExporter(figma, tempManager); // SVG 导出器（图标检测 + 下载）

// 注册 API 响应回调，用于 debug 模式下记录原始响应
figma.onResponse = (path, params, data) => {
  logger.logRaw("api", { path, params }, data);
};

// ==================== 工具注册 ====================
// 每个 registerTool 调用注册一个 MCP tool，包含：
// - 工具名称（Client 通过此名称调用）
// - description + inputSchema（Client 展示给 LLM 用于决策）
// - handler 函数（实际执行逻辑）

/**
 * 工具 1: get_file_structure
 * 获取文件的页面和顶层 frame 列表，用于了解文件整体结构
 * 只请求 depth=2，避免拉取整棵树
 */
server.registerTool(
  "get_file_structure",
  {
    description: "获取 Figma 文件的页面和顶层 frame 结构概览，适合了解文件整体组织",
    inputSchema: {
      fileKey: z.string().describe("Figma 文件 Key"),
    },
  },
  async ({ fileKey }) => {
    try {
      const data = await figma.getFile(fileKey, { depth: 2 });
      if (!data) return textResponse("获取文件失败，请检查 token 和 file key");

      const pages = (data.document.children || []).map((page) => ({
        id: page.id,
        name: page.name,
        frames: (page.children || [])
          .filter((c) => c.type === "FRAME" || c.type === "COMPONENT" || c.type === "COMPONENT_SET")
          .map((f) => ({
            id: f.id,
            name: f.name,
            type: f.type,
            width: f.absoluteBoundingBox?.width,
            height: f.absoluteBoundingBox?.height,
          })),
      }));

      return textResponse(JSON.stringify({ fileName: data.name, lastModified: data.lastModified, pages }, null, 2));
    } catch (error) { return formatError(error); }
  }
);

/**
 * 工具 2: get_texts
 * 递归提取节点树中所有 TEXT 节点的文字内容和样式信息
 * 支持直接传入 Figma URL 自动解析 fileKey 和 nodeId
 */
server.registerTool(
  "get_texts",
  {
    description: "从 Figma 地址或文件中提取所有文字内容，支持直接传入 Figma URL",
    inputSchema: {
      url: z.string().optional().describe("Figma 文件/节点 URL，如 https://www.figma.com/design/xxx/yyy?node-id=1-2"),
      fileKey: z.string().optional().describe("Figma 文件 Key（与 url 二选一）"),
      nodeId: z.string().optional().describe("节点 ID，不传则获取整个文件的文字"),
      depth: z.number().optional().default(20).describe("递归深度，默认 20"),
    },
  },
  async ({ url, fileKey, nodeId, depth }) => {
    try {
      let resolvedFileKey = fileKey;
      let resolvedNodeId = nodeId;

      if (url) {
        const parsed = parseFigmaUrl(url);
        if (!parsed) {
          return textResponse("无法解析 Figma URL，请确认格式正确");
        }
        resolvedFileKey = parsed.fileKey;
        resolvedNodeId = parsed.nodeId || resolvedNodeId;
      }

      if (!resolvedFileKey) {
        return textResponse("请提供 Figma URL 或 fileKey");
      }

      let rootNode: any;

      if (resolvedNodeId) {
        const result = await fetchNodeDocument(figma, resolvedFileKey, resolvedNodeId);
        if (isErrorResponse(result)) return result;
        rootNode = result.document;
      } else {
        const data = await figma.getFile(resolvedFileKey, { depth });
        if (!data) return textResponse("获取文件失败，请检查 token 和 file key");
        rootNode = data.document;
      }

      const texts = extractAllTexts(rootNode, depth);

      if (texts.length === 0) {
        return textResponse("未找到任何文字内容");
      }

      const output = texts.map((t) =>
        `[${t.path}] ${t.text}${t.style ? ` (${t.style})` : ""}`
      ).join("\n");

      return textResponse(`# 文字内容 (共 ${texts.length} 条)\n\n${output}`);
    } catch (error) { return formatError(error); }
  }
);

/**
 * 工具 3: get_node（核心工具）
 * 获取指定节点的 AI 友好数据，支持 5 种输出格式：
 * - condensed-v3（默认）：最适合 AI 代码生成，带语义分区和 token 去重
 * - semantic-json：结构化语义 JSON，适合程序化消费
 * - condensed-v2：去重文本格式（兼容版）
 * - condensed：旧版内联文本格式
 * - json：完整数据，用于排障
 */
server.registerTool(
  "get_node",
  {
    description: "获取指定 Figma 节点的 AI 友好数据。默认使用 condensed-v3，这是最适合 AI 代码生成的文本格式：在 condensed-v2 的去重树基础上增加 layout/tokens/components/assets/text/dev/interactions 语义和 Hug/Fill/Fixed 尺寸语义。需要旧版内联格式时显式传 format='condensed'；需要结构化语义时传 format='semantic-json'；需要完整排障数据时传 format='json'。",
    inputSchema: {
      fileKey: z.string().describe("Figma 文件 Key"),
      nodeId: z.string().describe("节点 ID，格式如 '312:33667' 或 '312-33667'"),
      depth: z.number().optional().default(10).describe("递归深度，默认 10"),
      format: z.enum(["condensed-v3", "semantic-json", "condensed-v2", "condensed", "json"]).optional().default("condensed-v3").describe("输出格式。默认 condensed-v3，推荐给 AI 代码生成；semantic-json 返回结构化语义 JSON；condensed-v2 是兼容版去重文本；condensed 是旧版内联文本；json 返回 summary/tree/condensed/condensedV2/condensedV3/semanticJson/artifacts。"),
      maxTokens: z.number().optional().default(4000).describe("兼容参数：当前不会截断输出，完整度由 depth 控制"),
    },
  },
  async ({ fileKey, nodeId, depth, format, maxTokens }) => {
    try {
      const outputFormat = format || "condensed-v3";
      const normalizedId = normalizeNodeId(nodeId);
      const result = await fetchNodeDocument(figma, fileKey, nodeId, depth);
      if (isErrorResponse(result)) return result;
      const nodeData = result.raw;

      const rawPath = tempManager.writeRaw(fileKey, normalizedId, nodeData);

      const simplified = simplifyNode(nodeData.document, 0, depth);
      const summary = generateSummary(simplified);
      const nodeVarMap = buildVariableMapFromNodes(nodeData.document);
      const variables = Object.keys(nodeVarMap).length > 0 ? nodeVarMap : null;
      const condensedVariableMap = toCondensedVariableMap(variables);

      const { svgMap, svgSection } = await exportAndRegisterIcons(svgExporter, tempManager, fileKey, nodeData.document, "get_node");

      if (outputFormat === "semantic-json" || outputFormat === "condensed-v3") {
        const semanticVariables = await loadSemanticVariables(fileKey);
        const semanticVariableMap = semanticVariables.variableMap || condensedVariableMap;
        const semanticOptions = {
          maxDepth: depth,
          variableDefinitions: semanticVariables.definitions,
          variableMap: semanticVariableMap,
          svgMap,
          capabilities: semanticVariables.capabilities,
        };

        if (outputFormat === "semantic-json") {
          const semanticPayload = {
            summary,
            nodeVariables: variables,
            semantic: toSemanticJson(nodeData.document, semanticOptions),
          };
          tempManager.writeOptimized(fileKey, normalizedId, semanticPayload);
          return textResponse(JSON.stringify(semanticPayload, null, 2));
        }

        const condensed = toCondensedV3WithBudget(nodeData.document, maxTokens, {
          ...semanticOptions,
          variableDefinitions: semanticVariables.definitions,
        });
        const condensedV3Path = tempManager.writeCondensedV3(fileKey, normalizedId, condensed);
        tempManager.writeOptimized(fileKey, normalizedId, { summary, condensedV3: condensed, variables, artifacts: { condensedV3Path } });
        return textResponse(`# 节点概览\n${summary.rootName} (${summary.rootType}) ${summary.rootSize}\n节点总数: ${summary.totalNodes}\n\n# 结构 (condensed-v3)\n${condensed}`);
      }

      if (outputFormat === "condensed") {
        const condensed = toCondensedWithBudget(nodeData.document, maxTokens, condensedVariableMap, svgMap, depth);
        tempManager.writeOptimized(fileKey, normalizedId, { summary, condensed });
        tempManager.writeCondensed(fileKey, normalizedId, condensed);
        return textResponse(`# 节点概览\n${summary.rootName} (${summary.rootType}) ${summary.rootSize}\n节点总数: ${summary.totalNodes}\n\n# 结构 (压缩格式)\n${condensed}`);
      }

      if (outputFormat === "condensed-v2") {
        const condensed = toCondensedV2WithBudget(nodeData.document, maxTokens, condensedVariableMap, svgMap, depth);
        tempManager.writeOptimized(fileKey, normalizedId, { summary, condensedV2: condensed });
        tempManager.writeCondensedV2(fileKey, normalizedId, condensed);
        return textResponse(`# 节点概览\n${summary.rootName} (${summary.rootType}) ${summary.rootSize}\n节点总数: ${summary.totalNodes}\n\n# 结构 (condensed-v2)\n${condensed}`);
      }

      const condensed = toCondensedWithBudget(nodeData.document, maxTokens, condensedVariableMap, svgMap, depth);
      const condensedV2 = toCondensedV2WithBudget(nodeData.document, maxTokens, condensedVariableMap, svgMap, depth);
      const semanticVariables = await loadSemanticVariables(fileKey);
      const semanticVariableMap = semanticVariables.variableMap || condensedVariableMap;
      const semanticOptions = {
        maxDepth: depth,
        variableDefinitions: semanticVariables.definitions,
        variableMap: semanticVariableMap,
        svgMap,
        capabilities: semanticVariables.capabilities,
      };
      const semanticJson = toSemanticJson(nodeData.document, semanticOptions);
      const condensedV3 = toCondensedV3WithBudget(nodeData.document, maxTokens, semanticOptions);
      const optimizedPayload = { summary, tree: simplified, condensed, condensedV2, condensedV3, semanticJson, variables };
      const optimizedPath = tempManager.writeOptimized(fileKey, normalizedId, optimizedPayload);
      const condensedPath = tempManager.writeCondensed(fileKey, normalizedId, condensed + svgSection);
      const condensedV2Path = tempManager.writeCondensedV2(fileKey, normalizedId, condensedV2);
      const condensedV3Path = tempManager.writeCondensedV3(fileKey, normalizedId, condensedV3);
      const artifacts = {
        tempDir: tempManager.tempDir,
        rawPath,
        optimizedPath,
        condensedPath,
        condensedV2Path,
        condensedV3Path,
      };
      logger.logOptimized("get_node", { fileKey, nodeId: normalizedId, format: outputFormat }, { summary, variables, artifacts });

      return textResponse(JSON.stringify({
        summary,
        tree: simplified,
        condensed,
        condensedV2,
        condensedV3,
        semanticJson,
        variables,
        artifacts,
        svg: {
          text: svgSection || null,
          exportedCount: Object.keys(svgMap).length,
        },
      }, null, 2));
    } catch (error) { return formatError(error); }
  }
);

/**
 * 工具 4: search_nodes
 * 按名称/类型搜索节点，支持限定搜索范围到某个父节点下
 * 返回匹配节点的 ID、名称、类型和路径，方便后续用 get_node 获取详情
 */
server.registerTool(
  "search_nodes",
  {
    description: "按名称、类型搜索文件中的节点，返回匹配节点的 ID、名称、类型和路径。适合在大文件中快速定位特定组件或元素",
    inputSchema: {
      fileKey: z.string().describe("Figma 文件 Key"),
      query: z.string().optional().describe("名称模糊匹配（不区分大小写）"),
      type: z.string().optional().describe("节点类型过滤，如 FRAME, COMPONENT, TEXT, INSTANCE, COMPONENT_SET 等"),
      parentId: z.string().optional().describe("限定搜索范围到某个父节点下"),
      maxResults: z.number().optional().default(20).describe("最大返回数量，默认 20"),
    },
  },
  async ({ fileKey, query, type, parentId, maxResults }) => {
    try {
      if (!query && !type) {
        return textResponse("请至少提供 query（名称搜索）或 type（类型过滤）参数");
      }

      let rootNode: any;

      if (parentId) {
        const result = await fetchNodeDocument(figma, fileKey, parentId);
        if (isErrorResponse(result)) return result;
        rootNode = result.document;
      } else {
        const data = await figma.getFile(fileKey, {});
        if (!data) return textResponse("获取文件失败");
        rootNode = data.document;
      }

      const results = searchNodes(rootNode, { query, type, maxResults });

      if (results.length === 0) {
        return textResponse("未找到匹配的节点");
      }

      const output = results.map((r, i) =>
        `${i + 1}. [${r.type}] ${r.name} (id: ${r.id})\n   路径: ${r.path}`
      ).join("\n\n");

      return textResponse(`# 搜索结果 (共 ${results.length} 条)\n\n${output}`);
    } catch (error) { return formatError(error); }
  }
);

/**
 * 工具 5: get_components
 * 获取文件中所有组件的列表，返回组件名称、ID、描述等基本信息
 */
server.registerTool(
  "get_components",
  {
    description: "获取文件中所有组件的列表和基本信息",
    inputSchema: {
      fileKey: z.string().describe("Figma 文件 Key"),
    },
  },
  async ({ fileKey }) => {
    try {
      const data = await figma.getFile(fileKey, { depth: 2 });
      if (!data) return textResponse("获取文件失败");

      const componentMap = buildComponentMap(data.document);
      return textResponse(JSON.stringify(componentMap, null, 2));
    } catch (error) { return formatError(error); }
  }
);

/**
 * 工具 6: get_component_variants
 * 获取 COMPONENT_SET 下所有 variant 及其属性组合
 * 对生成组件 Props TypeScript 接口非常有帮助
 */
server.registerTool(
  "get_component_variants",
  {
    description: "获取 COMPONENT_SET 下所有 variant 及其属性组合，对生成组件 props 接口非常有帮助",
    inputSchema: {
      fileKey: z.string().describe("Figma 文件 Key"),
      nodeId: z.string().describe("COMPONENT_SET 的节点 ID"),
    },
  },
  async ({ fileKey, nodeId }) => {
    try {
      const result = await fetchNodeDocument(figma, fileKey, nodeId);
      if (isErrorResponse(result)) return result;
      const node = result.document;

      if (node.type !== "COMPONENT_SET") {
        return textResponse(`节点 ${node.name} 类型为 ${node.type}，不是 COMPONENT_SET。请传入组件集的节点 ID`);
      }

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

      const output: string[] = [
        `# ${node.name}`,
        ``,
        `## 属性定义`,
      ];

      for (const [prop, values] of Object.entries(properties)) {
        output.push(`- **${prop}**: ${[...values].join(" | ")}`);
      }

      output.push(``, `## Variants (${variants.length})`);
      for (const v of variants) {
        const propsStr = Object.entries(v.props).map(([k, val]) => `${k}=${val}`).join(", ");
        output.push(`- ${propsStr} (id: ${v.id})`);
      }

      return textResponse(output.join("\n"));
    } catch (error) { return formatError(error); }
  }
);

/**
 * 工具 7: get_variables
 * 获取文件的 Design Variables（设计变量/token），包含颜色、数值等
 * 需要 Figma 企业版或专业版才能访问 Variables API
 */
server.registerTool(
  "get_variables",
  {
    description: "获取文件的 Variables（设计变量/token），包含颜色、数值等",
    inputSchema: {
      fileKey: z.string().describe("Figma 文件 Key"),
    },
  },
  async ({ fileKey }) => {
    try {
      const data = await figma.getVariables(fileKey);
      if (!data) return textResponse("获取 variables 失败");

      const variables = data.meta?.variables || {};
      const collections = data.meta?.variableCollections || {};

      const result: Record<string, any> = {};
      for (const [collId, coll] of Object.entries(collections) as [string, any][]) {
        const collVars = Object.values(variables)
          .filter((v: any) => v.variableCollectionId === collId)
          .map((v: any) => ({
            name: v.name,
            type: v.resolvedType,
            values: formatVariableValues(v.valuesByMode, coll.modes),
          }));
        result[coll.name] = { modes: coll.modes.map((m: any) => m.name), variables: collVars };
      }

      return textResponse(JSON.stringify(result, null, 2));
    } catch (error) { return formatError(error); }
  }
);

/**
 * 工具 8: get_styles
 * 获取文件中所有已发布的样式定义（颜色、文字、效果、网格）
 * 帮助 AI 理解设计系统，生成一致的代码
 */
server.registerTool(
  "get_styles",
  {
    description: "获取文件中所有样式定义（颜色样式、文字样式、效果样式），对理解设计系统和生成一致的代码非常有帮助",
    inputSchema: {
      fileKey: z.string().describe("Figma 文件 Key"),
    },
  },
  async ({ fileKey }) => {
    try {
      const data = await figma.getFileStyles(fileKey);
      if (!data || !data.meta?.styles) {
        return textResponse("未找到样式定义，该文件可能没有发布的样式");
      }

      const styles = data.meta.styles;
      if (styles.length === 0) {
        return textResponse("该文件没有已发布的样式");
      }

      const grouped: Record<string, any[]> = { FILL: [], TEXT: [], EFFECT: [], GRID: [] };
      for (const style of styles) {
        const group = grouped[style.style_type] || [];
        group.push(style);
        grouped[style.style_type] = group;
      }

      const output: string[] = [`# 文件样式 (共 ${styles.length} 个)\n`];

      if (grouped.FILL.length > 0) {
        output.push(`## 颜色样式 (${grouped.FILL.length})`);
        for (const s of grouped.FILL) {
          output.push(`- ${s.name}${s.description ? ` — ${s.description}` : ""}`);
        }
        output.push("");
      }

      if (grouped.TEXT.length > 0) {
        output.push(`## 文字样式 (${grouped.TEXT.length})`);
        for (const s of grouped.TEXT) {
          output.push(`- ${s.name}${s.description ? ` — ${s.description}` : ""}`);
        }
        output.push("");
      }

      if (grouped.EFFECT.length > 0) {
        output.push(`## 效果样式 (${grouped.EFFECT.length})`);
        for (const s of grouped.EFFECT) {
          output.push(`- ${s.name}${s.description ? ` — ${s.description}` : ""}`);
        }
        output.push("");
      }

      if (grouped.GRID.length > 0) {
        output.push(`## 网格样式 (${grouped.GRID.length})`);
        for (const s of grouped.GRID) {
          output.push(`- ${s.name}${s.description ? ` — ${s.description}` : ""}`);
        }
        output.push("");
      }

      return textResponse(output.join("\n"));
    } catch (error) { return formatError(error); }
  }
);

/**
 * 工具 9: get_node_css
 * 将节点转换为 CSS 或 Tailwind 类名
 * recursive=true 时递归生成整个组件树的样式代码
 */
server.registerTool(
  "get_node_css",
  {
    description: "将节点转换为 CSS 或 Tailwind 类名，支持递归生成整个组件树的样式",
    inputSchema: {
      fileKey: z.string().describe("Figma 文件 Key"),
      nodeId: z.string().describe("节点 ID"),
      mode: z.enum(["css", "tailwind"]).optional().default("css").describe("输出模式：css（标准 CSS）或 tailwind（Tailwind 类名）"),
      recursive: z.boolean().optional().default(false).describe("是否递归生成子节点样式，默认 false"),
    },
  },
  async ({ fileKey, nodeId, mode, recursive }) => {
    try {
      const result = await fetchNodeDocument(figma, fileKey, nodeId);
      if (isErrorResponse(result)) return result;

      let output: string;
      if (mode === "tailwind") {
        output = recursive
          ? nodeToTailwindRecursive(result.document, 0)
          : nodeToTailwind(result.document);
      } else {
        output = recursive
          ? nodeToCSSRecursive(result.document, 0)
          : nodeToCSS(result.document);
      }

      return textResponse(output);
    } catch (error) { return formatError(error); }
  }
);

/**
 * 工具 10: get_images
 * 获取指定节点的图片导出 URL（PNG/SVG/PDF/JPG）
 * 返回 Figma CDN 上的临时 URL，有效期约 14 天
 */
server.registerTool(
  "get_images",
  {
    description: "获取指定节点的图片导出 URL（PNG/SVG/PDF）",
    inputSchema: {
      fileKey: z.string().describe("Figma 文件 Key"),
      nodeIds: z.array(z.string()).describe("节点 ID 数组"),
      format: z.enum(["png", "svg", "pdf", "jpg"]).optional().default("png"),
      scale: z.number().optional().default(2).describe("导出倍率，默认 2x"),
    },
  },
  async ({ fileKey, nodeIds, format, scale }) => {
    try {
      const ids = nodeIds.map((id) => normalizeNodeId(id));
      const data = await figma.getImages(fileKey, ids, format, scale);
      if (!data) return textResponse("获取图片失败");

      return textResponse(JSON.stringify(data.images || {}, null, 2));
    } catch (error) { return formatError(error); }
  }
);

/**
 * 工具 11: export_svg
 * 导出指定节点为 SVG 格式，下载内容并保存到临时目录
 * 同时注册到 icons index，供后续 get_icons_index 查询
 */
server.registerTool(
  "export_svg",
  {
    description: "导出指定节点为 SVG 格式，下载 SVG 内容并保存到临时目录。适用于导出图标、矢量图形等",
    inputSchema: {
      fileKey: z.string().describe("Figma 文件 Key"),
      nodeIds: z.array(z.string()).describe("要导出的节点 ID 数组"),
    },
  },
  async ({ fileKey, nodeIds }) => {
    try {
      const ids = nodeIds.map((id) => normalizeNodeId(id));
      const nodes = ids.map((id) => ({ id, name: id, role: "export" }));

      try {
        const results = await svgExporter.exportNodes(fileKey, nodes);
        if (results.size === 0) {
          return textResponse("未能导出任何 SVG，请检查节点 ID 是否正确");
        }

        const output = svgExporter.formatExportResults(results);
        const iconEntries: any[] = [];
        for (const [nodeIdKey, svgInfo] of results.entries()) {
          iconEntries.push({
            fileKey,
            nodeId: nodeIdKey,
            name: svgInfo.filename || nodeIdKey,
            svgPath: svgInfo.path || null,
            source: "export_svg",
          });
        }
        if (iconEntries.length > 0) tempManager.addIcons(iconEntries);

        logger.logOptimized("export_svg", { fileKey, nodeIds: ids }, { exportedCount: results.size });
        return textResponse(output);
      } catch (e: any) {
        return textResponse(`SVG 导出失败: ${e.message}`);
      }
    } catch (error) { return formatError(error); }
  }
);

/**
 * 工具 12: get_versions
 * 获取文件的版本历史列表，用于了解设计迭代过程
 */
server.registerTool(
  "get_versions",
  {
    description: "获取文件的版本历史列表,包含版本 ID、创建时间、描述等信息",
    inputSchema: {
      fileKey: z.string().describe("Figma 文件 Key"),
    },
  },
  async ({ fileKey }) => {
    try {
      const data = await figma.getFileVersions(fileKey);
      if (!data?.versions?.length) {
        return textResponse("无法获取版本历史或文件无版本记录");
      }
      const lines = data.versions.map((v: any, i: number) =>
        `${i + 1}. [${v.id}] ${v.created_at}${v.label ? ` — "${v.label}"` : ""}${v.description ? ` (${v.description})` : ""} by ${v.user?.handle || "unknown"}`
      );
      return textResponse(`# 版本历史 (共 ${data.versions.length} 个)\n\n${lines.join("\n")}`);
    } catch (error) { return formatError(error); }
  }
);

/**
 * 工具 13: diff_nodes
 * 对比两个节点的差异，支持两种模式：
 * - snapshot：与历史版本对比（通过 Figma 版本 API）
 * - nodes：两个不同节点直接对比
 */
server.registerTool(
  "diff_nodes",
  {
    description: "对比两个节点的差异,或对比同一节点的前后变化。支持 snapshot 模式（通过 Figma 版本历史获取之前的版本进行对比）和 nodes 模式（两个不同节点直接对比）",
    inputSchema: {
      fileKey: z.string().describe("Figma 文件 Key"),
      nodeId: z.string().describe("要对比的节点 ID"),
      mode: z.enum(["snapshot", "nodes"]).optional().default("nodes").describe("对比模式:snapshot（与历史版本对比）或 nodes（两节点对比,默认）"),
      targetNodeId: z.string().optional().describe("mode=nodes 时必填,对比目标节点 ID"),
      targetFileKey: z.string().optional().describe("跨文件对比时的目标文件 Key,默认与 fileKey 相同"),
      versionId: z.string().optional().describe("mode=snapshot 时可选,指定要对比的历史版本 ID。不传则自动使用上一个版本"),
      depth: z.number().optional().default(3).describe("对比递归深度,默认 3"),
    },
  },
  async ({ fileKey, nodeId, mode, targetNodeId, targetFileKey, versionId, depth }) => {
    try {
      const normalizedId = normalizeNodeId(nodeId);

      if (mode === "snapshot") {
      const versionsData = await figma.getFileVersions(fileKey);
      if (!versionsData?.versions?.length) {
        return textResponse("无法获取文件版本历史");
      }

      const versions = versionsData.versions;
        let previousVersionId: string;

        if (versionId) {
          previousVersionId = versionId;
        } else {
          if (versions.length < 2) {
            return textResponse("文件只有一个版本,无历史可对比");
          }
          previousVersionId = versions[1].id;
        }

        const [currentData, previousData] = await Promise.all([
          figma.getFileNodes(fileKey, [normalizedId]),
          figma.getFileNodes(fileKey, [normalizedId], previousVersionId),
        ]);

        if (!currentData?.nodes?.[normalizedId]) {
          return textResponse(`当前版本中节点 ${normalizedId} 不存在`);
        }
        if (!previousData?.nodes?.[normalizedId]) {
          return textResponse(`历史版本中节点 ${normalizedId} 不存在（可能是新增节点）`);
        }

        const nodeA = previousData.nodes[normalizedId].document;
        const nodeB = currentData.nodes[normalizedId].document;

        const entries = diffNodes(nodeA, nodeB, depth);
        const output = formatDiffOutput(entries);

        const versionInfo = versions.find((v: any) => v.id === previousVersionId);
        const versionLabel = versionInfo?.label || versionInfo?.created_at || previousVersionId;

        return textResponse(`# 节点变化: ${nodeB.name} (${normalizedId})\n\n对比版本: ${versionLabel} → 当前\n\n${output}`);
      }

      const dataA = await figma.getFileNodes(fileKey, [normalizedId]);
      if (!dataA?.nodes?.[normalizedId]) {
        return textResponse(`节点 ${normalizedId} 不存在`);
      }
      const nodeA = dataA.nodes[normalizedId].document;

      if (!targetNodeId) {
        return textResponse("nodes 模式需要提供 targetNodeId 参数");
      }

      const normalizedTargetId = normalizeNodeId(targetNodeId);
      const targetFile = targetFileKey || fileKey;
      const dataB = await figma.getFileNodes(targetFile, [normalizedTargetId]);
      if (!dataB?.nodes?.[normalizedTargetId]) {
        return textResponse(`目标节点 ${normalizedTargetId} 不存在`);
      }

      const nodeB = dataB.nodes[normalizedTargetId].document;
      const entries = diffNodes(nodeA, nodeB, depth);
      const output = formatDiffOutput(entries);

      return textResponse(`# 节点对比\n## A: ${nodeA.name} (${normalizedId})\n## B: ${nodeB.name} (${normalizedTargetId})\n\n${output}`);
    } catch (error) { return formatError(error); }
  }
);

/**
 * 工具 14: get_icons_index
 * 获取当前会话中已导出的所有图标/SVG 的汇总索引
 * 这是一个会话级累积的工具，每次 export_svg 或 get_node 导出图标后自动更新
 */
server.registerTool(
  "get_icons_index",
  {
    description: "获取当前会话中已导出的所有图标/SVG 的汇总索引",
  },
  async () => {
    const index = tempManager.getIconsIndex();
    if (index.icons.length === 0) {
      return textResponse("当前会话尚未导出任何图标。使用 get_node 或 export_svg 工具导出图标后，索引会自动更新。");
    }
    return textResponse(JSON.stringify(index, null, 2));
  }
);

/**
 * 工具 15: get_page_for_codegen
 * 一站式获取代码生成所需的完整上下文：
 * 压缩格式结构 + design tokens + 组件定义 + 颜色/字体规范 + SVG 图标
 * 减少 LLM 多轮调用，一次拿全所有信息
 */
server.registerTool(
  "get_page_for_codegen",
  {
    description: "一站式获取代码生成所需的完整上下文：压缩格式结构 + design tokens + 组件定义 + 颜色/字体规范",
    inputSchema: {
      fileKey: z.string().describe("Figma 文件 Key"),
      nodeId: z.string().describe("目标节点/页面 ID"),
      depth: z.number().optional().default(12).describe("递归深度，默认 12"),
    },
  },
  async ({ fileKey, nodeId, depth }) => {
    try {
      const normalizedId = normalizeNodeId(nodeId);

      const [nodeResult, varsResult] = await Promise.all([
        figma.getFileNodes(fileKey, [normalizedId]),
        figma.getVariables(fileKey).catch(() => null),
      ]);

      if (!nodeResult) return textResponse("获取节点失败");
      const nodeData = nodeResult.nodes[normalizedId];
      if (!nodeData) return textResponse(`节点 ${normalizedId} 不存在`);

      tempManager.writeRaw(fileKey, normalizedId, nodeData);

      const node = nodeData.document;
      const variableMap = varsResult ? buildVariableMap(varsResult) : null;
      const structure = toCondensedFormat(node, 0, depth, variableMap);

      const colors = new Set<string>();
      const fonts = new Set<string>();
      const components: { name: string; componentId: string }[] = [];
      extractDesignInfo(node, colors, fonts, components);

      let tokensSummary = "";
      if (varsResult && varsResult.meta) {
        const collections = varsResult.meta.variableCollections || {};
        const variables = varsResult.meta.variables || {};
        const tokenLines: string[] = [];
        for (const [collId, coll] of Object.entries(collections) as [string, any][]) {
          const collVars = (Object.values(variables) as any[])
            .filter((v) => v.variableCollectionId === collId)
            .slice(0, 30);
          tokenLines.push(`## ${coll.name}`);
          for (const v of collVars) {
            const firstMode = Object.values(v.valuesByMode || {})[0];
            tokenLines.push(`  --${v.name}: ${formatValue(firstMode)}`);
          }
        }
        tokensSummary = tokenLines.join("\n");
      }

      const output: string[] = [
        `# 代码生成上下文`,
        `## 目标: ${node.name} (${node.type})`,
        ``,
        `## 结构`,
        structure,
        `## 使用的颜色`,
        [...colors].join(", "),
        ``,
        `## 使用的字体`,
        [...fonts].join(", "),
        ``,
      ];

      if (components.length > 0) {
        output.push(`## 引用的组件`);
        output.push(components.map((c) => `- ${c.name} (${c.componentId})`).join("\n"));
        output.push(``);
      }

      if (tokensSummary) {
        output.push(`## Design Tokens`);
        output.push(tokensSummary);
      }

      const { svgSection } = await exportAndRegisterIcons(svgExporter, tempManager, fileKey, node, "get_page_for_codegen");
      if (svgSection) output.push(svgSection);

      tempManager.writeOptimized(fileKey, normalizedId, {
        nodeName: node.name,
        nodeType: node.type,
        structure,
        colors: [...colors],
        fonts: [...fonts],
        components,
        tokens: tokensSummary || null,
      });

      logger.logOptimized("get_page_for_codegen", { fileKey, nodeId: normalizedId }, { nodeType: node.type, nodeName: node.name });

      return textResponse(output.join("\n"));
    } catch (error) { return formatError(error); }
  }
);

// ==================== 启动 MCP 服务 ====================
// 使用 stdio 传输层：通过 stdin/stdout 与 MCP Client 通信
// Client（如 Claude Desktop）spawn 本进程后，通过管道交换 JSON-RPC 消息
const transport = new StdioServerTransport();
await server.connect(transport);

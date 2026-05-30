/**
 * MCP 工具共享工具函数
 *
 * 提供 14 个工具 handler 的公共逻辑：
 * - textResponse: 统一 MCP 响应格式
 * - normalizeNodeId: 节点 ID 格式规范化（dash → colon）
 * - formatError: 错误信息中文化 + 分类处理
 * - fetchNodeDocument: 获取单个节点文档的通用流程
 * - exportAndRegisterIcons: SVG 导出 + 图标索引注册
 */

import { FigmaClient, FigmaApiError } from "../figma-client.js";
import type { FigmaNodesResponse, FigmaNode } from "../figma-client.js";
import { TempManager } from "../temp-manager.js";
import type { IconEntry } from "../temp-manager.js";
import { SvgExporter } from "../svg-exporter.js";
import type { CondensedSvgMap } from "../transformer.js";

/** MCP 工具的标准响应类型 */
export type McpToolResponse = { content: Array<{ type: "text"; text: string }> };

/** 将文本包装为 MCP 标准响应格式 */
export function textResponse(text: string): McpToolResponse {
  return { content: [{ type: "text" as const, text }] };
}

/**
 * 规范化节点 ID：将 URL 中的 dash 格式（1-2）转为 Figma API 要求的 colon 格式（1:2）
 * Figma URL 中用 dash 是因为 colon 在 URL 中是特殊字符
 */
export function normalizeNodeId(id: string): string {
  return id.replace(/-/g, ":");
}

/**
 * 统一错误处理：将各种错误转为中文友好的 MCP 响应
 * - 401/403 → token 无效提示
 * - 404 → 文件/节点不存在
 * - 429 → 限流提示
 * - 5xx → 服务端错误
 * - 网络错误 → 连接失败提示
 */
export function formatError(error: unknown): McpToolResponse {
  if (error instanceof FigmaApiError) {
    const status = error.status;
    let message: string;
    if (status === 401 || status === 403) {
      message = "Figma token 无效或无权限访问此文件，请检查 FIGMA_TOKEN 配置";
    } else if (status === 404) {
      message = "文件或节点不存在，请检查 fileKey 和 nodeId 是否正确";
    } else if (status === 429) {
      message = "Figma API 请求过于频繁，已重试多次仍失败，请稍后再试";
    } else if (status >= 500) {
      message = `Figma API 服务端错误 (${status})，请稍后重试`;
    } else {
      message = `Figma API 错误 (${status}): ${error.message}`;
    }
    return textResponse(message);
  }

  if (error instanceof Error) {
    if (error.message.includes("fetch") || error.message.includes("ECONNREFUSED") || error.message.includes("ETIMEDOUT")) {
      return textResponse("无法连接 Figma API，请检查网络连接");
    }
    return textResponse(`操作失败: ${error.message}`);
  }

  return textResponse("发生未知错误");
}

/**
 * 获取单个节点的文档数据
 * 统一处理 ID 规范化、API 调用、空值检查
 * 返回值是联合类型：成功返回 document，失败返回 McpToolResponse（错误信息）
 */
export async function fetchNodeDocument(
  figma: FigmaClient,
  fileKey: string,
  nodeId: string,
  depth?: number
): Promise<{ document: FigmaNode; raw: NonNullable<FigmaNodesResponse["nodes"][string]> } | McpToolResponse> {
  const normalizedId = normalizeNodeId(nodeId);
  const data = await figma.getFileNodes(fileKey, [normalizedId], undefined, depth);
  if (!data) return textResponse("获取节点失败");
  const nodeData = data.nodes[normalizedId];
  if (!nodeData) return textResponse(`节点 ${normalizedId} 不存在`);
  return { document: nodeData.document, raw: nodeData };
}

/** 类型守卫：判断返回值是否为错误响应（用于 fetchNodeDocument 的结果判断） */
export function isErrorResponse(result: any): result is McpToolResponse {
  return result && "content" in result && Array.isArray(result.content);
}

/**
 * 导出节点中的可导出图标并注册到 icons index
 * 流程：检测可导出节点 → 调用 Figma Images API 获取 SVG URL → 下载保存 → 注册索引
 */
export async function exportAndRegisterIcons(
  svgExporter: SvgExporter,
  tempManager: TempManager,
  fileKey: string,
  node: any,
  source: string
): Promise<{ svgMap: CondensedSvgMap; svgSection: string }> {
  const svgMap: CondensedSvgMap = {};
  let svgSection = "";

  const exportableNodes = svgExporter.detectExportableNodes(node);
  if (exportableNodes.length === 0) return { svgMap, svgSection };

  try {
    const svgResults = await svgExporter.exportNodes(fileKey, exportableNodes);
    svgSection = svgExporter.formatExportResults(svgResults);
    const iconEntries: IconEntry[] = [];
    for (const [nodeIdKey, svgInfo] of svgResults.entries()) {
      svgMap[nodeIdKey] = {
        filename: svgInfo.filename,
        path: svgInfo.path,
      };
      iconEntries.push({
        fileKey,
        nodeId: nodeIdKey,
        name: svgInfo.filename || nodeIdKey,
        svgPath: svgInfo.path || null,
        source,
      });
    }
    if (iconEntries.length > 0) tempManager.addIcons(iconEntries);
  } catch (e: any) {
    svgSection = `\n## SVG Export Error\n${e.message}`;
  }

  return { svgMap, svgSection };
}

import { FigmaClient, FigmaApiError } from "../figma-client.js";
import type { FigmaNodesResponse, FigmaNode } from "../figma-client.js";
import { TempManager } from "../temp-manager.js";
import type { IconEntry } from "../temp-manager.js";
import { SvgExporter } from "../svg-exporter.js";
import type { CondensedSvgMap } from "../transformer.js";

export type McpToolResponse = { content: Array<{ type: "text"; text: string }> };

export function textResponse(text: string): McpToolResponse {
  return { content: [{ type: "text" as const, text }] };
}

export function normalizeNodeId(id: string): string {
  return id.replace(/-/g, ":");
}

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

export function isErrorResponse(result: any): result is McpToolResponse {
  return result && "content" in result && Array.isArray(result.content);
}

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

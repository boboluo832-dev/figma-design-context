/**
 * SVG 导出器
 *
 * 职责：
 * 1. 检测节点树中可导出为 SVG 的图标/矢量图形
 * 2. 调用 Figma Images API 获取 SVG 下载 URL
 * 3. 下载 SVG 内容并保存到临时目录
 *
 * 图标检测策略：
 * - 矢量类型节点（VECTOR, LINE, STAR, ELLIPSE 等）
 * - 名称匹配图标模式（icon*, arrow, chevron 等）
 * - 尺寸在常见图标尺寸范围内（4px ~ 96px）
 * - 组件实例中的图标引用
 */

import { FigmaClient } from "./figma-client.js";
import { TempManager } from "./temp-manager.js";

/** 矢量类型节点集合 — 这些类型本身就是可导出的图形 */
const VECTOR_TYPES = new Set([
  "VECTOR",
  "LINE",
  "STAR",
  "REGULAR_POLYGON",
  "BOOLEAN_OPERATION",
  "ELLIPSE",
]);

/** 可作为图标容器的节点类型 */
const ICON_CONTAINER_TYPES = new Set(["COMPONENT", "FRAME", "INSTANCE"]);
/** 图标名称匹配正则（支持中英文） */
const ICON_PATTERN = /^(icon.*|ico(\b|[\/_\-\s]|$)|icons?(\b|[\/_\-\s]|$)|basics(\b|[\/_\-\s]|$)|(arrow|chevron|caret)(\b|[\/_\-\s]|$)|(edit|calendar|time|user|help|error|close|search|plus|minus|check)(\b|[\/_\-\s]|$)|用户[-_\s]?\d*)|(^|[\/_.\-\s])icon($|[\/_.\-\s])|图标/i;
/** 实例节点的图标名称匹配（比 ICON_PATTERN 多了 module 关键词） */
const ICON_INSTANCE_PATTERN = /^(icon.*|ico(\b|[\/_\-\s]|$)|icons?(\b|[\/_\-\s]|$)|basics(\b|[\/_\-\s]|$)|module(\b|[\/_\-\s]|$)|(arrow|chevron|caret)(\b|[\/_\-\s]|$)|(edit|calendar|time|user|help|error|close|search|plus|minus|check)(\b|[\/_\-\s]|$)|用户[-_\s]?\d*)|(^|[\/_.\-\s])icon($|[\/_.\-\s])|图标/i;
/** 图标集合名称匹配 */
const ICON_COLLECTION_PATTERN = /^(icons?.*|icon.*(set|library|collection)|basics(\b|[\/_\-\s]|$))|图标/i;
const MAX_EXPORT_NODES = 20;           // 单次最多导出节点数
const MAX_INLINE_SIZE = 10 * 1024;     // SVG 内联显示的最大字节数（10KB）
const SVG_DOWNLOAD_TIMEOUT_MS = 15000; // SVG 下载超时（15s）
const MAX_ICON_DIMENSION = 96;         // 图标最大尺寸（超过则不视为图标）
const ICON_SIZE_TOLERANCE = 1;         // 尺寸匹配容差（px）
/** 常见图标尺寸列表，用于判断节点是否为图标 */
const COMMON_ICON_SIZES = [
  4,
  8,
  12,
  14,
  16,
  18,
  20,
  22,
  24,
  28,
  32,
  36,
  40,
  44,
  48,
  64,
];

export interface ExportableNode {
  id: string;
  name: string;
  role: string;
  exportId?: string;
}

export interface SvgResult {
  path: string;
  content: string;
  filename: string;
  inline: boolean;
}

export interface DetectExportableOptions {
  maxResults?: number;
  includeVectorNodes?: boolean;
  includeIconInstances?: boolean;
  dedupeComponentInstances?: boolean;
  requireCommonIconSize?: boolean;
}

export interface FigmaNode {
  id: string;
  name?: string;
  type?: string;
  visible?: boolean;
  children?: FigmaNode[];
  exportSettings?: unknown[];
  componentId?: string;
  absoluteBoundingBox?: { x?: number; y?: number; width?: number; height?: number };
  [key: string]: unknown;
}

/**
 * SVG 导出器类
 * 负责检测可导出的图标节点、调用 Figma API 获取 SVG、保存到本地
 */
export class SvgExporter {
  private figma: FigmaClient;
  private tempManager: TempManager;

  constructor(figmaClient: FigmaClient, tempManager: TempManager) {
    this.figma = figmaClient;
    this.tempManager = tempManager;
  }

  /**
   * 检测节点树中可导出为 SVG 的图标节点
   * 递归遍历，按名称/类型/尺寸等规则判断，达到 maxResults 后停止
   */
  detectExportableNodes(node: FigmaNode, depth: number = 0, options: DetectExportableOptions = {}): ExportableNode[] {
    const maxResults = options.maxResults || MAX_EXPORT_NODES;
    const results: ExportableNode[] = [];
    if (!node) return results;

    this._detect(node, results, {
      depth,
      inIconCollection: false,
      maxResults,
      includeVectorNodes: options.includeVectorNodes ?? false,
      includeIconInstances: options.includeIconInstances ?? true,
      dedupeComponentInstances: options.dedupeComponentInstances ?? true,
      requireCommonIconSize: options.requireCommonIconSize ?? true,
      seenComponentIds: new Set<string>(),
      seenFallbackKeys: new Set<string>(),
    });

    return results;
  }

  private _detect(
    node: FigmaNode,
    results: ExportableNode[],
    state: {
      depth: number;
      inIconCollection: boolean;
      maxResults: number;
      includeVectorNodes: boolean;
      includeIconInstances: boolean;
      dedupeComponentInstances: boolean;
      requireCommonIconSize: boolean;
      seenComponentIds: Set<string>;
      seenFallbackKeys: Set<string>;
    }
  ): void {
    if (!node || results.length >= state.maxResults || node.visible === false) return;

    const isCollection = this._isIconCollection(node);
    const inIconCollection = state.inIconCollection || isCollection;
    const shouldExport = isCollection ? null : this._shouldExport(node, state, inIconCollection);

    if (shouldExport) {
      if (state.dedupeComponentInstances && this._wasAlreadyDetected(node, state)) return;
      results.push({
        id: node.id,
        name: node.name || "unnamed",
        role: shouldExport,
        exportId: this._getExportId(node),
      });
      return;
    }

    if (!node.children) return;

    for (const child of node.children) {
      this._detect(child, results, {
        depth: state.depth + 1,
        inIconCollection,
        maxResults: state.maxResults,
        includeVectorNodes: state.includeVectorNodes,
        includeIconInstances: state.includeIconInstances,
        dedupeComponentInstances: state.dedupeComponentInstances,
        requireCommonIconSize: state.requireCommonIconSize,
        seenComponentIds: state.seenComponentIds,
        seenFallbackKeys: state.seenFallbackKeys,
      });
      if (results.length >= state.maxResults) break;
    }
  }

  /** 判断节点是否应该导出，返回角色标识或 null */
  private _shouldExport(
    node: FigmaNode,
    state: { depth: number; includeVectorNodes: boolean; includeIconInstances: boolean; requireCommonIconSize: boolean },
    inIconCollection: boolean
  ): string | null {
    const isInternalInstanceNode = Boolean(node.id && node.id.includes(";"));
    const isIconContainer = this._isLikelyIconContainer(node, state.requireCommonIconSize);
    const isVectorNode = Boolean(node.type && VECTOR_TYPES.has(node.type));
    const hasIconName = Boolean(node.name && ICON_PATTERN.test(node.name));
    const hasIconInstanceName = Boolean(node.name && ICON_INSTANCE_PATTERN.test(node.name));

    if (isInternalInstanceNode && !(state.includeIconInstances && isIconContainer && hasIconInstanceName)) {
      return null;
    }

    if (node.exportSettings && Array.isArray(node.exportSettings)) {
      const hasSvgExport = node.exportSettings.some(
        (s: any) => s.format === "SVG"
      );
      if (hasSvgExport) return "export-marked";
    }

    if (state.includeIconInstances && isIconContainer && hasIconInstanceName) {
      return "icon";
    }

    if (!isVectorNode && hasIconName && this._hasIconSizedBounds(node, state.requireCommonIconSize)) return "icon";

    if (inIconCollection && isIconContainer) return "icon";

    if (
      state.includeVectorNodes &&
      node.type &&
      VECTOR_TYPES.has(node.type) &&
      this._hasIconSizedBounds(node, state.requireCommonIconSize)
    ) {
      return "vector";
    }

    return null;
  }

  /** 去重检查：同一 componentId 或相同名称+类型+尺寸的节点只导出一次 */
  private _wasAlreadyDetected(
    node: FigmaNode,
    state: { seenComponentIds: Set<string>; seenFallbackKeys: Set<string> }
  ): boolean {
    const componentId = typeof node.componentId === "string" ? node.componentId : "";
    if (componentId) {
      if (state.seenComponentIds.has(componentId)) return true;
      state.seenComponentIds.add(componentId);
      return false;
    }

    const bbox = node.absoluteBoundingBox;
    const width = bbox ? Math.round(Number(bbox.width || 0)) : 0;
    const height = bbox ? Math.round(Number(bbox.height || 0)) : 0;
    const fallbackKey = `${node.name || ""}:${node.type || ""}:${width}x${height}`;
    if (state.seenFallbackKeys.has(fallbackKey)) return true;
    state.seenFallbackKeys.add(fallbackKey);
    return false;
  }

  /** 判断节点是否为图标集合（如 "Icons" frame，包含多个子图标） */
  private _isIconCollection(node: FigmaNode): boolean {
    if (!node.name || !node.children || node.children.length === 0) return false;
    if (!ICON_COLLECTION_PATTERN.test(node.name.trim())) return false;

    const bbox = node.absoluteBoundingBox as { width?: number; height?: number } | undefined;
    if (!bbox) return true;

    const width = Number(bbox.width || 0);
    const height = Number(bbox.height || 0);
    return Math.max(width, height) > 256 || node.children.length > 8;
  }

  /** 判断节点是否像图标容器（COMPONENT/FRAME/INSTANCE + 有子节点 + 图标尺寸） */
  private _isLikelyIconContainer(node: FigmaNode, requireCommonIconSize: boolean = false): boolean {
    if (!node.type || !ICON_CONTAINER_TYPES.has(node.type)) return false;
    if (!node.children || node.children.length === 0) return false;

    return this._hasIconSizedBounds(node, requireCommonIconSize);
  }

  /** 判断节点尺寸是否在图标范围内（正方形、≤96px） */
  private _hasIconSizedBounds(node: FigmaNode, requireCommonIconSize: boolean = false): boolean {
    const bbox = node.absoluteBoundingBox;
    if (!bbox) return false;

    const width = Number(bbox.width || 0);
    const height = Number(bbox.height || 0);
    if (width <= 0 || height <= 0) return false;
    if (Math.abs(width - height) > ICON_SIZE_TOLERANCE) return false;
    if (Math.max(width, height) > MAX_ICON_DIMENSION) return false;
    if (requireCommonIconSize && !this._isCommonIconSize(width, height)) return false;

    return true;
  }

  /** 判断尺寸是否匹配常见图标尺寸（4/8/12/.../64px） */
  private _isCommonIconSize(width: number, height: number): boolean {
    return COMMON_ICON_SIZES.some((size) => (
      Math.abs(width - size) <= ICON_SIZE_TOLERANCE &&
      Math.abs(height - size) <= ICON_SIZE_TOLERANCE
    ));
  }

  /** 获取导出 ID：对于实例节点内部子节点，使用其 componentId 作为导出标识 */
  private _getExportId(node: FigmaNode): string | undefined {
    if (node.id && node.id.includes(";") && typeof node.componentId === "string") {
      return node.componentId;
    }
    return undefined;
  }

  /**
   * 批量导出节点为 SVG
   * 流程：收集节点 ID → 调用 Figma Images API 获取 SVG URL → 并发下载 → 保存到本地
   */
  async exportNodes(
    fileKey: string,
    nodes: ExportableNode[]
  ): Promise<Map<string, SvgResult>> {
    const results = new Map<string, SvgResult>();
    if (nodes.length === 0) return results;

    const nodeIds = Array.from(new Set(nodes.flatMap((n) => (
      n.exportId && n.exportId !== n.id ? [n.exportId, n.id] : [n.id]
    ))));

    const imagesData = (await this.figma.getImages(fileKey, nodeIds, "svg", 1)) as {
      images?: Record<string, string>;
    };
    const images = imagesData?.images || {};

    const downloads = nodes.map(async (nodeInfo) => {
      const candidateIds = nodeInfo.exportId && nodeInfo.exportId !== nodeInfo.id
        ? [nodeInfo.exportId, nodeInfo.id]
        : [nodeInfo.id];
      const url = candidateIds.map((id) => images[id]).find(Boolean);
      if (!url) return;
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), SVG_DOWNLOAD_TIMEOUT_MS);
        let resp: Response;
        try {
          resp = await fetch(url, { signal: controller.signal });
        } finally {
          clearTimeout(timeout);
        }
        if (!resp.ok) return;
        const svgContent = await resp.text();

        if (!svgContent || svgContent.trim().length === 0) {
          console.error(`[svg-exporter] Empty SVG content for ${nodeInfo.id}, skipping`);
          return;
        }

        const filename = this._buildFilename(nodeInfo);

        const filePath = this.tempManager.writeSvg(filename, svgContent);

        results.set(nodeInfo.id, {
          path: filePath,
          content: svgContent,
          filename,
          inline: svgContent.length <= MAX_INLINE_SIZE,
        });
      } catch (err: any) {
        console.error(`[svg-exporter] Download error for ${nodeInfo.id}:`, err.message);
      }
    });

    await Promise.all(downloads);
    return results;
  }

  /** 构建 SVG 文件名：role-name_id.svg（特殊字符替换为 dash） */
  private _buildFilename(nodeInfo: ExportableNode): string {
    const role = nodeInfo.role || "asset";
    const name = (nodeInfo.name || "unnamed")
      .replace(/[^a-zA-Z0-9一-鿿_-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40);
    const id = nodeInfo.id.replace(/[:.;]/g, "-");
    return `${role}-${name}_${id}.svg`;
  }

  /** 格式化导出结果为 Markdown 文本（小文件内联显示 SVG 代码，大文件只显示路径） */
  formatExportResults(results: Map<string, SvgResult>): string {
    if (!results || results.size === 0) return "";

    let output = "\n\n# Exported SVGs\n";
    for (const [nodeId, info] of results) {
      output += `\n## ${info.filename} (${nodeId})\n`;
      output += `Path: ${info.path}\n`;
      if (info.inline) {
        output += `\`\`\`svg\n${info.content}\n\`\`\`\n`;
      } else {
        output += `(SVG content too large to inline, see file)\n`;
      }
    }
    return output;
  }
}

import { FigmaClient } from "./figma-client.js";
import { TempManager } from "./temp-manager.js";

const VECTOR_TYPES = new Set([
  "VECTOR",
  "LINE",
  "STAR",
  "REGULAR_POLYGON",
  "BOOLEAN_OPERATION",
  "ELLIPSE",
]);

const ICON_CONTAINER_TYPES = new Set(["COMPONENT", "FRAME", "INSTANCE"]);
const ICON_PATTERN = /^(icon.*|ico(\b|[\/_\-\s]|$)|icons?(\b|[\/_\-\s]|$)|basics(\b|[\/_\-\s]|$)|(arrow|chevron|caret)(\b|[\/_\-\s]|$)|(edit|calendar|time|user|help|error|close|search|plus|minus|check)(\b|[\/_\-\s]|$)|用户[-_\s]?\d*)|(^|[\/_.\-\s])icon($|[\/_.\-\s])|图标/i;
const ICON_INSTANCE_PATTERN = /^(icon.*|ico(\b|[\/_\-\s]|$)|icons?(\b|[\/_\-\s]|$)|basics(\b|[\/_\-\s]|$)|module(\b|[\/_\-\s]|$)|(arrow|chevron|caret)(\b|[\/_\-\s]|$)|(edit|calendar|time|user|help|error|close|search|plus|minus|check)(\b|[\/_\-\s]|$)|用户[-_\s]?\d*)|(^|[\/_.\-\s])icon($|[\/_.\-\s])|图标/i;
const ICON_COLLECTION_PATTERN = /^(icons?.*|icon.*(set|library|collection)|basics(\b|[\/_\-\s]|$))|图标/i;
const MAX_EXPORT_NODES = 20;
const MAX_INLINE_SIZE = 10 * 1024;
const SVG_DOWNLOAD_TIMEOUT_MS = 15000;
const MAX_ICON_DIMENSION = 96;
const ICON_SIZE_TOLERANCE = 1;
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

export class SvgExporter {
  private figma: FigmaClient;
  private tempManager: TempManager;

  constructor(figmaClient: FigmaClient, tempManager: TempManager) {
    this.figma = figmaClient;
    this.tempManager = tempManager;
  }

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

  private _isIconCollection(node: FigmaNode): boolean {
    if (!node.name || !node.children || node.children.length === 0) return false;
    if (!ICON_COLLECTION_PATTERN.test(node.name.trim())) return false;

    const bbox = node.absoluteBoundingBox as { width?: number; height?: number } | undefined;
    if (!bbox) return true;

    const width = Number(bbox.width || 0);
    const height = Number(bbox.height || 0);
    return Math.max(width, height) > 256 || node.children.length > 8;
  }

  private _isLikelyIconContainer(node: FigmaNode, requireCommonIconSize: boolean = false): boolean {
    if (!node.type || !ICON_CONTAINER_TYPES.has(node.type)) return false;
    if (!node.children || node.children.length === 0) return false;

    return this._hasIconSizedBounds(node, requireCommonIconSize);
  }

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

  private _isCommonIconSize(width: number, height: number): boolean {
    return COMMON_ICON_SIZES.some((size) => (
      Math.abs(width - size) <= ICON_SIZE_TOLERANCE &&
      Math.abs(height - size) <= ICON_SIZE_TOLERANCE
    ));
  }

  private _getExportId(node: FigmaNode): string | undefined {
    if (node.id && node.id.includes(";") && typeof node.componentId === "string") {
      return node.componentId;
    }
    return undefined;
  }

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

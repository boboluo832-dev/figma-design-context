/**
 * Debug Web Server — 本地调试用 HTTP 服务
 *
 * 提供一个 Web UI 用于可视化调试 Figma 数据转换流程：
 * - 输入 Figma URL/Token → 查看 raw/optimized/condensed 各格式输出
 * - 预览检测到的图标并导出 SVG
 * - 下载所有图标为 ZIP 包
 *
 * 路由：
 * - GET  /                    → 调试页面 HTML
 * - GET  /api/health          → 健康检查
 * - GET  /api/icons           → 已导出图标索引
 * - GET  /api/icons.zip       → 打包下载所有 SVG
 * - POST /api/inspect         → 核心：获取并转换 Figma 节点数据
 * - POST /api/export-icons    → 导出指定图标为 SVG
 * - POST /api/reset           → 清空临时文件
 * - GET  /debug-assets/svg/*  → 静态 SVG 文件服务
 *
 * 启动方式：npx tsx src/debug-server.ts（默认端口 3333，自动递增寻找可用端口）
 */

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FigmaClient, FigmaApiError } from "./figma-client.js";
import { parseFigmaUrl } from "./helpers.js";
import {
  buildVariableMapFromNodes,
  buildSemanticVariableDefinitions,
  semanticDefinitionsToVariableMap,
  type CondensedSvgMap,
  type CondensedVariableMap,
  type SemanticCapabilities,
  generateSummary,
  simplifyNode,
  toCondensedV3WithBudget,
  toCondensedWithBudget,
  toCondensedV2WithBudget,
  toSemanticJson,
} from "./transformer.js";
import { TempManager } from "./temp-manager.js";
import { SvgExporter } from "./svg-exporter.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const WEB_ROOT = path.join(PROJECT_ROOT, "debug-web"); // 静态 HTML 页面目录
const HOST = "127.0.0.1";
const DEFAULT_PORT = parseInt(process.env.DEBUG_WEB_PORT || "3333", 10);
const MAX_BODY_SIZE = 1024 * 1024;       // 请求体最大 1MB
const PREVIEW_CHAR_LIMIT = 120_000;      // JSON 预览截断阈值

// debug server 使用独立的 TempManager 实例（始终开启 debug 模式）
const tempManager = new TempManager(undefined, true, process.env.FIGMA_TEMP_DIR);
tempManager.ensure();

/** /api/inspect 请求体 */
interface InspectRequest {
  token?: string;
  url?: string;
  fileKey?: string;
  nodeId?: string;
  depth?: number;
  maxTokens?: number;
  exportIcons?: boolean;
}

/** /api/export-icons 请求体 */
interface ExportIconsRequest {
  token?: string;
  fileKey?: string;
  icons?: Array<{ id?: string; nodeId?: string; name?: string; role?: string; exportId?: string }>;
}

interface ResolvedTarget {
  fileKey: string;
  nodeId?: string;
}

function normalizeNodeId(nodeId: string | undefined): string | undefined {
  if (!nodeId) return undefined;
  return decodeURIComponent(nodeId.trim()).replace(/-/g, ":");
}

/** 从 URL 或 fileKey+nodeId 解析出目标 */
export function resolveTarget(input: InspectRequest): ResolvedTarget {
  const fromUrl = input.url ? parseFigmaUrl(input.url.trim()) : null;
  const fileKey = (input.fileKey || fromUrl?.fileKey || "").trim();
  const nodeId = normalizeNodeId(input.nodeId || fromUrl?.nodeId);

  if (!fileKey) {
    throw new Error("请输入 Figma URL 或 fileKey");
  }

  return { fileKey, nodeId };
}

/** 读取 HTTP 请求体（限制最大 1MB，防止内存溢出） */
function getRequestBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > MAX_BODY_SIZE) {
        req.destroy();
        reject(new Error("请求体过大"));
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

/** JSON 响应辅助 */
function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  const payload = JSON.stringify(data);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(payload);
}

function sendText(res: http.ServerResponse, status: number, text: string, contentType = "text/plain; charset=utf-8"): void {
  res.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store",
  });
  res.end(text);
}

function sendBinary(res: http.ServerResponse, status: number, data: Buffer, headers: Record<string, string>): void {
  res.writeHead(status, {
    "cache-control": "no-store",
    ...headers,
  });
  res.end(data);
}

/** 将错误转为统一的 JSON 响应格式 */
export function errorPayload(error: unknown): { message: string; status?: number } {
  if (error instanceof FigmaApiError) {
    return { message: error.message, status: error.status };
  }
  if (error instanceof Error) {
    return { message: error.message };
  }
  return { message: String(error) };
}

/** JSON 预览截断：超过字符限制时截断并提示完整数据已保存到磁盘 */
function stringifyPreview(data: unknown, limit: number = PREVIEW_CHAR_LIMIT): { text: string; truncated: boolean; bytes: number } {
  const text = JSON.stringify(data, null, 2);
  const truncated = text.length > limit;
  return {
    text: truncated ? `${text.slice(0, limit)}\n\n... truncated. Full data is saved on disk.` : text,
    truncated,
    bytes: Buffer.byteLength(text, "utf-8"),
  };
}

/** 获取已导出图标的索引信息，附加 Web 访问路径 */
function iconIndexPayload(): unknown {
  const index = tempManager.getIconsIndex();
  const exported = index.icons
    .map((icon) => {
      const filename = icon.svgPath ? path.basename(icon.svgPath) : icon.name;
      return {
        ...icon,
        filename,
        path: icon.svgPath,
        href: filename ? `/debug-assets/svg/${encodeURIComponent(filename)}` : null,
      };
    })
    .filter((icon) => icon.href);

  return { ...index, exported };
}

/** 加载文件的语义变量定义（用于 condensed-v3 格式），失败时优雅降级 */
async function loadSemanticVariables(figma: FigmaClient, fileKey: string): Promise<{
  definitions: ReturnType<typeof buildSemanticVariableDefinitions> | null;
  variableMap: CondensedVariableMap | null;
  capabilities: Partial<SemanticCapabilities>;
}> {
  try {
    const variablesData = await figma.getVariables(fileKey) as any;
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

/** CRC32 校验和计算（用于 ZIP 文件格式） */
export function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** 将 Date 转为 ZIP 文件格式的 MS-DOS 时间/日期字段 */
export function zipDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(date.getFullYear(), 1980);
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/**
 * 纯 JS 实现的 ZIP 打包（无外部依赖）
 * 使用 STORE 方式（不压缩），适合小文件 SVG 打包
 */
export function makeZip(files: Array<{ filename: string; content: Buffer; modifiedAt: Date }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(file.filename.replace(/\\/g, "/"), "utf-8");
    const checksum = crc32(file.content);
    const { time, date } = zipDateTime(file.modifiedAt);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(file.content.length, 18);
    local.writeUInt32LE(file.content.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    localParts.push(local, name, file.content);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(file.content.length, 20);
    central.writeUInt32LE(file.content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);

    offset += local.length + name.length + file.content.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectory, end]);
}

/** 将所有已导出的 SVG 打包为 ZIP 文件 */
async function buildIconsZip(): Promise<Buffer> {
  const index = tempManager.getIconsIndex();
  const files: Array<{ filename: string; content: Buffer; modifiedAt: Date }> = [];
  const usedNames = new Set<string>();

  for (const icon of index.icons) {
    if (!icon.svgPath) continue;
    try {
      const content = await fs.readFile(icon.svgPath);
      let filename = path.basename(icon.svgPath);
      if (usedNames.has(filename)) {
        const ext = path.extname(filename);
        const base = path.basename(filename, ext);
        filename = `${base}-${files.length + 1}${ext}`;
      }
      usedNames.add(filename);
      files.push({ filename, content, modifiedAt: new Date(icon.updatedAt || icon.createdAt || Date.now()) });
    } catch {
      continue;
    }
  }

  if (files.length === 0) {
    throw new Error("No SVG files are available to download. Generate icon previews first.");
  }

  return makeZip(files);
}

/**
 * 核心 inspect 逻辑：获取 Figma 数据并生成多种格式的转换结果
 * 返回 raw / simplified / condensed / condensed-v2 / condensed-v3 / semantic 六种格式
 * 同时检测并导出图标
 */
async function inspectFigma(input: InspectRequest): Promise<unknown> {
  const token = (input.token || process.env.FIGMA_TOKEN || "").trim();
  if (!token) {
    throw new Error("请输入 Figma Token，或在环境变量中设置 FIGMA_TOKEN");
  }

  const { fileKey, nodeId } = resolveTarget(input);
  const depth = Math.max(1, Math.min(Number(input.depth || (nodeId ? 10 : 2)), 20));
  const maxTokens = Math.max(500, Math.min(Number(input.maxTokens || 6000), 50000));
  const figma = new FigmaClient(token);
  const svgExporter = new SvgExporter(figma, tempManager);

  const raw = nodeId
    ? await figma.getFileNodes(fileKey, [nodeId], undefined, depth)
    : await figma.getFile(fileKey, { depth });

  const nodeData = nodeId ? (raw as any)?.nodes?.[nodeId] : raw;
  const documentNode = nodeId ? nodeData?.document : (raw as any)?.document;

  if (!documentNode) {
    throw new Error(nodeId ? `节点 ${nodeId} 不存在或无权访问` : "Figma 文件返回数据中没有 document");
  }

  const targetId = nodeId || "file";
  const rawPath = tempManager.writeRaw(fileKey, targetId, raw);

  const tree = simplifyNode(documentNode, 0, depth);
  const summary = generateSummary(tree);
  const nodeVariableMap = buildVariableMapFromNodes(documentNode);
  const fallbackVariableMap = Object.keys(nodeVariableMap).length > 0
    ? Object.fromEntries(Object.entries(nodeVariableMap).map(([id, entry]) => [id, entry.cssVar]))
    : null;
  const semanticVariables = await loadSemanticVariables(figma, fileKey);
  const variableMap = semanticVariables.variableMap || fallbackVariableMap;

  const detectedIcons = svgExporter.detectExportableNodes(documentNode, 0, { maxResults: 60 });
  const exportedIcons: any[] = [];

  if (input.exportIcons !== false && detectedIcons.length > 0) {
    const previewResult = await exportDetectedIcons({ token, fileKey, icons: detectedIcons });
    exportedIcons.push(...((previewResult as any).exported || []));
  }

  const svgMap: CondensedSvgMap = {};
  for (const icon of exportedIcons) {
    if (icon.nodeId) {
      svgMap[icon.nodeId] = {
        filename: icon.filename,
        path: icon.path,
        href: icon.href,
      };
    }
  }

  const condensed = toCondensedWithBudget(documentNode, maxTokens, variableMap, svgMap, depth);
  const condensedV2 = toCondensedV2WithBudget(documentNode, maxTokens, variableMap, svgMap, depth);
  const semanticJson = toSemanticJson(documentNode, {
    maxDepth: depth,
    variableDefinitions: semanticVariables.definitions,
    variableMap,
    svgMap,
    capabilities: semanticVariables.capabilities,
  });
  const condensedV3 = toCondensedV3WithBudget(documentNode, maxTokens, {
    maxDepth: depth,
    variableDefinitions: semanticVariables.definitions,
    variableMap,
    svgMap,
    capabilities: semanticVariables.capabilities,
  });
  const optimized = {
    summary,
    tree,
    condensed,
    condensedV2,
    condensedV3,
    semanticJson,
    variables: nodeVariableMap,
  };

  const optimizedPath = tempManager.writeOptimized(fileKey, targetId, optimized);
  const condensedPath = tempManager.writeCondensed(fileKey, targetId, condensed);
  const condensedV2Path = tempManager.writeCondensedV2(fileKey, targetId, condensedV2);
  const condensedV3Path = tempManager.writeCondensedV3(fileKey, targetId, condensedV3);
  const rawPreview = stringifyPreview(raw);
  const optimizedPreview = stringifyPreview({
    summary: optimized.summary,
    tree: optimized.tree,
    variables: optimized.variables,
  });
  const semanticPreview = stringifyPreview(semanticJson);

  return {
    target: {
      fileKey,
      nodeId: nodeId || null,
      depth,
      maxTokens,
      tempDir: tempManager.tempDir,
      rawPath,
      optimizedPath,
      condensedPath,
      condensedV2Path,
      condensedV3Path,
    },
    rawPreview,
    optimizedPreview,
    semanticPreview,
    optimized: {
      summary: optimized.summary,
      condensed: optimized.condensed,
      condensedV2: optimized.condensedV2,
      condensedV3: optimized.condensedV3,
      semanticJson: optimized.semanticJson,
    },
    icons: {
      detected: detectedIcons,
      exported: exportedIcons,
      index: tempManager.getIconsIndex(),
    },
  };
}

/** 导出检测到的图标节点为 SVG 文件 */
async function exportDetectedIcons(input: ExportIconsRequest): Promise<unknown> {
  const token = (input.token || process.env.FIGMA_TOKEN || "").trim();
  if (!token) {
    throw new Error("请输入 Figma Token，或在环境变量中设置 FIGMA_TOKEN");
  }

  const fileKey = (input.fileKey || "").trim();
  if (!fileKey) {
    throw new Error("缺少 fileKey，请先检查 Figma 节点");
  }

  const icons = (input.icons || [])
    .map((icon) => ({
      id: icon.id || icon.nodeId || "",
      name: icon.name || icon.id || icon.nodeId || "icon",
      role: icon.role || "icon",
      exportId: icon.exportId,
    }))
    .filter((icon) => icon.id);

  if (icons.length === 0) {
    return { exported: [], index: tempManager.getIconsIndex() };
  }

  const figma = new FigmaClient(token);
  const svgExporter = new SvgExporter(figma, tempManager);
  const svgResults = await svgExporter.exportNodes(fileKey, icons);
  const exported = [];

  for (const [exportedNodeId, svgInfo] of svgResults.entries()) {
    exported.push({
      nodeId: exportedNodeId,
      filename: svgInfo.filename,
      path: svgInfo.path,
      href: `/debug-assets/svg/${encodeURIComponent(svgInfo.filename)}`,
      inline: svgInfo.inline,
    });
  }

  const exportedIds = new Set(exported.map((icon) => icon.nodeId));
  const missing = icons
    .filter((icon) => !exportedIds.has(icon.id))
    .map((icon) => ({
      nodeId: icon.id,
      name: icon.name,
      exportId: icon.exportId || null,
    }));

  tempManager.addIcons(
    exported.map((icon) => ({
      fileKey,
      nodeId: icon.nodeId,
      name: icon.filename || icon.nodeId,
      svgPath: icon.path || null,
      source: "debug_web",
    }))
  );

  return { exported, missing, index: iconIndexPayload() };
}

/** 提供单个 SVG 文件的静态服务 */
async function serveSvg(filename: string, res: http.ServerResponse): Promise<void> {
  const safeName = path.basename(filename);
  const filePath = path.join(tempManager.svgDir, safeName);
  try {
    const svg = await fs.readFile(filePath, "utf-8");
    sendText(res, 200, svg, "image/svg+xml; charset=utf-8");
  } catch {
    sendJson(res, 404, { error: "SVG 不存在" });
  }
}

/** 提供调试页面 HTML */
async function serveIndex(res: http.ServerResponse): Promise<void> {
  try {
    const html = await fs.readFile(path.join(WEB_ROOT, "index.html"), "utf-8");
    sendText(res, 200, html, "text/html; charset=utf-8");
  } catch (error) {
    sendJson(res, 500, { error: "调试页面文件不存在", detail: errorPayload(error).message });
  }
}

/** HTTP 请求路由分发 */
async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const requestUrl = new URL(req.url || "/", `http://${HOST}`);

  if (req.method === "GET" && requestUrl.pathname === "/") {
    await serveIndex(res);
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/health") {
    sendJson(res, 200, { ok: true, name: "figma-design-context-debug-web" });
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/icons") {
    sendJson(res, 200, iconIndexPayload());
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/icons.zip") {
    try {
      const zip = await buildIconsZip();
      sendBinary(res, 200, zip, {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="figma-icons-${Date.now()}.zip"`,
      });
    } catch (error) {
      const payload = errorPayload(error);
      sendJson(res, 400, { error: payload.message });
    }
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/reset") {
    tempManager.init();
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/inspect") {
    try {
      const body = await getRequestBody(req);
      const input = body ? JSON.parse(body) as InspectRequest : {};
      sendJson(res, 200, await inspectFigma(input));
    } catch (error) {
      const payload = errorPayload(error);
      sendJson(res, payload.status || 400, { error: payload.message, status: payload.status });
    }
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/export-icons") {
    try {
      const body = await getRequestBody(req);
      const input = body ? JSON.parse(body) as ExportIconsRequest : {};
      sendJson(res, 200, await exportDetectedIcons(input));
    } catch (error) {
      const payload = errorPayload(error);
      sendJson(res, payload.status || 400, { error: payload.message, status: payload.status });
    }
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/export-icons") {
    sendJson(res, 200, {
      ok: false,
      message: "Use POST /api/export-icons from the debug page. Existing exported SVGs are available from GET /api/icons.",
      icons: iconIndexPayload(),
    });
    return;
  }

  if (req.method === "GET" && requestUrl.pathname.startsWith("/debug-assets/svg/")) {
    const filename = decodeURIComponent(requestUrl.pathname.replace("/debug-assets/svg/", ""));
    await serveSvg(filename, res);
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

/** 在指定端口启动 HTTP 服务，返回 server 实例 */
function listenOnPort(port: number): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((error) => {
      sendJson(res, 500, { error: errorPayload(error).message });
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, HOST, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

/** 启动服务：从 DEFAULT_PORT 开始尝试，端口被占用则递增（最多尝试 20 个） */
async function start(): Promise<void> {
  for (let port = DEFAULT_PORT; port < DEFAULT_PORT + 20; port++) {
    try {
      await listenOnPort(port);
      console.log(`Figma debug web: http://${HOST}:${port}`);
      console.log(`Debug files: ${tempManager.tempDir}`);
      return;
    } catch (error: any) {
      if (error?.code !== "EADDRINUSE") throw error;
    }
  }

  throw new Error(`没有可用端口: ${DEFAULT_PORT}-${DEFAULT_PORT + 19}`);
}

/** 判断当前文件是否作为主模块直接运行（而非被 import） */
function isMainModule(): boolean {
  if (process.argv.length < 2) return false;
  const entry = process.argv[1];
  if (typeof entry !== "string") return false;
  return entry.endsWith("debug-server.js") || entry.endsWith("debug-server.ts");
}

if (isMainModule()) {
  start().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

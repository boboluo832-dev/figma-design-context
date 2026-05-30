/**
 * 临时文件管理器
 *
 * 管理 .figma-temp 目录下的所有调试/缓存文件：
 * - logs/       调试日志（raw + optimized）
 * - svg/        导出的 SVG 图标文件
 * - raw/        Figma API 原始响应 JSON
 * - optimized/  转换后的优化数据
 * - condensed/  condensed 格式输出（v1/v2/v3）
 * - icons/      图标索引（index.json）
 *
 * 特性：
 * - debugMode=false 时大部分写入操作为 no-op（不写文件）
 * - 支持通过环境变量 FIGMA_TEMP_DIR 自定义目录位置
 * - init() 会清空重建整个目录（用于 debug server 的 reset）
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODULE_ROOT = __dirname;
const DEFAULT_TEMP_DIR = ".figma-temp";

/** 图标索引条目 */
export interface IconEntry {
  fileKey: string;
  nodeId: string;
  name: string;
  svgPath: string | null;
  source: string;        // 来源标识（如 "debug_web", "mcp_tool"）
  createdAt?: string;
  updatedAt?: string;
}

interface IconsIndex {
  icons: IconEntry[];
}

/** 判断是否开启 debug 模式（环境变量 FIGMA_DEBUG=1/true/yes/on） */
export function isFigmaDebugEnabled(value: string | undefined = process.env.FIGMA_DEBUG): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

export class TempManager {
  tempDir: string;
  logsDir: string;
  svgDir: string;
  rawDir: string;
  optimizedDir: string;
  condensedDir: string;
  condensedV2Dir: string;
  condensedV3Dir: string;
  iconsDir: string;
  iconsIndexPath: string;
  debugMode: boolean;

  constructor(projectRoot: string = MODULE_ROOT, debugMode: boolean = isFigmaDebugEnabled(), tempDir?: string) {
    const configuredTempDir = tempDir || process.env.FIGMA_TEMP_DIR;
    this.tempDir = configuredTempDir
      ? path.resolve(configuredTempDir)
      : path.join(projectRoot, DEFAULT_TEMP_DIR);
    this.logsDir = path.join(this.tempDir, "logs");
    this.svgDir = path.join(this.tempDir, "svg");
    this.rawDir = path.join(this.tempDir, "raw");
    this.optimizedDir = path.join(this.tempDir, "optimized");
    this.condensedDir = path.join(this.tempDir, "condensed");
    this.condensedV2Dir = path.join(this.tempDir, "condensed-v2");
    this.condensedV3Dir = path.join(this.tempDir, "condensed-v3");
    this.iconsDir = path.join(this.tempDir, "icons");
    this.iconsIndexPath = path.join(this.iconsDir, "index.json");
    this.debugMode = debugMode;
  }

  /** 清空并重建整个临时目录 */
  init(): void {
    if (fs.existsSync(this.tempDir)) {
      fs.rmSync(this.tempDir, { recursive: true, force: true });
    }
    this.ensure();
  }

  /** 确保所有子目录存在（幂等操作） */
  ensure(): void {
    fs.mkdirSync(this.logsDir, { recursive: true });
    fs.mkdirSync(this.svgDir, { recursive: true });
    fs.mkdirSync(this.rawDir, { recursive: true });
    fs.mkdirSync(this.optimizedDir, { recursive: true });
    fs.mkdirSync(this.condensedDir, { recursive: true });
    fs.mkdirSync(this.condensedV2Dir, { recursive: true });
    fs.mkdirSync(this.condensedV3Dir, { recursive: true });
    fs.mkdirSync(this.iconsDir, { recursive: true });
    if (!fs.existsSync(this.iconsIndexPath)) {
      fs.writeFileSync(this.iconsIndexPath, JSON.stringify({ icons: [] }, null, 2), "utf-8");
    }
  }

  /** 保存 SVG 文件到 svg/ 目录（始终写入，不受 debugMode 控制） */
  writeSvg(filename: string, content: string): string {
    this.ensure();
    const filePath = path.join(this.svgDir, filename);
    fs.writeFileSync(filePath, content, "utf-8");
    return filePath;
  }

  /** 写入原始 API 响应 JSON */
  writeRaw(fileKey: string, nodeId: string, data: unknown): string | null {
    return this._writeJson(this.rawDir, fileKey, nodeId, data);
  }

  /** 写入优化后的数据 JSON */
  writeOptimized(fileKey: string, nodeId: string, data: unknown): string | null {
    return this._writeJson(this.optimizedDir, fileKey, nodeId, data);
  }

  /** 写入 condensed v1 格式文本 */
  writeCondensed(fileKey: string, nodeId: string, content: string): string | null {
    this.ensure();
    const safeNodeId = nodeId.replace(/:/g, "-");
    const filePath = path.join(this.condensedDir, `${fileKey}_${safeNodeId}.txt`);
    fs.writeFileSync(filePath, content, "utf-8");
    return filePath;
  }

  /** 写入 condensed v2 格式文本 */
  writeCondensedV2(fileKey: string, nodeId: string, content: string): string | null {
    this.ensure();
    const safeNodeId = nodeId.replace(/:/g, "-");
    const filePath = path.join(this.condensedV2Dir, `${fileKey}_${safeNodeId}.txt`);
    fs.writeFileSync(filePath, content, "utf-8");
    return filePath;
  }

  /** 写入 condensed v3 格式文本 */
  writeCondensedV3(fileKey: string, nodeId: string, content: string): string | null {
    this.ensure();
    const safeNodeId = nodeId.replace(/:/g, "-");
    const filePath = path.join(this.condensedV3Dir, `${fileKey}_${safeNodeId}.txt`);
    fs.writeFileSync(filePath, content, "utf-8");
    return filePath;
  }

  /** 内部：写入 JSON 文件到指定目录 */
  private _writeJson(dir: string, fileKey: string, nodeId: string, data: unknown): string {
    this.ensure();
    const safeNodeId = nodeId.replace(/:/g, "-");
    const filePath = path.join(dir, `${fileKey}_${safeNodeId}.json`);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
    return filePath;
  }

  /** 添加单个图标到索引 */
  addIcon(entry: IconEntry): void {
    this.addIcons([entry]);
  }

  /** 批量添加图标到索引（已存在的按 fileKey:nodeId 去重更新） */
  addIcons(entries: IconEntry[]): void {
    this.ensure();
    const index = this._readIconsIndex();
    const iconMap = new Map<string, number>();
    for (let i = 0; i < index.icons.length; i++) {
      iconMap.set(`${index.icons[i].fileKey}:${index.icons[i].nodeId}`, i);
    }
    for (const entry of entries) {
      const key = `${entry.fileKey}:${entry.nodeId}`;
      const existingIdx = iconMap.get(key);
      if (existingIdx !== undefined) {
        index.icons[existingIdx] = { ...index.icons[existingIdx], ...entry, updatedAt: new Date().toISOString() };
      } else {
        iconMap.set(key, index.icons.length);
        index.icons.push({ ...entry, createdAt: new Date().toISOString() });
      }
    }
    fs.writeFileSync(this.iconsIndexPath, JSON.stringify(index, null, 2), "utf-8");
  }

  /** 获取当前图标索引 */
  getIconsIndex(): IconsIndex {
    this.ensure();
    return this._readIconsIndex();
  }

  /** 内部：读取图标索引文件，解析失败返回空列表 */
  private _readIconsIndex(): IconsIndex {
    try {
      const content = fs.readFileSync(this.iconsIndexPath, "utf-8");
      return JSON.parse(content);
    } catch {
      return { icons: [] };
    }
  }

  /** 写入调试日志（仅 debugMode=true 时生效），返回文件路径或 null */
  writeLog(toolName: string, type: string, data: unknown): string | null {
    if (!this.debugMode) return null;
    this.ensure();
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `${timestamp}_${toolName}_${type}.json`;
    const filePath = path.join(this.logsDir, filename);
    const content = JSON.stringify(data, null, 2);
    fs.writeFileSync(filePath, content, "utf-8");
    return filePath;
  }
}

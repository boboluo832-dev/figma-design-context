/**
 * 调试日志记录器
 *
 * 将 MCP 工具的请求/响应数据写入临时目录，便于调试和问题排查。
 * 仅在 debug 模式下实际写入文件（由 TempManager 控制）。
 *
 * 日志分两类：
 * - raw: 原始 API 响应数据
 * - optimized: 经过转换/优化后的输出数据
 */

import { TempManager } from "./temp-manager.js";

export class Logger {
  private tempManager: TempManager;

  constructor(tempManager: TempManager) {
    this.tempManager = tempManager;
  }

  /** 记录原始 API 响应（工具名 + 请求参数 + 完整响应） */
  logRaw(toolName: string, requestInfo: unknown, rawData: unknown): string | null {
    const data = {
      timestamp: new Date().toISOString(),
      tool: toolName,
      request: requestInfo,
      response: rawData,
    };
    return this.tempManager.writeLog(toolName, "raw", data);
  }

  /** 记录优化后的输出（工具名 + 请求参数 + 转换结果摘要） */
  logOptimized(toolName: string, requestInfo: unknown, optimizedData: unknown): string | null {
    const data = {
      timestamp: new Date().toISOString(),
      tool: toolName,
      request: requestInfo,
      result: optimizedData,
    };
    return this.tempManager.writeLog(toolName, "optimized", data);
  }
}

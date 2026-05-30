# 项目总览

## 项目定位

`figma-design-context` 是一个 TypeScript 编写的 MCP Server，目标是把 Figma API 返回的大型设计 JSON 转成更适合 LLM 使用的上下文。它不是 UI 应用，也不提供 HTTP 服务，而是通过 `@modelcontextprotocol/sdk` 的 `StdioServerTransport` 与 MCP Client 通信。

## 运行方式

项目通过 `src/index.ts` 注册 MCP tools。发布后由 `dist/index.js` 启动，`package.json` 里的 `bin` 把命令名映射为：

```bash
figma-design-context
```

MCP Client 配置时需要传入：

```json
{
  "env": {
    "FIGMA_TOKEN": "figd_your_token"
  }
}
```

启动时如果没有 `FIGMA_TOKEN`，进程会向 stderr 输出错误并退出。

## 技术栈

- Node.js 18+，依赖原生 `fetch`
- TypeScript，ES module
- MCP SDK：`@modelcontextprotocol/sdk`
- Schema 校验：`zod`
- 测试：Vitest
- 发布：GitHub Actions 在 GitHub Release 创建后发布到 npm 和 GitHub Packages

## 目录结构

```text
src/
  index.ts          MCP Server 入口和 tool 注册
  figma-client.ts   Figma REST API 客户端，包含缓存、重试、并发控制
  transformer.ts    Figma 节点简化、压缩、语义识别、颜色和效果转换
  helpers.ts        URL 解析、文本提取、CSS/Tailwind 生成、节点搜索
  diff.ts           节点差异比较和格式化
  svg-exporter.ts   可导出 SVG 节点检测、下载和输出格式化
  temp-manager.ts   .figma-temp 临时目录、日志、SVG 和索引管理
  logger.ts         原始响应和优化结果日志包装

tests/
  *.test.ts         单元测试，覆盖 API client、转换器、helper、SVG、日志和临时文件

.github/workflows/
  publish.yml       Release 创建后发布 npm 和 GitHub Packages
```

## 数据产物

服务运行时会使用配置的临时产物目录。默认目录位于运行模块目录下，本地 build 默认是 `dist/.figma-temp`；也可以通过 `FIGMA_TEMP_DIR` 指定固定产物目录。MCP Server 启动时会清空并重建该目录，debug web 启动时只确保目录存在，不会清空已有产物。主要目录包括：

- `.figma-temp/raw`：原始节点响应快照
- `.figma-temp/optimized`：简化后的节点、结构、tokens 等数据
- `.figma-temp/condensed`：legacy 压缩文本，来自 `format: "condensed"` 或 `format: "json"`
- `.figma-temp/condensed-v2`：兼容版 AI 压缩文本，来自 `format: "condensed-v2"` 或 `format: "json"`
- `.figma-temp/condensed-v3`：默认 AI 代码生成压缩文本，来自 `format: "condensed-v3"` 或 `format: "json"`
- `.figma-temp/logs`：`FIGMA_DEBUG=1` 时的 API 原始响应和优化结果日志

`get_node` 总会写入 raw 和 optimized。压缩文本按请求格式写入：`format: "condensed-v3"` 只写默认 V3 压缩文本，`format: "condensed"` 只写 legacy condensed，`format: "condensed-v2"` 只写 condensed-v2，`format: "json"` 同时写三种压缩文本，并在返回 JSON 的 `artifacts` 字段里给出 `tempDir`、`rawPath`、`optimizedPath`、`condensedPath`、`condensedV2Path` 和 `condensedV3Path`。AI 客户端应直接使用这些路径，不要重新拼接缓存文件名。

所有产物写入路径都会在写入前调用 `TempManager.ensure()`。如果运行中的进程外部删除了 `.figma-temp`，下一次 `get_node`、SVG 导出或图标索引写入会自动重建目录。

`FIGMA_DEBUG=1` 会额外写入 `.figma-temp/logs` 详细 API 日志。以下目录和文件用于工具输出，不依赖 `FIGMA_DEBUG`：

- `.figma-temp/svg`：下载后的 SVG 文件
- `.figma-temp/icons/index.json`：本会话已导出图标索引

这些运行时产物不属于源码文档范围。

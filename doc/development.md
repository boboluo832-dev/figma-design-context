# 开发、测试与发布

## 本地开发

安装依赖：

```bash
npm install
```

编译：

```bash
npm run build
```

监听编译：

```bash
npm run dev
```

运行测试：

```bash
npm test
```

监听测试：

```bash
npm run test:watch
```

Local debug entry points:

```bash
npm run start:debug
npm run debug:web
```

`start:debug` starts the MCP server with `FIGMA_DEBUG=1`.

`debug:web` runs `npm run build` and then starts the local debug page from `dist/debug-server.js`. It listens on `127.0.0.1`, starting at `DEBUG_WEB_PORT` or port `3333`, and tries the next ports if needed.

## 环境变量

运行 MCP Server 需要：

```text
FIGMA_TOKEN=figd_your_token
```

可选：

```text
FIGMA_CACHE_TTL=60000
FIGMA_REQUEST_TIMEOUT_MS=20000
FIGMA_DEBUG=1
FIGMA_TEMP_DIR=/path/to/your-project/.figma-temp
DEBUG_WEB_PORT=3333
```

`FIGMA_DEBUG` 支持 `1`、`true`、`yes`、`on`。`get_node` 会始终把节点原始数据和优化后的数据写入配置的 `.figma-temp/raw`、`.figma-temp/optimized`。压缩产物按请求格式写入：`format: "condensed-v3"` 写 `.figma-temp/condensed-v3`，`format: "condensed"` 写 `.figma-temp/condensed`，`format: "condensed-v2"` 写 `.figma-temp/condensed-v2`，`format: "json"` 同时写三者。开启 `FIGMA_DEBUG` 后会额外把详细 API 日志写入 `.figma-temp/logs`。SVG 导出结果和图标索引仍会写入 `.figma-temp/svg` 和 `.figma-temp/icons/index.json`。`FIGMA_TEMP_DIR` 可覆盖产物根目录；未设置时，本地 build 默认写入 `dist/.figma-temp`。

测试环境示例文件是 `.env.test.example`。当前测试主要是单元测试，直接 mock 或构造数据，不依赖真实 Figma 请求。

## TypeScript 配置

`tsconfig.json` 的关键配置：

- `target`: `ES2022`
- `module`: `ESNext`
- `moduleResolution`: `bundler`
- `rootDir`: `src`
- `outDir`: `dist`
- `strict`: `true`
- 输出 declaration、declarationMap 和 sourceMap
- 编译包含 `src/**/*.ts`
- 排除 `node_modules`、`dist`、`tests`

## 测试覆盖范围

当前测试覆盖：

- `FigmaClient` 初始化、缓存、错误、回调、TTL
- Figma URL 解析
- 文本提取
- 变量和值格式化
- CSS / Tailwind 输出
- 节点搜索相关 helper
- 语义角色推断
- 节点简化
- condensed 输出和 depth 控制
- 颜色、渐变、效果转换
- 变量映射
- SVG 可导出节点检测和输出格式化
- 临时目录、SVG、raw、optimized、icons index 写入
- Logger 调用

## 发布流程

`package.json` 提供版本脚本：

```bash
npm run release:patch
npm run release:minor
npm run release:major
```

这些脚本会执行 `npm version` 并推送 tag。

`.github/workflows/publish.yml` 在 GitHub Release 创建时触发：

1. Checkout
2. Setup Node 20
3. `npm ci`
4. `npm run build`
5. 发布到 npm，使用 `NPM_TOKEN`

## 新增 MCP Tool 的建议流程

1. 在 `src/index.ts` 中注册 tool，明确 description 和 inputSchema
2. 如果需要 Figma API，优先给 `FigmaClient` 增加封装方法
3. 复杂转换逻辑放到 `transformer.ts` 或 `helpers.ts`
4. 涉及资源写入时通过 `TempManager`
5. 涉及日志时通过 `Logger`
6. 在 `tests/` 增加对应单元测试
7. 运行 `npm run build` 和 `npm test`
8. 更新 `doc/tools.md` 和 `doc/workflow.md`

## 常见约束

- Node ID 输入允许 `312:33667` 或 `312-33667`，内部通常标准化为冒号形式
- MCP Server 每次启动都会清空配置的临时产物目录；debug web 启动只确保目录存在，不会清空已有产物
- raw 和 optimized 会随 `get_node` 写入；condensed-v3 / condensed-v2 / condensed 按请求格式写入；logs 只有开启 `FIGMA_DEBUG` 时写入
- 产物写入前会重建缺失目录；`get_node(format: "json")` 会返回 `artifacts.tempDir`、`rawPath`、`optimizedPath`、`condensedPath`、`condensedV2Path` 和 `condensedV3Path`
- `get_node` 的 condensed 输出不再按 token 预算截断；完整度由 `depth` 控制
- 自动 SVG 导出最多检测 20 个节点
- SVG 大于 10KB 时不内联，只返回文件路径
- Figma API 请求缓存按完整 URL 作为 key

## Current Debug And Artifact Behavior

- `get_node` always writes `.figma-temp/raw` and `.figma-temp/optimized` under the configured artifact root.
- `get_node(format: "condensed-v3")` writes `.figma-temp/condensed-v3`; `format: "condensed"` writes `.figma-temp/condensed`; `format: "condensed-v2"` writes `.figma-temp/condensed-v2`; `format: "json"` writes all three.
- For local builds, the default artifact root is `dist/.figma-temp`.
- `FIGMA_TEMP_DIR` overrides the artifact root for both MCP and debug web.
- `get_node(format: "json")` returns explicit artifact paths under `artifacts`.
- Artifact writers recreate missing temp directories before writing.
- `FIGMA_DEBUG=1` additionally writes verbose API request/response logs to `.figma-temp/logs`.
- SVG preview/export writes `.figma-temp/svg` and `.figma-temp/icons/index.json`.
- The debug web server uses `TempManager.ensure()`, so it does not clear existing `.figma-temp` files on page-server startup.
- Condensed icon lines can include `svgPath`, letting AI clients read generated SVG files directly.
- Manual non-auto-layout frames can include `inferredLayout` in optimized JSON and `inferred-row` / `inferred-col` / `inferred-grid` in condensed text.
- Real Figma Auto Layout remains `layout` / `flex-row` / `flex-col` and is not overridden by inferred layout hints.
- See [`debug-and-icons.md`](./debug-and-icons.md) for icon preview, icon package download, and condensed SVG references.

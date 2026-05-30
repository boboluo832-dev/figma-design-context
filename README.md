# Figma Design Context

An MCP server that transforms Figma API data into AI-friendly formats, optimized for LLM code generation workflows.

## Features

- **Condensed Text Format** — 60%+ token savings over JSON, ideal for LLM context windows
- **One-shot Codegen** — Structure + design tokens + component definitions + color/font specs in a single call
- **CSS / Tailwind Output** — Generate style code directly, with recursive component tree support
- **SVG Export** — Detect icon-like nodes and export selected nodes as SVG files
- **Node Search** — Find nodes by name/type quickly, even in large files
- **Node Diff** — Compare two nodes or track changes to the same node over time via version history
- **Component Variants** — Extract all property combinations from component sets for Props interfaces
- **Style System** — Retrieve color/text/effect style definitions from files
- **Semantic Role Inference** — Auto-detect common UI semantic roles (BUTTON, CARD, ICON, etc.)
- **Depth Control** — Fetch and transform complete node data up to the requested depth
- **Resilient Requests** — Auto-retry, concurrency control, LRU cache for stability

## Installation

### Option 1: npx (Recommended)

No installation needed — use directly in your MCP client config:

```json
{
  "mcpServers": {
    "figma": {
      "command": "npx",
      "args": ["-y", "figma-design-context"],
      "env": {
        "FIGMA_TOKEN": "figd_your_token"
      }
    }
  }
}
```

### Option 2: Global Install

```bash
npm install -g figma-design-context
```

```json
{
  "mcpServers": {
    "figma": {
      "command": "figma-design-context",
      "env": {
        "FIGMA_TOKEN": "figd_your_token"
      }
    }
  }
}
```

### Option 3: From Source

```bash
git clone https://github.com/boboluo832-dev/figma-design-context.git
cd figma-design-context
npm install
npm run build
```

```json
{
  "mcpServers": {
    "figma": {
      "command": "node",
      "args": ["/path/to/figma-design-context/dist/index.js"],
      "env": {
        "FIGMA_TOKEN": "figd_your_token"
      }
    }
  }
}
```

### Client Config Locations

| Client | Config Path |
|--------|-------------|
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) |
| Claude Code | `mcpServers` field in `.claude/settings.json` |
| Cursor | Settings → MCP → Add Server |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |
| VS Code (Copilot) | `.vscode/mcp.json` |

### Getting a Figma Token

1. Log in to [Figma](https://www.figma.com)
2. Go to Settings → Personal Access Tokens
3. Create a new token and copy the string starting with `figd_`

## Available Tools

| Tool | Description |
|------|-------------|
| `get_file_structure` | Get page and top-level frame structure overview |
| `get_node` | Get AI-friendly node data (condensed-v3 / semantic-json / JSON / legacy condensed text) |
| `get_page_for_codegen` | One-shot fetch of full codegen context |
| `get_node_css` | Convert node to CSS or Tailwind classes |
| `get_texts` | Extract all text content, supports Figma URL input |
| `search_nodes` | Search nodes by name/type for quick location |
| `get_styles` | Get color/text/effect/grid style definitions |
| `get_components` | List all components in a file |
| `get_component_variants` | Get all variant property combinations |
| `get_variables` | Get Design Variables / Tokens |
| `get_images` | Get image export URLs (PNG/SVG/PDF/JPG) |
| `export_svg` | Export nodes as SVG and save to temp directory |
| `get_icons_index` | Get summary index of exported SVGs in session |
| `diff_nodes` | Compare two nodes or track node changes over time |
| `get_versions` | List file version history for diff operations |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `FIGMA_TOKEN` | Yes | Figma Personal Access Token |
| `FIGMA_CACHE_TTL` | No | Cache TTL in milliseconds (default: 60000) |
| `FIGMA_REQUEST_TIMEOUT_MS` | No | Figma API request timeout in milliseconds (default: 20000) |
| `FIGMA_DEBUG` | No | Enable verbose API request logs when set to `1`, `true`, `yes`, or `on`. Node artifacts are written independently of this flag |
| `FIGMA_TEMP_DIR` | No | Override the temp artifact directory. By default artifacts are written under the runtime module directory, such as `dist/.figma-temp` for a local build |
| `DEBUG_WEB_PORT` | No | Starting port for `npm run debug:web` (default: 3333). The debug server tries the next ports if occupied |

## Data Processing

| Processing | Description |
|------------|-------------|
| Noise removal | Strip pluginData, exportSettings, invisible nodes |
| Color flattening | RGBA objects → `#hex` or `rgba()` |
| Layout semantics | Auto Layout → `flex-row/flex-col`, `start/center/end` |
| Layout inference | Non-auto-layout frames can be marked as `inferred-row`, `inferred-col`, or `inferred-grid` from child bounds |
| Padding compression | Collapse identical sides to single value |
| Depth control | Configurable recursion depth; compressed formats are not token-truncated |
| Caching | LRU cache (max 50 entries), configurable TTL |
| Resilience | Auto-retry 429/5xx (exponential backoff), concurrency limit (max 5) |
| Debug output | `get_node` stores raw, optimized, and condensed artifacts under the configured temp directory; `FIGMA_DEBUG=1` additionally stores verbose API logs |

## Layout Semantics

Figma Auto Layout is preserved as the authoritative layout signal:

- `layoutMode: "HORIZONTAL"` becomes `layout.mode: "row"` in optimized JSON and `flex-row` in condensed text.
- `layoutMode: "VERTICAL"` becomes `layout.mode: "col"` in optimized JSON and `flex-col` in condensed text.

When a node has no Auto Layout, or when Figma returns `layoutMode: "NONE"`, the transformer may infer a lightweight layout hint from visible child bounding boxes:

```txt
[FRAME "Manual Row" 460x32 inferred-row inferred-gap:16 confidence:high]
```

In optimized JSON this appears as:

```json
{
  "inferredLayout": {
    "mode": "row",
    "confidence": "high",
    "source": "bounds",
    "gap": 16
  }
}
```

The inferred marker is intentionally separate from `layout` / `flex-row` / `flex-col`, so it does not override real Figma Auto Layout.

## Condensed Icon References

`get_node(format: "condensed")` marks likely icons directly in the compressed tree. When SVG preview/export succeeds, the same line also includes the concrete SVG file reference:

```txt
[BASICS_SETTINGS "Basics/settings" 24x24 icon svg:"icon-Basics-settings_2-1.svg" svgPath:"E:/project/.figma-temp/svg/icon-Basics-settings_2-1.svg"]
```

This lets an AI client see where the icon appears in the hierarchy and which local SVG file to read without making a second discovery request. If an icon is detected but SVG export is unavailable, the line still includes `icon` without `svgPath`.

## AI Codegen Formats

`get_node` defaults to `format: "condensed-v3"` because this is the recommended format for AI code generation. It keeps the V2 deduped tree and adds compact semantic sections for layout, tokens, components, assets, text, dev metadata, interactions, and Hug / Fill / Fixed resize behavior:

```txt
@format condensed-v3
@capabilities fileContent:true variables:true variableModeValues:true devResources:not_requested devModeMeta:from_file_node_if_present

@tokens
--colors-primary=#1677ff modes:{Light=#1677ff,Dark=#4096ff}

@layout
12:3 frame:"Card" layout:flex-col resize:x-fill/y-hug gap:16 p:24

@components
12:7 instance component:Button/Primary

@text
12:9 "Intel Core i9" font:16/400 textCase:ORIGINAL

@tree
@meta nodes:8
...
```

Use `condensed-v3` when feeding data directly to an AI coding agent. Compared with `condensed-v2`, it is better at preserving design intent that affects implementation choices: responsive sizing, design tokens, component identity, grid/auto-layout semantics, text style, exported assets, and optional dev metadata availability.

Use `format: "semantic-json"` when another program needs structured data. It carries the same semantic model as JSON objects, but it is usually noisier than `condensed-v3` for direct LLM prompting.

`format: "condensed-v2"` remains available as a compatibility format. It keeps the tree readable while extracting repeated noise into shared dictionaries:

```txt
@format condensed-v2
@assets
svgBase:"C:/project/.figma-temp/svg/"

@colors
c1=#191919
c2=#eceeed

@sizes
z1=24x24
z2=534x296

@styles
s1=bg:c1 radius:20 flex-col gap:16 p:24

@tree
[FRAME "CPU" size:z2 @s1]
  [MODULE_CPU "Module/CPU" size:z1 icon:i1]
  [TEXT "Title" font:16/400 text:c2 "Intel Core i9"]
```

Use V2 when an existing client has not adopted `condensed-v3` yet. It avoids repeating long `svgPath` values, repeated sizes, gradients, colors, effects, and common layout tokens on every node.

`condensed-v2` can also add conservative overlay hints for decorative layers such as glow/blur nodes:

```txt
[FRAME "Progress Row" has-overlay flex-row]
  [FRAME "发光" size:z1 overlay:next layer:decor]
  [FRAME "Frame 1" size:z1 layer:content]

[FRAME "Card" has-overlay flex-col]
  [ELLIPSE "Ellipse 1" 168x168 overlay:parent layer:decor pos:absolute]
  [FRAME "Title" 486x24]
```

The tree order is preserved. `overlay:next` tells AI clients that the decorative node should visually sit behind the next sibling. `overlay:parent` marks background decoration inside the parent, such as a large blurred ellipse. Nodes with Figma `layoutPositioning: "ABSOLUTE"` include `pos:absolute`, meaning they are outside the parent layout flow.

## Debug Web

For local inspection, run:

```bash
npm run debug:web
```

Then open the printed local URL, usually `http://127.0.0.1:3333`.

The debug page can:

- accept a Figma token and URL / `fileKey` / `nodeId`
- show raw API data, optimized JSON, and AI-friendly condensed text
- preview detected icons as SVG files under `.figma-temp/svg`
- download the generated SVG previews as a zip from `/api/icons.zip`
- clear the configured temp directory from the page when needed

The checkbox on the page is `Preview icons`: it generates local SVG previews. Actual export/download is done by the `Download icon package` button.

## Temp Artifacts

Runtime files are stored under the runtime module directory by default. For a local build that means `dist/.figma-temp`. Set `FIGMA_TEMP_DIR` to make MCP and debug web share a fixed artifact directory.

The MCP server clears and recreates the configured temp directory on startup. The debug web server only ensures the directory structure exists, so starting `npm run debug:web` does not erase existing artifacts.

Artifact write paths recreate missing temp directories before writing, so deleting `.figma-temp` while the MCP server is running no longer breaks the next `get_node` artifact write.

`get_node` always writes raw and optimized node artifacts. The compressed artifact depends on the requested format: `format: "condensed-v3"` writes the V3 file, `format: "semantic-json"` writes semantic data into the optimized artifact, `format: "condensed"` writes the legacy condensed file, `format: "condensed-v2"` writes the V2 file, and `format: "json"` writes legacy/V2/V3 compressed files and returns an `artifacts` object with `tempDir`, `rawPath`, `optimizedPath`, `condensedPath`, `condensedV2Path`, and `condensedV3Path`. AI clients should read those explicit paths instead of guessing filenames.

| Path | Written by | Purpose |
|------|------------|---------|
| `.figma-temp/raw` | `get_node`, debug web inspect | Raw Figma node/API payload snapshots |
| `.figma-temp/optimized` | `get_node`, debug web inspect | Simplified tree, summary, variables, semantic data, condensed data |
| `.figma-temp/condensed` | `get_node(format: "condensed" \| "json")`, debug web inspect | Legacy condensed text files |
| `.figma-temp/condensed-v2` | `get_node(format: "condensed-v2" \| "json")`, debug web inspect | Compatibility condensed-v2 text files |
| `.figma-temp/condensed-v3` | `get_node(format: "condensed-v3" \| "json")`, debug web inspect | Default condensed-v3 text files for AI code generation |
| `.figma-temp/svg` | SVG preview/export paths | Downloaded SVG files |
| `.figma-temp/icons/index.json` | SVG preview/export paths | Current session icon index |
| `.figma-temp/logs` | `FIGMA_DEBUG=1` only | Verbose Figma API request/response logs |

## Package Contents

The npm package ships compiled `dist/*.js`, `dist/*.d.ts`, and source map files, plus `debug-web/index.html`, `doc/`, and `README.md`. Runtime `.figma-temp` artifacts are excluded from the package and repository history.

See [`doc/debug-and-icons.md`](./doc/debug-and-icons.md) for the full debug and icon workflow.

## Project Structure

```
src/
  index.ts          # MCP Server entry, tool registration
  figma-client.ts   # Figma REST API client (retry + cache + concurrency)
  transformer.ts    # Data transform (simplify, compress, semantic inference)
  helpers.ts        # URL parsing, text extraction, CSS/Tailwind gen, node search
  diff.ts           # Node diff logic
  svg-exporter.ts   # SVG detection and export
  temp-manager.ts   # Temp directory lifecycle management
  logger.ts         # Logging system
```

## Development

```bash
npm run build      # Compile
npm run dev        # Watch mode
npm test           # Run tests
npm run test:watch # Watch mode tests
```

## Publishing

Automated via GitHub Actions. Triggered on Release creation:

1. Bump version: `npm version patch` (or `minor` / `major`)
2. Push tag: `git push origin main --tags`
3. Create a Release on GitHub targeting the tag
4. CI builds and publishes to npm

## Requirements

- Node.js 18+ (native fetch required)
- Figma Personal Access Token

---

## 项目亮点

### 架构与代码质量

| 亮点 | 说明 |
|------|------|
| 模块化设计 | 工具处理器共享逻辑统一提取为 `src/tools/shared.ts`，包含 `textResponse`、`fetchNodeDocument`、`exportAndRegisterIcons` 等复用函数，代码清晰易维护 |
| 完整类型系统 | Figma API 响应具备完整 TypeScript 类型定义（`FigmaFileResponse`、`FigmaNodesResponse` 等 6 个接口），零 `as any`，编译期即可发现问题 |
| 计算结果缓存 | `inferLayout`、`inferRole`、`parseEffects` 等高频函数内置缓存，同一节点不重复计算 |
| 统一错误处理 | 14 个 MCP 工具处理器共享标准化的错误格式化、节点获取、SVG 导出流程 |
| 零死代码 | 无冗余分支、无未使用的参数和变量 |

### 可靠性

| 亮点 | 说明 |
|------|------|
| 版本号动态读取 | 从 `package.json` 运行时获取，发布时无需手动同步 |
| 日志写入安全 | 所有文件写入均为 await，进程退出不丢日志 |
| Tailwind 输出准确 | `rgba` 颜色转 Tailwind 的 opacity 计算经过验证 |
| Icon 索引去重 | Map 结构保证同一图标不重复导出 |

### 测试与 CI

| 亮点 | 说明 |
|------|------|
| 304 个单元测试 | 覆盖 transformer、helpers、diff、figma-client、svg-exporter、temp-manager、logger、工具输出集成 |
| v8 覆盖率 | Vitest 配置 60% 覆盖率阈值，低于阈值 CI 直接失败 |
| debug-server 可测试 | 核心函数（`crc32`、`makeZip`、`resolveTarget` 等）独立导出，`isMainModule()` 守卫避免导入副作用 |
| CI 自动验证 | GitHub Actions 发布前强制通过 build + test |

### 工程化

| 亮点 | 说明 |
|------|------|
| npm 单通道发布 | 简洁的 CI 流程，Release 触发即发布 |
| main 分支规范 | 统一使用 `main` 作为默认分支 |

---

## 中文说明

将 Figma API 数据转换为 AI 友好格式的 MCP 服务器，专为 LLM 代码生成场景优化。

### 主要特性

- **压缩文本格式** — 比 JSON 节省 60%+ token，适合 LLM 上下文
- **一站式代码生成** — 结构 + design tokens + 组件定义 + 颜色/字体规范一次获取
- **CSS / Tailwind 输出** — 直接生成样式代码，支持递归组件树
- **SVG 导出** — 检测图标类节点，并把指定节点导出为 SVG 保存
- **节点搜索** — 按名称/类型快速定位节点
- **节点对比** — 对比两个节点差异或通过版本历史追踪同一节点的变化
- **组件 Variants** — 提取组件集的所有属性组合，直接生成 Props 接口
- **样式系统** — 获取文件的颜色/文字/效果样式定义
- **语义角色推断** — 自动识别常见 UI 语义角色（BUTTON, CARD, ICON 等）
- **深度控制** — 按请求 depth 获取并转换完整节点数据，不再按 token 预算截断
- **请求容错** — 自动重试、并发控制、LRU 缓存，稳定不崩溃

### 快速开始

```json
{
  "mcpServers": {
    "figma": {
      "command": "npx",
      "args": ["-y", "figma-design-context"],
      "env": {
        "FIGMA_TOKEN": "figd_你的token"
      }
    }
  }
}
```

详细安装方式和工具列表请参考上方英文文档。

## License

MIT

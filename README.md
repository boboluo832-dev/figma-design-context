# Figma Design Context

A high-quality MCP server for transforming Figma designs into AI-ready context. Built with strict TypeScript, modular architecture, and 304 unit tests — designed to be the reliable bridge between your Figma files and AI code generation.

## Why This Project

Most Figma-to-AI tools dump raw JSON into LLM context windows, wasting tokens and losing design intent. This server solves that with a purpose-built condensed format that preserves layout semantics, design tokens, and component structure while cutting token usage by 60%+.

Key engineering decisions:

- **Condensed-v3 format** — A structured text format with `@layout`, `@tokens`, `@components`, `@text` sections that AI agents can parse without ambiguity
- **Semantic role inference** — Automatically identifies BUTTON, CARD, ICON, INPUT, NAV and other UI patterns from node properties
- **Zero-config depth control** — Fetches complete node trees to requested depth without token-budget truncation
- **Resilient by default** — Exponential backoff on 429/5xx, concurrency limiting (max 5), LRU caching with configurable TTL

## Features

| Category | Capabilities |
|----------|-------------|
| Output Formats | condensed-v3 (default), condensed-v2, semantic-json, raw JSON, CSS, Tailwind |
| Design Data | Nodes, components, variants, styles, variables/tokens, images, version history |
| Code Generation | One-shot codegen context, CSS/Tailwind per node, SVG export with icon detection |
| Analysis | Node search by name/type, node diff, version tracking |
| Reliability | Auto-retry, concurrency control, LRU cache, safe file I/O |

## Quick Start

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

### Other Installation Methods

**Global install:**

```bash
npm install -g figma-design-context
```

**From source:**

```bash
git clone https://github.com/boboluo832-dev/figma-design-context.git
cd figma-design-context
npm install && npm run build
```

### Supported Clients

| Client | Config Location |
|--------|----------------|
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) |
| Claude Code | `mcpServers` in `.claude/settings.json` |
| Cursor | Settings → MCP → Add Server |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |
| VS Code (Copilot) | `.vscode/mcp.json` |

### Getting a Figma Token

1. Log in to [Figma](https://www.figma.com)
2. Settings → Personal Access Tokens
3. Create a token (starts with `figd_`)

## Available Tools

| Tool | What It Does |
|------|-------------|
| `get_node` | Fetch node in any format (condensed-v3 / semantic-json / JSON / CSS / Tailwind) |
| `get_file_structure` | Page and top-level frame overview |
| `get_page_for_codegen` | One-shot: structure + tokens + components + styles for a full page |
| `get_node_css` | CSS or Tailwind output for a specific node |
| `get_texts` | All text content with paths, supports Figma URL input |
| `search_nodes` | Find nodes by name/type across large files |
| `get_styles` | Color/text/effect/grid style definitions |
| `get_components` | List all components in a file |
| `get_component_variants` | All variant property combinations for Props interfaces |
| `get_variables` | Design variables and tokens |
| `get_images` | Image export URLs (PNG/SVG/PDF/JPG) |
| `export_svg` | Export nodes as SVG files locally |
| `get_icons_index` | Summary index of exported SVGs in current session |
| `diff_nodes` | Compare two nodes or track changes via version history |
| `get_versions` | File version history for diff operations |

## Output Format: condensed-v3

The default output format is designed specifically for AI code generation. It organizes design data into scannable sections:

```txt
@format condensed-v3

@tokens
--colors-primary=#1677ff modes:{Light=#1677ff,Dark=#4096ff}

@layout
node:"12:3" mode:column gap:16

@components
node:"12:7" instance component:Button/Primary

@text
node:"12:9" len:13 "Intel Core i9"

@tree
[FRAME "Card" 320x400 bg:c1 radius:12 flex-col gap:16 p:16]
  [TEXT "Title" 288x24 font:20/700 text:c3 "Premium Headphones"]
  [BUTTON "Submit" 200x48 bg:c5 radius:8 flex-row center]
```

Compared to raw Figma JSON, this format:
- Uses 60%+ fewer tokens
- Preserves layout direction, spacing, padding, alignment
- Deduplicates colors/effects into indexed references
- Marks semantic roles (BUTTON, CARD, ICON, IMG, INPUT, NAV)
- Includes resize behavior (hug/fill/fixed) for responsive implementation

## Architecture

```
src/
  index.ts          — MCP server entry, 14 tool registrations
  tools/shared.ts   — Shared utilities (response formatting, node fetching, error handling)
  figma-client.ts   — REST client with retry, cache, concurrency control
  transformer.ts    — Node simplification, condensed format generation, semantic inference
  helpers.ts        — URL parsing, text extraction, CSS/Tailwind, node search
  diff.ts           — Structural node comparison
  svg-exporter.ts   — Icon detection and SVG export
  temp-manager.ts   — Artifact directory lifecycle
  logger.ts         — Structured logging
```

## Engineering Highlights

### Type Safety & Modularity

- Full TypeScript types for all Figma API responses (`FigmaFileResponse`, `FigmaNodesResponse`, etc.) — zero `as any`
- 14 tool handlers share a unified flow via `src/tools/shared.ts`: error formatting, node fetching, SVG registration
- High-frequency functions (`inferLayout`, `inferRole`, `parseEffects`) cache results per node to avoid redundant computation

### Reliability

- Version number read from `package.json` at runtime — no manual sync on release
- All file writes are `await`ed — no fire-and-forget that loses data on process exit
- Icon index uses Map deduplication — same icon never exported twice
- Tailwind opacity conversion verified against edge cases

### Testing

- **304 unit tests** covering transformer, helpers, diff, figma-client, svg-exporter, temp-manager, logger, and tool output integration
- v8 coverage provider with 60% threshold — CI fails if coverage drops
- `debug-server.ts` exports core functions (`crc32`, `makeZip`, `resolveTarget`) independently with `isMainModule()` guard to prevent import side effects

### CI/CD

- GitHub Actions: build → test → publish on Release creation
- Single npm channel, no dual-publish complexity
- `main` branch convention throughout

## Data Processing Pipeline

| Stage | What Happens |
|-------|-------------|
| Fetch | Figma REST API with retry (exponential backoff on 429/5xx), concurrency cap (5), LRU cache |
| Clean | Strip pluginData, exportSettings, invisible nodes |
| Transform | RGBA → `#hex`/`rgba()`, Auto Layout → `flex-row`/`flex-col`, padding compression |
| Infer | Layout inference from child bounds when no Auto Layout, semantic role detection |
| Format | Generate requested output: condensed-v3, condensed-v2, semantic-json, CSS, Tailwind |
| Persist | Write raw/optimized/condensed artifacts to `.figma-temp/` for debugging and AI file access |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `FIGMA_TOKEN` | Yes | Figma Personal Access Token |
| `FIGMA_CACHE_TTL` | No | Cache TTL in ms (default: 60000) |
| `FIGMA_REQUEST_TIMEOUT_MS` | No | Request timeout in ms (default: 20000) |
| `FIGMA_DEBUG` | No | Verbose API logs when `1`/`true`/`yes`/`on` |
| `FIGMA_TEMP_DIR` | No | Override artifact directory (default: `dist/.figma-temp`) |
| `DEBUG_WEB_PORT` | No | Debug web server port (default: 3333, auto-increments if busy) |

## Debug Web

```bash
npm run debug:web
```

Opens a local inspection page at `http://127.0.0.1:3333` where you can:

- Paste a Figma URL and see raw API data, optimized JSON, and condensed output side by side
- Preview detected icons as SVG
- Download all SVGs as a zip
- Clear the temp directory

## Development

```bash
npm run build        # Compile TypeScript
npm run dev          # Watch mode
npm test             # Run 304 tests
npm run test:watch   # Watch mode tests
npm run debug:web    # Local debug page
```

## Publishing

Automated via GitHub Actions on Release creation:

1. `npm version patch` (or `minor` / `major`)
2. `git push origin main --tags`
3. Create a GitHub Release targeting the tag
4. CI runs build + test + `npm publish`

## Requirements

- Node.js 18+ (native fetch)
- Figma Personal Access Token

---

## 中文说明

将 Figma 设计数据转换为 AI 友好格式的 MCP 服务器，专为 LLM 代码生成优化。

### 核心优势

- **condensed-v3 格式** — 比原始 JSON 节省 60%+ token，结构化分区（@layout/@tokens/@components/@text/@tree）让 AI 无歧义解析
- **语义角色推断** — 自动识别 BUTTON、CARD、ICON、INPUT、NAV 等 UI 模式
- **模块化架构** — 14 个工具处理器共享统一的错误处理、节点获取、SVG 导出流程
- **完整类型系统** — Figma API 响应零 `as any`，编译期发现问题
- **304 个单元测试** — 覆盖所有核心模块，v8 覆盖率 60% 阈值保障
- **可靠的 I/O** — 所有文件写入 await，日志不丢失；Icon 去重不重复导出
- **请求容错** — 自动重试 429/5xx、并发限制、LRU 缓存

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

## License

MIT

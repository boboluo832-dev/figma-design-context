# Debug Web and Icon Artifacts

This document explains the local debug web page, `.figma-temp` outputs, icon detection, SVG previews, and how condensed text references local SVG files.

## Local Debug Commands

```bash
npm run start:debug
npm run debug:web
```

`start:debug` starts the MCP server with `FIGMA_DEBUG=1`.

`debug:web` builds the project and starts the local HTTP debug page. The server listens on `127.0.0.1`, starting from `DEBUG_WEB_PORT` or port `3333`. If the port is occupied, it tries the next 19 ports.

## Debug Web Page

Open the printed URL, usually:

```text
http://127.0.0.1:3333
```

The page accepts:

- Figma token
- Figma URL
- `fileKey`
- `nodeId`
- fetch depth
- condensed compatibility token parameter
- `Preview icons` checkbox
- a reset action that clears the configured temp directory

The page shows:

- raw Figma API preview
- optimized JSON preview
- AI-friendly condensed text
- detected icon candidates
- generated SVG icon previews

## Preview Icons vs Download Icons

The debug page separates preview from export/download:

- `Preview icons` checkbox: when checked, inspect will generate local SVG preview files.
- `Generate icon preview`: manually generates SVG previews for detected icons.
- `Download icon package`: downloads the already generated SVG files as a zip from `GET /api/icons.zip`.

SVG preview files are written to:

```text
.figma-temp/svg
```

The icon index is written to:

```text
.figma-temp/icons/index.json
```

## Temp Directory Layout

By default, `.figma-temp` is created under the runtime module directory. For a local build, both MCP and debug web use `dist/.figma-temp`. Set `FIGMA_TEMP_DIR` when you want both entry points to use a stable shared artifact directory outside `dist`.

The configured temp directory is cleared and recreated when the MCP server starts through `TempManager.init()`.

The debug web server calls `TempManager.ensure()`, so it creates missing directories without deleting existing outputs.

All artifact write paths call `TempManager.ensure()` before writing. If `.figma-temp` is deleted while the MCP server is still running, the next `get_node` / SVG / icon-index write recreates the missing directories instead of failing.

| Path | Purpose |
|------|---------|
| `.figma-temp/raw` | Raw Figma node/API payload snapshots |
| `.figma-temp/optimized` | Simplified tree, summary, variables, semantic data, condensed data |
| `.figma-temp/condensed` | Legacy condensed text files |
| `.figma-temp/condensed-v2` | Compatibility condensed-v2 text files |
| `.figma-temp/condensed-v3` | Default condensed-v3 text files for AI code generation |
| `.figma-temp/svg` | Downloaded SVG preview/export files |
| `.figma-temp/icons/index.json` | Current session SVG icon index |
| `.figma-temp/logs` | Verbose API logs when `FIGMA_DEBUG=1` |

## MCP Artifact Writes

`get_node` always writes raw and optimized artifacts under the configured temp directory:

```text
.figma-temp/raw
.figma-temp/optimized
```

This is intentional. It lets a local user or AI agent inspect the exact data used for a node request after the MCP call completes.

Compressed artifacts depend on the requested format:

```text
format: "condensed"    -> .figma-temp/condensed
format: "condensed-v2" -> .figma-temp/condensed-v2
format: "condensed-v3" -> .figma-temp/condensed-v3
format: "json"         -> .figma-temp/condensed, .figma-temp/condensed-v2, and .figma-temp/condensed-v3
```

The debug web inspect endpoint writes all compressed formats so the page can switch between V3, V2, and Legacy views.

`FIGMA_DEBUG=1` now controls verbose API request/response logs only:

```text
.figma-temp/logs
```

SVG files and the icon index are also written when an SVG preview/export path runs.

Set `FIGMA_TEMP_DIR` to override the default directory and force both MCP and the debug web server to write artifacts into a specific directory:

```bash
FIGMA_TEMP_DIR=/path/to/your-project/.figma-temp
```

`get_node(format: "json")` returns an `artifacts` object containing `tempDir`, `rawPath`, `optimizedPath`, `condensedPath`, `condensedV2Path`, and `condensedV3Path`. AI clients should use these returned paths instead of reconstructing the cache filename.

## Condensed Icon Markers

Condensed output marks likely icon nodes explicitly:

```txt
[MODULE_CPU "Module/CPU" 24x24 icon]
[BASICS_SETTINGS "Basics/settings" 24x24 icon]
```

The marker is added when the node looks like an icon by naming and size:

- common names such as `icon`, `ico`, `Basics`, `Module`
- common square sizes such as `16x16`, `20x20`, `24x24`, `32x32`
- container node types such as `FRAME`, `COMPONENT`, `INSTANCE`

Ordinary `24x24` frames are not marked as icons unless they also match icon naming signals.

## SVG References In Condensed Output

When SVG preview/export succeeds, condensed output includes the SVG reference on the same line as the icon node:

```txt
[BASICS_SETTINGS "Basics/settings" 24x24 icon svg:"icon-Basics-settings_2-1.svg" svgPath:"/path/to/.figma-temp/svg/icon-Basics-settings_2-1.svg" svgHref:"/debug-assets/svg/icon-Basics-settings_2-1.svg"]
```

This gives an AI client three useful facts in one place:

- where the icon appears in the Figma hierarchy
- that the node should be treated as an icon
- which local SVG file represents it

`svgHref` is useful in the debug web page. `svgPath` is the local file path that an AI/coding agent can read directly.

If the node is detected as an icon but SVG export fails or is skipped, the line keeps `icon` but does not include `svgPath`.

## Inferred Layout Markers

Condensed output preserves real Figma Auto Layout as `flex-row` or `flex-col`.

For nodes without Auto Layout, including nodes where Figma returns `layoutMode: "NONE"`, the transformer can add an inferred layout marker based on visible child bounding boxes:

```txt
[FRAME "Manual Row" 460x32 inferred-row inferred-gap:16 confidence:high]
[FRAME "Manual Column" 240x120 inferred-col inferred-gap:8 confidence:high]
[FRAME "Manual Grid" 320x180 inferred-grid confidence:medium]
```

These markers are hints, not replacements for Auto Layout. They only appear when real Auto Layout is absent, so `flex-row` / `flex-col` remains the authoritative signal whenever Figma provides it.

Optimized JSON stores the same hint under `inferredLayout`:

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

`gap` is computed from neighboring child edges, not center-point distance.

## Icon Detection Scope

SVG auto-detection is intentionally conservative:

- common icon sizes are preferred
- icon-like component or instance names are preferred
- duplicate component instances are de-duplicated
- naked vector children inside instances are skipped by default
- `INSTANCE` nodes with internal semicolon IDs can use `componentId` as the export target when appropriate

The goal is to avoid exporting hundreds of decorative or internal vector nodes while still catching common icon components such as `Basics/settings` and `Module/CPU`.

## HTTP Debug Endpoints

The debug web server exposes:

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/` | `GET` | Debug page |
| `/api/health` | `GET` | Health check |
| `/api/inspect` | `POST` | Fetch Figma data, optimize it, and optionally preview icons |
| `/api/icons` | `GET` | Read current icon index |
| `/api/export-icons` | `POST` | Generate SVG previews for detected icons |
| `/api/reset` | `POST` | Clear and recreate the configured temp directory |
| `/api/icons.zip` | `GET` | Download generated SVG previews as a zip |
| `/debug-assets/svg/:filename` | `GET` | Serve an SVG preview file |

`GET /api/export-icons` is diagnostic only; preview generation uses `POST /api/export-icons`.

## Recommended AI Workflow

1. Call `get_node` without a `format`, or with `format: "condensed-v3"`, for code generation.
2. Read the returned condensed text first.
3. In `condensed-v3`, use semantic sections first, then resolve icon entries through the embedded V2 `@icons` and `@assets.svgBase`.
4. Use `format: "semantic-json"` for programmatic inspection, `format: "condensed-v2"` for compatibility, or `format: "condensed"` for the legacy inline format.
5. In legacy `condensed`, check icon lines for `svgPath`.
6. If an icon has no SVG file reference, treat the node as an icon placeholder and decide whether a manual SVG export is needed.

# MCP 工具清单

所有工具都在 `src/index.ts` 里通过 `server.registerTool` 注册。以下说明按当前实现整理。

## `get_file_structure`

获取文件的页面和顶层 Frame / Component / Component Set 概览。

参数：

- `fileKey`：Figma 文件 Key

内部流程：

1. 调用 `figma.getFile(fileKey, { depth: 2 })`
2. 读取 `document.children` 作为 pages
3. 提取每个 page 下的顶层 FRAME、COMPONENT、COMPONENT_SET
4. 返回文件名、更新时间、页面和 frame 列表

## `get_texts`

从 Figma URL、文件或节点中提取全部文本。

参数：

- `url`：可选，Figma 文件或节点 URL
- `fileKey`：可选，与 `url` 二选一
- `nodeId`：可选
- `depth`：默认 20

内部流程：

1. 如果传入 `url`，用 `parseFigmaUrl` 解析 `fileKey` 和 `nodeId`
2. 如果有 `nodeId`，调用 `getFileNodes`
3. 否则调用 `getFile`
4. 用 `extractAllTexts` 递归提取 TEXT 节点
5. 返回路径、文本和字体摘要

## `get_node`

获取指定节点的 AI 友好数据，支持 condensed-v3、semantic-json、condensed-v2、legacy condensed 和 JSON。

参数：

- `fileKey`
- `nodeId`
- `depth`：默认 10
- `format`：`condensed-v3`、`semantic-json`、`condensed-v2`、`condensed` 或 `json`，默认 `condensed-v3`
- `maxTokens`：兼容参数，当前不会截断输出；完整度由 `depth` 控制

内部流程：

1. 标准化 `nodeId`，把 `-` 替换为 `:`
2. 调用 `getFileNodes`
3. 将原始响应写入配置产物目录下的 `.figma-temp/raw`
4. 调用 `simplifyNode` 和 `generateSummary`
5. 检测并尝试导出 SVG
6. 如果是 condensed-v3：
   - 请求变量接口，能拿到时输出变量定义、mode 值和 CSS token 名
   - 调用 `toCondensedV3WithBudget`
   - 顶部输出 `@capabilities`、`@tokens`、`@layout`、`@components`、`@assets-semantic`、`@text`、`@dev`、`@interactions`
   - 内嵌 V2 去重 `@tree`
   - 输出 Hug / Fill / Fixed 尺寸语义，例如 `resize:x-fill/y-hug`
   - 写入 `.figma-temp/optimized`
   - 写入 `.figma-temp/condensed-v3`
7. 如果是 semantic-json：
   - 返回与 V3 同源的结构化语义 JSON
   - 写入 `.figma-temp/optimized`
8. 如果是 condensed：
   - 把已导出的 SVG 结果构造成 `nodeId -> svg` 映射
   - 调用 `toCondensedWithBudget`
   - icon 节点会在对应层级行显示 `icon`
   - 如果 SVG 已生成，同一行会显示 `svg` 和 `svgPath`
   - 写入 `.figma-temp/optimized`
   - 写入 `.figma-temp/condensed`
9. 如果是 condensed-v2：
   - 调用 `toCondensedV2WithBudget`
   - 顶部输出 `@assets`、`@sizes`、`@colors`、`@gradients`、`@effects`、`@icons`、`@styles`
   - 树中用 `size:z1`、`bg:c1`、`fx:e1`、`icon:i1`、`@s1` 等引用减少重复噪音
   - 对发光、模糊等装饰层输出保守的 `has-overlay`、`overlay:next`、`overlay:parent`、`layer:decor`、`layer:content` 提示，不重排原始树
   - 对 `layoutPositioning: "ABSOLUTE"` 输出 `pos:absolute`，表示节点脱离父级布局流
   - 写入 `.figma-temp/optimized`
   - 写入 `.figma-temp/condensed-v2`
10. 如果是 json：
   - 从节点绑定推断变量映射
   - 返回 summary、tree、condensed、condensedV2、condensedV3、semanticJson、variables、artifacts 和 SVG 摘要
   - 写入 `.figma-temp/optimized`
   - 写入 `.figma-temp/condensed`
   - 写入 `.figma-temp/condensed-v2`
   - 写入 `.figma-temp/condensed-v3`

condensed 图标行示例：

```txt
[BASICS_SETTINGS "Basics/settings" 24x24 icon svg:"icon-Basics-settings_2-1.svg" svgPath:"E:/project/.figma-temp/svg/icon-Basics-settings_2-1.svg"]
```

AI 客户端可以直接读取 `svgPath`，不需要再次请求图标发现。

condensed-v3 示例：

```txt
@format condensed-v3
@capabilities fileContent:true variables:true variableModeValues:true devResources:not_requested devModeMeta:from_file_node_if_present

@layout
12:3 frame:"Card" layout:flex-col resize:x-fill/y-hug gap:16 p:24

@tree
@meta nodes:8
...
```

condensed-v2 兼容格式示例：

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

装饰层叠加提示示例：

```txt
[FRAME "Progress Row" has-overlay flex-row]
  [FRAME "发光" size:z1 overlay:next layer:decor]
  [FRAME "Frame 1" size:z1 layer:content]

[FRAME "Card" has-overlay flex-col]
  [ELLIPSE "Ellipse 1" 168x168 overlay:parent layer:decor pos:absolute]
  [FRAME "Title" 486x24]
```

Artifact notes:

- By default, local build artifacts are written under `dist/.figma-temp`.
- `FIGMA_TEMP_DIR` overrides the temp artifact directory.
- `get_node` always writes raw and optimized artifacts. `format: "condensed-v3"` writes the default AI codegen artifact, `format: "condensed"` writes the legacy condensed artifact, `format: "condensed-v2"` writes the V2 compatibility artifact, and `format: "json"` writes all three compressed formats.
- `get_node(format: "json")` returns `artifacts.tempDir`, `artifacts.rawPath`, `artifacts.optimizedPath`, `artifacts.condensedPath`, `artifacts.condensedV2Path`, and `artifacts.condensedV3Path`.
- JSON output also writes all compressed text artifacts so AI clients can switch between structured and compressed formats without another path guess.
- Artifact writers recreate missing temp directories before writing.
- AI clients should use returned artifact paths instead of reconstructing cache filenames.

Layout notes:

- Real Figma Auto Layout is emitted as `layout.mode` in optimized JSON and `flex-row` / `flex-col` in condensed text.
- Nodes without Auto Layout can emit `inferredLayout` in optimized JSON and `inferred-row`, `inferred-col`, or `inferred-grid` in condensed text.
- `layoutMode: "NONE"` is treated as no Auto Layout.
- `inferred-gap` is computed from child edge spacing.
- Inferred layout is only a hint and does not override real Auto Layout.

## `get_page_for_codegen`

一次性获取代码生成上下文。

参数：

- `fileKey`
- `nodeId`
- `depth`：默认 12

内部流程：

1. 并行获取节点和 variables
2. 写入原始节点数据
3. 用 `toCondensedFormat` 生成结构
4. 用 `extractDesignInfo` 收集颜色、字体和组件引用
5. 汇总 Design Tokens
6. 检测并导出 SVG
7. 写入优化结果
8. 返回结构、颜色、字体、组件、tokens 和 SVG 信息

## `search_nodes`

按名称和类型搜索节点。

参数：

- `fileKey`
- `query`：可选，名称模糊匹配
- `type`：可选，节点类型过滤
- `parentId`：可选，限定父节点范围
- `maxResults`：默认 20

要求 `query` 或 `type` 至少传一个。

## `get_components`

列出文件里的组件定义。

参数：

- `fileKey`

内部调用 `getFile(fileKey, { depth: 2 })`，再用 `buildComponentMap` 收集 COMPONENT 节点。

## `get_component_variants`

读取 COMPONENT_SET 下所有 variant 的属性组合。

参数：

- `fileKey`
- `nodeId`：COMPONENT_SET 节点 ID

内部流程：

1. 获取节点
2. 校验节点类型必须是 `COMPONENT_SET`
3. 遍历子 COMPONENT
4. 按 Figma variant 命名格式 `key=value, key=value` 解析 props
5. 返回属性定义和 variant 列表

## `get_variables`

获取文件的本地 Variables。

参数：

- `fileKey`

内部调用 `/files/{fileKey}/variables/local`，按 collection 分组，返回 mode 和变量值。

## `get_styles`

获取文件中已发布的样式定义。

参数：

- `fileKey`

内部调用 `/files/{fileKey}/styles`，按 FILL、TEXT、EFFECT、GRID 分组输出。

## `get_node_css`

把节点转换为 CSS 或 Tailwind。

参数：

- `fileKey`
- `nodeId`
- `mode`：`css` 或 `tailwind`，默认 `css`
- `recursive`：默认 `false`

内部根据参数调用：

- `nodeToCSS`
- `nodeToCSSRecursive`
- `nodeToTailwind`
- `nodeToTailwindRecursive`

## `get_images`

获取节点图片导出 URL。

参数：

- `fileKey`
- `nodeIds`
- `format`：`png`、`svg`、`pdf`、`jpg`，默认 `png`
- `scale`：默认 2

内部调用 Figma Images API，返回 `images` 映射。

## `export_svg`

导出指定节点为 SVG 并保存到临时目录。

参数：

- `fileKey`
- `nodeIds`

内部流程：

1. 标准化节点 ID
2. 构造 export 节点列表
3. 通过 `SvgExporter.exportNodes` 获取 SVG URL、下载内容并写入 `.figma-temp/svg`
4. 写入 `.figma-temp/icons/index.json`
5. 返回路径和可选内联 SVG

## `get_icons_index`

获取本次服务会话里已导出的 SVG 图标索引。

无参数。

索引来自 `.figma-temp/icons/index.json`。

## `get_versions`

获取文件版本历史。

参数：

- `fileKey`

内部调用 `/files/{fileKey}/versions`，返回版本 ID、创建时间、label、description 和用户。

## `diff_nodes`

对比两个节点，或对比同一节点当前版本与历史版本。

参数：

- `fileKey`
- `nodeId`
- `mode`：`nodes` 或 `snapshot`，默认 `nodes`
- `targetNodeId`：`nodes` 模式必填
- `targetFileKey`：可选，默认等于 `fileKey`
- `versionId`：`snapshot` 模式可选，不传则使用上一个版本
- `depth`：默认 3

`nodes` 模式：

1. 获取 A 节点
2. 获取 B 节点，支持跨文件
3. 调用 `diffNodes`
4. 格式化返回

`snapshot` 模式：

1. 获取版本历史
2. 确定历史版本 ID
3. 并行获取当前节点和历史节点
4. 调用 `diffNodes`
5. 返回版本变化报告

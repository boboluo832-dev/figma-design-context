/**
 * Figma 数据转换器
 *
 * 核心模块，负责将 Figma API 返回的原始节点树转换为多种精简格式：
 *
 * 输出格式（从简到详）：
 * - simplified: 简化节点树（保留关键属性，去除冗余）
 * - condensed v1: 缩进文本格式（最紧凑，适合 token 受限场景）
 * - condensed v2: 带更多样式细节的文本格式
 * - condensed v3: 最完整的文本格式（含变量定义、SVG 引用）
 * - semantic JSON: 结构化 JSON（含语义角色、HTML 标签推断）
 *
 * 关键能力：
 * - 语义角色推断（inferSemanticRole）：根据节点属性推断 HTML 标签
 * - 变量绑定解析（buildVariableMap）：将 Figma 变量 ID 映射为 CSS 变量名
 * - 布局推断（inferLayout）：从子节点位置推断 flex/grid 布局
 * - CSS 生成：颜色、渐变、阴影、填充等转为 CSS 值
 * - Token 预算控制（withBudget）：按字符数限制输出长度
 */

export interface FigmaColor {
  r: number;
  g: number;
  b: number;
  a?: number;
}

export interface FigmaFill {
  type: string;
  visible?: boolean;
  color?: FigmaColor;
  opacity?: number;
  gradientStops?: FigmaGradientStop[];
  gradientHandlePositions?: FigmaPosition[];
  boundVariables?: Record<string, any>;
}

export interface FigmaGradientStop {
  color?: FigmaColor;
  position: number;
  boundVariables?: Record<string, any>;
}

export interface FigmaPosition {
  x: number;
  y: number;
}

export interface FigmaEffect {
  type: string;
  visible?: boolean;
  color?: FigmaColor;
  offset?: { x: number; y: number };
  radius?: number;
  spread?: number;
  boundVariables?: Record<string, any>;
}

export interface FigmaNode {
  id: string;
  name: string;
  type: string;
  visible?: boolean;
  children?: FigmaNode[];
  fills?: FigmaFill[];
  strokes?: FigmaFill[];
  effects?: FigmaEffect[];
  absoluteBoundingBox?: { x: number; y: number; width: number; height: number };
  cornerRadius?: number;
  rectangleCornerRadii?: number[];
  layoutMode?: string;
  itemSpacing?: number;
  paddingTop?: number;
  paddingRight?: number;
  paddingBottom?: number;
  paddingLeft?: number;
  primaryAxisAlignItems?: string;
  counterAxisAlignItems?: string;
  layoutWrap?: string;
  primaryAxisSizingMode?: string;
  counterAxisSizingMode?: string;
  opacity?: number;
  characters?: string;
  style?: Record<string, any>;
  componentId?: string;
  description?: string;
  boundVariables?: Record<string, any>;
  constraints?: { horizontal: string; vertical: string };
  strokeWeight?: number;
  [key: string]: any;
}

export interface SemanticRole {
  role: string;
  html: string;
}

export interface CondensedSvgRef {
  filename?: string;
  path?: string;
  href?: string;
}

export type CondensedSvgMap = Record<string, CondensedSvgRef | undefined>;
export type CondensedVariableMap = Record<string, string>;

export interface SemanticVariableDefinition {
  id: string;
  name: string;
  type?: string;
  collectionId?: string;
  collectionName?: string;
  cssVar: string;
  codeSyntax?: Record<string, string>;
  modes?: string[];
  values?: Record<string, string>;
}

export interface SemanticCapabilities {
  fileContent: boolean;
  variables: boolean;
  variableModeValues: boolean;
  devResources: boolean | "not_requested";
  devModeMeta: "from_file_node_if_present" | "not_requested";
  variablesReason?: string;
  [key: string]: unknown;
}

export interface SemanticTransformOptions {
  maxDepth?: number;
  variableDefinitions?: Record<string, SemanticVariableDefinition> | null;
  variableMap?: CondensedVariableMap | null;
  svgMap?: CondensedSvgMap | null;
  capabilities?: Partial<SemanticCapabilities>;
}

type InferredLayoutMode = "row" | "col" | "grid";

interface InferredLayout {
  mode: InferredLayoutMode;
  confidence: "high" | "medium";
  source: "bounds";
  gap?: number;
}

interface SimplifiedNode {
  id: string;
  name: string;
  type: string;
  role?: string;
  htmlTag?: string;
  bounds?: { x: number; y: number; w: number; h: number };
  fill?: string | null;
  gradient?: any[];
  effects?: ParsedEffect[] | null;
  stroke?: any;
  cornerRadius?: number | number[];
  layout?: any;
  inferredLayout?: InferredLayout;
  text?: string;
  textStyle?: Record<string, any>;
  componentId?: string;
  isComponent?: boolean;
  description?: string;
  tokens?: Record<string, any>;
  opacity?: number;
  position?: "absolute";
  constraints?: { h: string; v: string };
  responsiveHint?: string;
  children?: SimplifiedNode[];
}

interface ParsedEffect {
  type: string;
  color?: string | null;
  offset?: { x: number; y: number };
  radius: number;
  spread?: number;
}

interface NamePattern {
  pattern: RegExp;
  role: string;
  html: string;
}

/** 跳过的节点类型（布尔运算、切片、矢量图形等不参与布局的类型） */
const SKIP_TYPES = new Set(["BOOLEAN_OPERATION", "SLICE", "VECTOR", "STAR", "LINE", "REGULAR_POLYGON"]);
const ICON_CONTAINER_TYPES = new Set(["FRAME", "COMPONENT", "INSTANCE"]);
const ICON_NAME_PATTERN = /^(icon.*|ico(\b|[\/_\-\s]|$)|icons?(\b|[\/_\-\s]|$)|basics(\b|[\/_\-\s]|$)|module(\b|[\/_\-\s]|$)|(arrow|chevron|caret)(\b|[\/_\-\s]|$)|(edit|calendar|time|user|help|error|close|search|plus|minus|check)(\b|[\/_\-\s]|$)|用户[-_\s]?\d*)|(^|[\/_.\-\s])icon($|[\/_.\-\s])|图标/i;
const COMMON_ICON_SIZES = [4, 8, 12, 14, 16, 18, 20, 22, 24, 28, 32, 36, 40, 44, 48, 64];
const ICON_SIZE_TOLERANCE = 1;
const MAX_ICON_DIMENSION = 96;

/** 节点名称 → 语义角色映射规则表 */
const NAME_PATTERNS: NamePattern[] = [
  { pattern: /^(top.?)?nav(bar|igation)?|header/i, role: "HEADER", html: "header" },
  { pattern: /^footer/i, role: "FOOTER", html: "footer" },
  { pattern: /^side.?bar|drawer/i, role: "SIDEBAR", html: "aside" },
  { pattern: /^nav|menu|tabs/i, role: "NAV", html: "nav" },
  { pattern: /^card|tile/i, role: "CARD", html: "article" },
  { pattern: /^(btn|button|cta)/i, role: "BUTTON", html: "button" },
  { pattern: /^(input|text.?field|search.?bar)/i, role: "INPUT", html: "input" },
  { pattern: /^(modal|dialog|popup|overlay)/i, role: "DIALOG", html: "dialog" },
  { pattern: /^(avatar|profile.?pic)/i, role: "AVATAR", html: "img" },
  { pattern: /^(badge|tag|chip|pill)/i, role: "BADGE", html: "span" },
  { pattern: /^(icon.*|ico\b)/i, role: "ICON", html: "svg" },
  { pattern: /^(img|image|photo|thumbnail|banner|hero.?image)/i, role: "IMG", html: "img" },
  { pattern: /^(list|items)/i, role: "LIST", html: "ul" },
  { pattern: /^(form)/i, role: "FORM", html: "form" },
  { pattern: /^(section|block|container|wrapper)/i, role: "SECTION", html: "section" },
  { pattern: /^(divider|separator|hr)/i, role: "DIVIDER", html: "hr" },
  { pattern: /^(link|anchor)/i, role: "LINK", html: "a" },
  { pattern: /^(table|grid|data.?table)/i, role: "TABLE", html: "table" },
  { pattern: /^(dropdown|select|combobox)/i, role: "SELECT", html: "select" },
  { pattern: /^(checkbox|check)/i, role: "CHECKBOX", html: "input" },
  { pattern: /^(radio)/i, role: "RADIO", html: "input" },
  { pattern: /^(toggle|switch)/i, role: "TOGGLE", html: "input" },
  { pattern: /^(tooltip|popover)/i, role: "TOOLTIP", html: "div" },
  { pattern: /^(breadcrumb)/i, role: "BREADCRUMB", html: "nav" },
  { pattern: /^(pagination|pager)/i, role: "PAGINATION", html: "nav" },
  { pattern: /^(progress|loading|spinner)/i, role: "PROGRESS", html: "div" },
  { pattern: /^(alert|notification|toast|snackbar)/i, role: "ALERT", html: "div" },
];

const _semanticRoleCache = new WeakMap<FigmaNode, SemanticRole | null>();

/** 推断节点的语义角色（缓存结果，避免重复计算） */
export function inferSemanticRole(node: FigmaNode): SemanticRole | null {
  if (!node) return null;
  const cached = _semanticRoleCache.get(node);
  if (cached !== undefined) return cached;

  const result = _inferSemanticRoleImpl(node);
  _semanticRoleCache.set(node, result);
  return result;
}

/** 实际推断逻辑：先匹配名称规则，再按类型/结构推断 */
function _inferSemanticRoleImpl(node: FigmaNode): SemanticRole | null {
  for (const { pattern, role, html } of NAME_PATTERNS) {
    if (pattern.test(node.name)) {
      return { role, html };
    }
  }

  if (node.type === "TEXT") return { role: "TEXT", html: "span" };
  if (node.type === "IMAGE" || hasImageFill(node)) return { role: "IMG", html: "img" };

  if (node.children && node.children.length > 0) {
    const structural = inferFromStructure(node);
    if (structural) return structural;
  }

  if (node.type === "INSTANCE" && node.name) {
    return { role: node.name.toUpperCase().replace(/[^A-Z0-9]/g, "_"), html: "div" };
  }

  if (node.type === "COMPONENT" || node.type === "COMPONENT_SET") {
    return { role: "COMPONENT", html: "div" };
  }

  return null;
}

function hasImageFill(node: FigmaNode): boolean {
  return (node.fills || []).some((f) => f.type === "IMAGE" && f.visible !== false);
}

/** 从节点结构推断语义角色（按钮、卡片、header、footer 等） */
function inferFromStructure(node: FigmaNode): SemanticRole | null {
  const children = node.children || [];
  if (children.length === 0) return null;

  const bbox = node.absoluteBoundingBox;
  const hasText = children.some((c) => c.type === "TEXT");
  const hasImage = children.some((c) => c.type === "IMAGE" || hasImageFill(c));
  const isHorizontal = node.layoutMode === "HORIZONTAL";
  const isVertical = node.layoutMode === "VERTICAL";

  if (bbox && bbox.width < 300 && bbox.height < 64 && node.cornerRadius && hasText) {
    const fills = (node.fills || []).filter((f) => f.visible !== false && f.type === "SOLID");
    if (fills.length > 0) {
      return { role: "BUTTON", html: "button" };
    }
  }

  if (hasImage && hasText && (isHorizontal || isVertical)) {
    return { role: "CARD", html: "article" };
  }

  if (bbox && bbox.width > 900 && bbox.y < 100 && isHorizontal) {
    return { role: "HEADER", html: "header" };
  }

  if (bbox && bbox.width > 900 && bbox.y > 700 && isHorizontal) {
    return { role: "FOOTER", html: "footer" };
  }

  return null;
}

/** 将 Figma 节点递归简化为 SimplifiedNode 树（去除冗余属性，保留关键信息） */
export function simplifyNode(node: FigmaNode, depth: number = 0, maxDepth: number = 10): SimplifiedNode | null {
  if (depth > maxDepth) return null;
  if (!node) return null;
  if (SKIP_TYPES.has(node.type) && depth > 2) return null;
  if (node.visible === false) return null;

  const result: SimplifiedNode = {
    id: node.id,
    name: node.name,
    type: node.type,
  };

  const semantic = inferSemanticRole(node);
  if (semantic) {
    result.role = semantic.role;
    result.htmlTag = semantic.html;
  }

  const bbox = node.absoluteBoundingBox;
  if (bbox) {
    result.bounds = {
      x: Math.round(bbox.x),
      y: Math.round(bbox.y),
      w: Math.round(bbox.width),
      h: Math.round(bbox.height),
    };
  }

  const fills = (node.fills || []).filter((f) => f.visible !== false);
  if (fills.length > 0) {
    const solidFill = fills.find((f) => f.type === "SOLID");
    if (solidFill && solidFill.color) {
      result.fill = colorToString(solidFill.color, solidFill.opacity);
    }
    const gradients = fills.filter((f) => f.type?.startsWith("GRADIENT_"));
    if (gradients.length > 0) {
      result.gradient = gradients.map((g) => ({
        type: g.type,
        css: gradientToCSS(g),
      }));
    }
  }

  if (node.effects && node.effects.length > 0) {
    result.effects = parseEffects(node.effects);
  }

  const strokes = (node.strokes || []).filter((f: FigmaFill) => f.visible !== false);
  if (strokes.length > 0 && node.strokeWeight) {
    const solidStroke = strokes.find((s: FigmaFill) => s.type === "SOLID");
    if (solidStroke && solidStroke.color) {
      result.stroke = {
        color: colorToString(solidStroke.color, solidStroke.opacity),
        weight: node.strokeWeight,
      };
    }
  }

  if (node.cornerRadius) {
    result.cornerRadius = node.rectangleCornerRadii || node.cornerRadius;
  }

  if (node.layoutMode && node.layoutMode !== "NONE") {
    result.layout = {
      mode: node.layoutMode === "HORIZONTAL" ? "row" : "col",
      gap: node.itemSpacing || 0,
      padding: compactPadding(node),
      align: mapAlign(node.primaryAxisAlignItems),
      crossAlign: mapAlign(node.counterAxisAlignItems),
    };
    if (node.layoutWrap === "WRAP") result.layout.wrap = true;
    if (node.primaryAxisSizingMode === "FIXED") result.layout.mainFixed = true;
    if (node.counterAxisSizingMode === "FIXED") result.layout.crossFixed = true;
  }

  const inferredLayout = inferLayoutFromChildBounds(node);
  if (inferredLayout) {
    result.inferredLayout = inferredLayout;
  }

  if (node.type === "TEXT") {
    result.text = (node.characters || "").slice(0, 200);
    const style = node.style || {};
    result.textStyle = {};
    if (style.fontFamily) result.textStyle.font = style.fontFamily;
    if (style.fontSize) result.textStyle.size = style.fontSize;
    if (style.fontWeight) result.textStyle.weight = style.fontWeight;
    if (style.lineHeightPx) result.textStyle.lineHeight = Math.round(style.lineHeightPx * 10) / 10;
    if (style.letterSpacing) result.textStyle.letterSpacing = style.letterSpacing;
    if (style.textAlignHorizontal) result.textStyle.align = style.textAlignHorizontal.toLowerCase();

    const textFills = (node.fills || []).filter((f) => f.visible !== false && f.type === "SOLID");
    if (textFills.length > 0) {
      result.textStyle.color = colorToString(textFills[0].color!, textFills[0].opacity);
    }

    if (Object.keys(result.textStyle).length === 0) delete result.textStyle;
  }

  if (node.type === "INSTANCE" && node.componentId) {
    result.componentId = node.componentId;
  }
  if (node.type === "COMPONENT" || node.type === "COMPONENT_SET") {
    result.isComponent = true;
    if (node.description) result.description = node.description;
  }

  if (node.boundVariables) {
    const tokens: Record<string, any> = {};
    for (const [prop, binding] of Object.entries(node.boundVariables)) {
      if (binding && binding.id) {
        tokens[prop] = binding.id;
      } else if (Array.isArray(binding)) {
        tokens[prop] = binding.map((b: any) => b.id).filter(Boolean);
      }
    }
    if (Object.keys(tokens).length > 0) {
      result.tokens = tokens;
    }
  }

  if (node.opacity !== undefined && node.opacity !== 1) {
    result.opacity = Math.round(node.opacity * 100) / 100;
  }

  const resize = nodeResizeSemantics(node);
  if (resize) {
    (result as any).resize = resize;
  }

  if (isAbsolutePositionedNode(node)) {
    result.position = "absolute";
  }

  if (node.constraints) {
    const { horizontal, vertical } = node.constraints;
    if (horizontal !== "LEFT" || vertical !== "TOP") {
      result.constraints = { h: horizontal, v: vertical };
    }
    const hint = inferResponsiveHint(node);
    if (hint) result.responsiveHint = hint;
  }

  if (node.children && node.children.length > 0) {
    const children = node.children
      .map((child) => simplifyNode(child, depth + 1, maxDepth))
      .filter(Boolean) as SimplifiedNode[];
    if (children.length > 0) {
      result.children = children;
    }
  }

  return result;
}

/** 递归收集文件中所有 COMPONENT 节点，构建 componentId → {name, description} 映射 */
export function buildComponentMap(node: FigmaNode, map: Record<string, { name: string; description: string | null }> = {}): Record<string, { name: string; description: string | null }> {
  if (node.type === "COMPONENT") {
    map[node.id] = {
      name: node.name,
      description: node.description || null,
    };
  }
  if (node.children) {
    for (const child of node.children) {
      buildComponentMap(child, map);
    }
  }
  return map;
}

/** 生成节点树的统计摘要（总节点数、类型分布、文本内容、组件实例） */
export function generateSummary(tree: SimplifiedNode | null): any {
  if (!tree) return null;

  const stats = { total: 0, types: {} as Record<string, number>, texts: [] as string[], components: [] as string[] };
  walkTree(tree, stats);

  return {
    rootName: tree.name,
    rootType: tree.type,
    rootSize: tree.bounds ? `${tree.bounds.w}x${tree.bounds.h}` : null,
    totalNodes: stats.total,
    nodeTypes: stats.types,
    textContents: stats.texts.slice(0, 20),
    componentInstances: stats.components.slice(0, 20),
  };
}

/** 生成 condensed v1 格式文本（带 token 预算参数，实际不截断，仅规范化深度） */
export function toCondensedWithBudget(
  node: FigmaNode,
  _maxTokens: number = 4000,
  variableMap: CondensedVariableMap | null = null,
  svgMap: CondensedSvgMap | null = null,
  maxDepth: number = 15
): string {
  const effectiveMaxDepth = normalizeMaxDepth(maxDepth, 15);
  return toCondensedFormat(node, 0, effectiveMaxDepth, variableMap, svgMap);
}

/** 递归生成 condensed v1 格式：每个节点一行，缩进表示层级 */
export function toCondensedFormat(
  node: FigmaNode,
  depth: number = 0,
  maxDepth: number = 10,
  variableMap: CondensedVariableMap | null = null,
  svgMap: CondensedSvgMap | null = null
): string {
  if (depth > maxDepth) return "";
  if (!node) return "";
  if (SKIP_TYPES.has(node.type) && depth > 2) return "";
  if (node.visible === false) return "";

  const lines: string[] = [];
  lines.push(toCondensedLine(node, depth, variableMap, svgMap));

  if (node.children) {
    for (const child of node.children) {
      const childOutput = toCondensedFormat(child, depth + 1, maxDepth, variableMap, svgMap);
      if (childOutput) lines.push(childOutput);
    }
  }

  return lines.join("\n");
}

interface CondensedV2IconEntry {
  ref: string;
  nodeId: string;
  name: string;
  filename?: string;
  path?: string;
  href?: string;
}

interface CondensedV2Context {
  sizes: Map<string, string>;
  sizeCounts: Map<string, number>;
  colors: Map<string, string>;
  gradients: Map<string, string>;
  effects: Map<string, string>;
  icons: Map<string, CondensedV2IconEntry>;
  styleCounts: Map<string, number>;
  styleOrder: string[];
  styleRefs: Map<string, string>;
  overlayDecorNodes: Set<string>;
  overlayParentDecorNodes: Set<string>;
  overlayContentNodes: Set<string>;
  overlayParentNodes: Set<string>;
  nodeCount: number;
  svgBase?: string;
  svgHrefBase?: string;
}

/** 生成 condensed v2 格式文本（带 token 预算参数） */
export function toCondensedV2WithBudget(
  node: FigmaNode,
  _maxTokens: number = 4000,
  variableMap: CondensedVariableMap | null = null,
  svgMap: CondensedSvgMap | null = null,
  maxDepth: number = 15
): string {
  const effectiveMaxDepth = normalizeMaxDepth(maxDepth, 15);
  return toCondensedV2Format(node, 0, effectiveMaxDepth, variableMap, svgMap);
}

/**
 * 生成 condensed v2 格式：包含 @format/@assets/@sizes/@colors/@styles/@tree 等段落
 * 比 v1 更结构化，提取公共样式为引用，减少重复
 */
export function toCondensedV2Format(
  node: FigmaNode,
  depth: number = 0,
  maxDepth: number = 10,
  variableMap: CondensedVariableMap | null = null,
  svgMap: CondensedSvgMap | null = null
): string {
  if (!node) return "";
  if (depth > maxDepth) return "";
  if (SKIP_TYPES.has(node.type) && depth > 2) return "";
  if (node.visible === false) return "";

  const ctx = createCondensedV2Context(node, depth, maxDepth, variableMap, svgMap);
  const tree = toCondensedV2Tree(node, depth, maxDepth, variableMap, svgMap, ctx);
  if (!tree) return "";

  const lines: string[] = [
    "@format condensed-v2",
    condensedV2MetaLine(node, ctx),
  ];

  const assets = condensedV2AssetsLines(ctx);
  if (assets.length > 0) lines.push("", "@assets", ...assets);

  appendCondensedV2MapSection(lines, "@sizes", ctx.sizes);
  appendCondensedV2MapSection(lines, "@colors", ctx.colors);
  appendCondensedV2MapSection(lines, "@gradients", ctx.gradients);
  appendCondensedV2MapSection(lines, "@effects", ctx.effects);

  if (ctx.icons.size > 0) {
    lines.push("", "@icons");
    for (const icon of ctx.icons.values()) {
      const parts = [
        icon.ref,
        `node:${quoteCondensedValue(icon.nodeId)}`,
        `name:${quoteCondensedValue(icon.name)}`,
      ];
      if (icon.filename) parts.push(`svg:${quoteCondensedValue(icon.filename)}`);
      if (icon.path && !ctx.svgBase) parts.push(`path:${quoteCondensedPath(icon.path)}`);
      if (icon.href && !ctx.svgHrefBase) parts.push(`href:${quoteCondensedValue(icon.href)}`);
      lines.push(parts.join(" "));
    }
  }

  if (ctx.styleRefs.size > 0) {
    lines.push("", "@styles");
    for (const [signature, ref] of ctx.styleRefs.entries()) {
      lines.push(`${ref}=${signature}`);
    }
  }

  lines.push("", "@tree", tree);
  return lines.join("\n");
}

/** 生成 semantic JSON 格式：结构化 JSON，含语义角色、变量定义、能力声明 */
export function toSemanticJson(
  node: FigmaNode,
  options: SemanticTransformOptions = {}
): any {
  const maxDepth = normalizeMaxDepth(options.maxDepth, 10);
  const variableDefinitions = options.variableDefinitions || null;
  const variableMap = options.variableMap || semanticDefinitionsToVariableMap(variableDefinitions);
  const capabilities = semanticCapabilities(options.capabilities, variableDefinitions);

  return {
    format: "semantic-json",
    capabilities,
    tokens: variableDefinitions && Object.keys(variableDefinitions).length > 0 ? variableDefinitions : null,
    tree: toSemanticNode(node, 0, maxDepth, variableMap, variableDefinitions, options.svgMap || null),
  };
}

/** 生成 condensed v3 格式文本（最完整版本，含变量定义和能力声明） */
export function toCondensedV3WithBudget(
  node: FigmaNode,
  _maxTokens: number = 4000,
  options: SemanticTransformOptions = {}
): string {
  const maxDepth = normalizeMaxDepth(options.maxDepth, 15);
  const variableDefinitions = options.variableDefinitions || null;

  return toCondensedV3Format(node, {
    ...options,
    maxDepth,
    variableDefinitions,
  });
}

/**
 * 生成 condensed v3 格式：在 v2 基础上增加 @capabilities/@tokens 段落
 * 是最完整的文本格式输出
 */
export function toCondensedV3Format(
  node: FigmaNode,
  options: SemanticTransformOptions = {}
): string {
  const maxDepth = normalizeMaxDepth(options.maxDepth, 10);
  const variableDefinitions = options.variableDefinitions || null;
  const variableMap = options.variableMap || semanticDefinitionsToVariableMap(variableDefinitions);
  const capabilities = semanticCapabilities(options.capabilities, variableDefinitions);
  const semantic = toSemanticNode(node, 0, maxDepth, variableMap, variableDefinitions, options.svgMap || null);

  const lines: string[] = [
    "@format condensed-v3",
    `@capabilities fileContent:${capabilities.fileContent} variables:${capabilities.variables} variableModeValues:${capabilities.variableModeValues} devResources:${capabilities.devResources} devModeMeta:${capabilities.devModeMeta}`,
  ];
  if (capabilities.variablesReason) lines.push(`@capability-note variables:${quoteCondensedValue(capabilities.variablesReason)}`);

  appendCondensedV3TokenSection(lines, variableDefinitions);
  appendCondensedV3NodeSections(lines, semantic);

  const base = toCondensedV2Format(node, 0, maxDepth, variableMap, options.svgMap || null);
  if (base) lines.push("", "@tree", base.replace(/^@format condensed-v2\n/, ""));

  return lines.join("\n");
}

function semanticCapabilities(
  provided: Partial<SemanticCapabilities> | undefined,
  variableDefinitions: Record<string, SemanticVariableDefinition> | null
): SemanticCapabilities {
  const hasVariables = Boolean(variableDefinitions && Object.keys(variableDefinitions).length > 0);
  return {
    fileContent: true,
    variables: hasVariables,
    variableModeValues: hasVariables,
    devResources: "not_requested",
    devModeMeta: "from_file_node_if_present",
    ...provided,
  };
}

/** 递归构建 semantic JSON 节点（含语义角色、布局、视觉、文本、组件等信息） */
function toSemanticNode(
  node: FigmaNode,
  depth: number,
  maxDepth: number,
  variableMap: CondensedVariableMap | null,
  variableDefinitions: Record<string, SemanticVariableDefinition> | null,
  svgMap: CondensedSvgMap | null
): any {
  if (!node || depth > maxDepth || node.visible === false) return null;
  if (SKIP_TYPES.has(node.type) && depth > 2) return null;

  const semantic = inferSemanticRole(node);
  const result: any = {
    id: node.id,
    name: node.name,
    type: node.type,
  };

  if (semantic) result.semantic = { role: semantic.role, html: semantic.html };
  if (node.absoluteBoundingBox) {
    result.bounds = {
      x: roundNumber(node.absoluteBoundingBox.x),
      y: roundNumber(node.absoluteBoundingBox.y),
      w: roundNumber(node.absoluteBoundingBox.width),
      h: roundNumber(node.absoluteBoundingBox.height),
    };
  }

  const resize = nodeResizeSemantics(node);
  if (resize) result.resize = resize;

  const layout = semanticLayout(node);
  if (layout) result.layout = layout;

  const visual = semanticVisual(node, variableMap, variableDefinitions, svgMap);
  if (Object.keys(visual).length > 0) result.visual = visual;

  const text = semanticText(node);
  if (text) result.text = text;

  const component = semanticComponent(node);
  if (component) result.component = component;

  const dev = semanticDevMeta(node);
  if (dev) result.dev = dev;

  const interactions = semanticInteractions(node);
  if (interactions) result.interactions = interactions;

  if (isAbsolutePositionedNode(node)) result.position = "absolute";
  if (node.constraints) result.constraints = { h: node.constraints.horizontal, v: node.constraints.vertical };

  const tokenBindings = semanticVariableBindings(node, variableMap, variableDefinitions);
  if (tokenBindings.length > 0) result.variableBindings = tokenBindings;

  const children = (node.children || [])
    .map((child) => toSemanticNode(child, depth + 1, maxDepth, variableMap, variableDefinitions, svgMap))
    .filter(Boolean);
  if (children.length > 0) result.children = children;

  return result;
}

function semanticLayout(node: FigmaNode): any | null {
  const layout: any = {};

  if (node.layoutMode && node.layoutMode !== "NONE") {
    layout.mode = node.layoutMode === "HORIZONTAL" ? "row" : node.layoutMode === "VERTICAL" ? "column" : node.layoutMode.toLowerCase();
    if (node.itemSpacing !== undefined) layout.gap = node.itemSpacing;
    layout.padding = {
      top: node.paddingTop || 0,
      right: node.paddingRight || 0,
      bottom: node.paddingBottom || 0,
      left: node.paddingLeft || 0,
    };
    if (node.primaryAxisAlignItems) layout.primaryAlign = mapAlign(node.primaryAxisAlignItems);
    if (node.counterAxisAlignItems) layout.counterAlign = mapAlign(node.counterAxisAlignItems);
    if (node.layoutWrap === "WRAP") layout.wrap = true;
    if (node.primaryAxisSizingMode) layout.primarySizing = normalizeSizingMode(node.primaryAxisSizingMode);
    if (node.counterAxisSizingMode) layout.counterSizing = normalizeSizingMode(node.counterAxisSizingMode);
  }

  const grid = semanticGrid(node);
  if (grid) layout.grid = grid;

  const inferredLayout = inferLayoutFromChildBounds(node);
  if (inferredLayout) layout.inferred = inferredLayout;

  if (node.clipsContent !== undefined) layout.clipsContent = node.clipsContent;
  if (node.overflowDirection) layout.overflowDirection = node.overflowDirection;

  return Object.keys(layout).length > 0 ? layout : null;
}

function semanticGrid(node: FigmaNode): any | null {
  const gridKeys = [
    "gridRowCount",
    "gridColumnCount",
    "gridRowsSizing",
    "gridColumnsSizing",
    "gridRowGap",
    "gridColumnGap",
    "gridRowSpan",
    "gridColumnSpan",
    "gridChildHorizontalAlign",
    "gridChildVerticalAlign",
  ];
  const grid: any = {};
  for (const key of gridKeys) {
    if (node[key] !== undefined) grid[key] = node[key];
  }
  return Object.keys(grid).length > 0 ? grid : null;
}

function semanticVisual(
  node: FigmaNode,
  variableMap: CondensedVariableMap | null,
  variableDefinitions: Record<string, SemanticVariableDefinition> | null,
  svgMap: CondensedSvgMap | null
): any {
  const visual: any = {};
  const fills = (node.fills || []).filter((fill) => fill.visible !== false);
  if (fills.length > 0) {
    visual.fills = fills.map((fill, index) => semanticPaint(fill, `fill[${index}]`, variableMap, variableDefinitions));
  }

  const strokes = (node.strokes || []).filter((stroke) => stroke.visible !== false);
  if (strokes.length > 0) {
    visual.strokes = strokes.map((stroke, index) => semanticPaint(stroke, `stroke[${index}]`, variableMap, variableDefinitions));
    if (node.strokeWeight !== undefined) visual.strokeWeight = node.strokeWeight;
  }

  const effects = parseEffects(node.effects);
  if (effects) visual.effects = effects;
  if (node.cornerRadius !== undefined || node.rectangleCornerRadii) visual.radius = node.rectangleCornerRadii || node.cornerRadius;
  if (node.opacity !== undefined && node.opacity !== 1) visual.opacity = roundNumber(node.opacity);
  if (node.blendMode) visual.blendMode = node.blendMode;

  const svgRef = svgMap?.[node.id];
  if (svgRef) visual.svg = svgRef;
  if (hasImageFill(node)) visual.hasImage = true;

  return visual;
}

function semanticPaint(
  paint: FigmaFill,
  prop: string,
  variableMap: CondensedVariableMap | null,
  variableDefinitions: Record<string, SemanticVariableDefinition> | null
): any {
  const result: any = { type: paint.type };
  if (paint.opacity !== undefined) result.opacity = paint.opacity;
  if (paint.type === "SOLID" && paint.color) result.color = colorToString(paint.color, paint.opacity);
  if (paint.type?.startsWith("GRADIENT_")) result.gradient = gradientToCSS(paint);
  if (paint.type === "IMAGE" || paint.type === "VIDEO" || paint.type === "PATTERN") {
    for (const key of ["imageRef", "gifRef", "scaleMode", "scalingFactor", "rotation", "filters"]) {
      if ((paint as any)[key] !== undefined) result[key] = (paint as any)[key];
    }
  }

  const bindings = paintVariableBindings(paint, prop, variableMap, variableDefinitions);
  if (bindings.length > 0) result.variables = bindings;
  return result;
}

function semanticText(node: FigmaNode): any | null {
  if (node.type !== "TEXT") return null;
  const text = node.characters || "";
  const style = node.style || {};
  const result: any = {
    value: text.slice(0, 500),
    length: text.length,
    truncated: text.length > 500,
  };
  const typeStyle: any = {};
  for (const key of [
    "fontFamily",
    "fontPostScriptName",
    "fontSize",
    "fontWeight",
    "lineHeightPx",
    "lineHeightPercent",
    "letterSpacing",
    "textAlignHorizontal",
    "textAlignVertical",
    "textCase",
    "textDecoration",
    "paragraphSpacing",
    "paragraphIndent",
  ]) {
    if (style[key] !== undefined) typeStyle[key] = style[key];
  }
  if (Object.keys(typeStyle).length > 0) result.style = typeStyle;
  for (const key of ["textAutoResize", "textTruncation", "maxLines"]) {
    if (node[key] !== undefined) result[key] = node[key];
  }
  return result;
}

function semanticComponent(node: FigmaNode): any | null {
  const result: any = {};
  if (node.componentId) result.componentId = node.componentId;
  if (node.type === "COMPONENT" || node.type === "COMPONENT_SET") result.isDefinition = true;
  if (node.description) result.description = node.description;
  if (node.componentProperties) result.properties = node.componentProperties;
  if (node.componentPropertyDefinitions) result.propertyDefinitions = node.componentPropertyDefinitions;
  if (node.overrides) result.overrides = node.overrides;
  return Object.keys(result).length > 0 ? result : null;
}

function semanticDevMeta(node: FigmaNode): any | null {
  const result: any = {};
  for (const key of ["devStatus", "annotations", "measurements"]) {
    if (node[key] !== undefined) result[key] = node[key];
  }
  return Object.keys(result).length > 0 ? result : null;
}

function semanticInteractions(node: FigmaNode): any[] | null {
  return Array.isArray(node.interactions) && node.interactions.length > 0 ? node.interactions : null;
}

function semanticVariableBindings(
  node: FigmaNode,
  variableMap: CondensedVariableMap | null,
  variableDefinitions: Record<string, SemanticVariableDefinition> | null
): any[] {
  const bindings: any[] = [];
  const add = (prop: string, id: unknown): void => {
    if (typeof id !== "string") return;
    bindings.push(variableBindingObject(prop, id, variableMap, variableDefinitions));
  };

  if (node.boundVariables) {
    for (const [prop, binding] of Object.entries(node.boundVariables)) {
      if (Array.isArray(binding)) {
        binding.forEach((item, index) => add(`${prop}[${index}]`, item?.id));
      } else {
        add(prop, (binding as any)?.id);
      }
    }
  }

  for (const [index, fill] of (node.fills || []).entries()) {
    add(`fill[${index}].color`, fill.boundVariables?.color?.id);
    for (const [stopIndex, stop] of (fill.gradientStops || []).entries()) {
      add(`fill[${index}].stop[${stopIndex}]`, stop.boundVariables?.color?.id);
    }
  }

  for (const [index, stroke] of (node.strokes || []).entries()) {
    add(`stroke[${index}].color`, stroke.boundVariables?.color?.id);
    for (const [stopIndex, stop] of (stroke.gradientStops || []).entries()) {
      add(`stroke[${index}].stop[${stopIndex}]`, stop.boundVariables?.color?.id);
    }
  }

  for (const [index, effect] of (node.effects || []).entries()) {
    add(`effect[${index}].color`, effect.boundVariables?.color?.id);
  }

  return dedupeBindings(bindings);
}

function paintVariableBindings(
  paint: FigmaFill,
  prop: string,
  variableMap: CondensedVariableMap | null,
  variableDefinitions: Record<string, SemanticVariableDefinition> | null
): any[] {
  const bindings: any[] = [];
  if (paint.boundVariables?.color?.id) {
    bindings.push(variableBindingObject(`${prop}.color`, paint.boundVariables.color.id, variableMap, variableDefinitions));
  }
  for (const [index, stop] of (paint.gradientStops || []).entries()) {
    if (stop.boundVariables?.color?.id) {
      bindings.push(variableBindingObject(`${prop}.stop[${index}]`, stop.boundVariables.color.id, variableMap, variableDefinitions));
    }
  }
  return dedupeBindings(bindings);
}

function variableBindingObject(
  prop: string,
  id: string,
  variableMap: CondensedVariableMap | null,
  variableDefinitions: Record<string, SemanticVariableDefinition> | null
): any {
  const definition = variableDefinitions?.[id];
  return {
    prop,
    id,
    cssVar: definition?.cssVar || variableMap?.[id],
    name: definition?.name,
    collection: definition?.collectionName,
    type: definition?.type,
    unresolved: !definition,
  };
}

function dedupeBindings(bindings: any[]): any[] {
  const seen = new Set<string>();
  return bindings.filter((binding) => {
    const key = `${binding.prop}:${binding.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function appendCondensedV3TokenSection(
  lines: string[],
  definitions: Record<string, SemanticVariableDefinition> | null
): void {
  if (!definitions || Object.keys(definitions).length === 0) return;
  lines.push("", "@tokens");
  for (const definition of Object.values(definitions)) {
    const parts = [
      quoteCondensedValue(definition.id),
      `name:${quoteCondensedValue(definition.name)}`,
      `css:${quoteCondensedValue(definition.cssVar)}`,
    ];
    if (definition.type) parts.push(`type:${definition.type}`);
    if (definition.collectionName) parts.push(`collection:${quoteCondensedValue(definition.collectionName)}`);
    if (definition.values) parts.push(`values:${quoteCondensedValue(JSON.stringify(definition.values))}`);
    lines.push(parts.join(" "));
  }
}

function appendCondensedV3NodeSections(lines: string[], node: any): void {
  const layoutLines: string[] = [];
  const componentLines: string[] = [];
  const assetLines: string[] = [];
  const textLines: string[] = [];
  const devLines: string[] = [];
  const interactionLines: string[] = [];

  walkSemanticNodes(node, (current) => {
    if (current.layout || current.resize || current.constraints) {
      const parts = [`node:${quoteCondensedValue(current.id)}`];
      if (current.layout?.mode) parts.push(`mode:${current.layout.mode}`);
      if (current.layout?.gap !== undefined) parts.push(`gap:${current.layout.gap}`);
      if (current.resize) parts.push(`resize:x-${current.resize.horizontal}/y-${current.resize.vertical}`);
      if (current.layout?.grid) parts.push(`grid:${quoteCondensedValue(JSON.stringify(current.layout.grid))}`);
      if (current.constraints) parts.push(`constraints:${quoteCondensedValue(`${current.constraints.h}/${current.constraints.v}`)}`);
      layoutLines.push(parts.join(" "));
    }
    if (current.component) {
      componentLines.push(`node:${quoteCondensedValue(current.id)} ${quoteCondensedValue(JSON.stringify(current.component))}`);
    }
    if (current.visual?.hasImage || current.visual?.svg) {
      assetLines.push(`node:${quoteCondensedValue(current.id)} ${quoteCondensedValue(JSON.stringify({ svg: current.visual.svg, hasImage: current.visual.hasImage }))}`);
    }
    if (current.text) {
      textLines.push(`node:${quoteCondensedValue(current.id)} len:${current.text.length} truncated:${current.text.truncated} ${quoteCondensedValue(current.text.value)}`);
    }
    if (current.dev) {
      devLines.push(`node:${quoteCondensedValue(current.id)} ${quoteCondensedValue(JSON.stringify(current.dev))}`);
    }
    if (current.interactions) {
      interactionLines.push(`node:${quoteCondensedValue(current.id)} ${quoteCondensedValue(JSON.stringify(current.interactions))}`);
    }
  });

  appendLines(lines, "@layout", layoutLines);
  appendLines(lines, "@components", componentLines);
  appendLines(lines, "@assets-semantic", assetLines);
  appendLines(lines, "@text", textLines);
  appendLines(lines, "@dev", devLines);
  appendLines(lines, "@interactions", interactionLines);
}

function walkSemanticNodes(node: any, visitor: (node: any) => void): void {
  if (!node) return;
  visitor(node);
  for (const child of node.children || []) {
    walkSemanticNodes(child, visitor);
  }
}

function appendLines(lines: string[], header: string, sectionLines: string[]): void {
  if (sectionLines.length === 0) return;
  lines.push("", header, ...sectionLines);
}

function createCondensedV2Context(
  node: FigmaNode,
  depth: number,
  maxDepth: number,
  variableMap: CondensedVariableMap | null,
  svgMap: CondensedSvgMap | null
): CondensedV2Context {
  const ctx: CondensedV2Context = {
    sizes: new Map(),
    sizeCounts: new Map(),
    colors: new Map(),
    gradients: new Map(),
    effects: new Map(),
    icons: new Map(),
    styleCounts: new Map(),
    styleOrder: [],
    styleRefs: new Map(),
    overlayDecorNodes: new Set(),
    overlayParentDecorNodes: new Set(),
    overlayContentNodes: new Set(),
    overlayParentNodes: new Set(),
    nodeCount: 0,
  };

  collectCondensedV2SvgBases(node, depth, maxDepth, svgMap, ctx);
  collectCondensedV2Overlays(node, depth, maxDepth, ctx);
  collectCondensedV2Tokens(node, depth, maxDepth, variableMap, svgMap, ctx);

  let styleIndex = 1;
  for (const signature of ctx.styleOrder) {
    const count = ctx.styleCounts.get(signature) || 0;
    const tokenCount = signature.split(" ").filter(Boolean).length;
    if (count >= 2 && tokenCount >= 2) {
      ctx.styleRefs.set(signature, `s${styleIndex++}`);
    }
  }

  return ctx;
}

function collectCondensedV2SvgBases(
  node: FigmaNode,
  depth: number,
  maxDepth: number,
  svgMap: CondensedSvgMap | null,
  ctx: CondensedV2Context
): void {
  const paths: string[] = [];
  const hrefs: string[] = [];

  walkCondensedV2Nodes(node, depth, maxDepth, (current) => {
    const svgRef = svgMap?.[current.id];
    if (svgRef?.path) paths.push(normalizeCondensedPath(svgRef.path));
    if (svgRef?.href) hrefs.push(svgRef.href);
  });

  const svgBase = commonBaseDirectory(paths);
  if (svgBase) ctx.svgBase = svgBase;
  const svgHrefBase = commonBaseDirectory(hrefs);
  if (svgHrefBase) ctx.svgHrefBase = svgHrefBase;
}

function collectCondensedV2Tokens(
  node: FigmaNode,
  depth: number,
  maxDepth: number,
  variableMap: CondensedVariableMap | null,
  svgMap: CondensedSvgMap | null,
  ctx: CondensedV2Context
): void {
  walkCondensedV2Nodes(node, depth, maxDepth, (current) => {
    ctx.nodeCount += 1;
    collectCondensedV2Size(current, ctx);
    registerCondensedV2Icon(current, svgMap, ctx);
    const tokens = condensedV2StyleTokens(current, variableMap, ctx);
    const signature = tokens.join(" ");
    if (signature) {
      if (!ctx.styleCounts.has(signature)) {
        ctx.styleOrder.push(signature);
      }
      ctx.styleCounts.set(signature, (ctx.styleCounts.get(signature) || 0) + 1);
    }
  });
}

function collectCondensedV2Overlays(
  node: FigmaNode,
  depth: number,
  maxDepth: number,
  ctx: CondensedV2Context
): void {
  walkCondensedV2Nodes(node, depth, maxDepth, (parent) => {
    const children = (parent.children || []).filter((child) => child.visible !== false);
    if (children.length === 0) return;

    if (children.length >= 2) {
      for (let i = 0; i < children.length - 1; i++) {
        const decor = children[i];
        const content = children[i + 1];
        if (!isLikelyOverlayPair(decor, content)) continue;

        ctx.overlayParentNodes.add(parent.id);
        ctx.overlayDecorNodes.add(decor.id);
        ctx.overlayContentNodes.add(content.id);
      }
    }

    if (isLikelyIconNode(parent)) return;

    const hasLayoutContent = children.some((child) => (
      !isLikelyParentBackgroundDecor(child) && hasMeaningfulContent(child)
    ));
    if (!hasLayoutContent) return;

    for (const child of children) {
      if (!isLikelyParentBackgroundDecor(child)) continue;
      ctx.overlayParentNodes.add(parent.id);
      ctx.overlayParentDecorNodes.add(child.id);
    }
  });
}

function walkCondensedV2Nodes(
  node: FigmaNode,
  depth: number,
  maxDepth: number,
  visitor: (node: FigmaNode, depth: number) => void
): void {
  if (!node) return;
  if (depth > maxDepth) return;
  if (SKIP_TYPES.has(node.type) && depth > 2) return;
  if (node.visible === false) return;

  visitor(node, depth);

  if (node.children) {
    for (const child of node.children) {
      walkCondensedV2Nodes(child, depth + 1, maxDepth, visitor);
    }
  }
}

function toCondensedV2Tree(
  node: FigmaNode,
  depth: number,
  maxDepth: number,
  variableMap: CondensedVariableMap | null,
  svgMap: CondensedSvgMap | null,
  ctx: CondensedV2Context
): string {
  if (depth > maxDepth) return "";
  if (!node) return "";
  if (SKIP_TYPES.has(node.type) && depth > 2) return "";
  if (node.visible === false) return "";

  const lines: string[] = [toCondensedV2Line(node, depth, variableMap, svgMap, ctx)];

  if (node.children) {
    for (const child of node.children) {
      const childOutput = toCondensedV2Tree(child, depth + 1, maxDepth, variableMap, svgMap, ctx);
      if (childOutput) lines.push(childOutput);
    }
  }

  return lines.join("\n");
}

function toCondensedV2Line(
  node: FigmaNode,
  depth: number,
  variableMap: CondensedVariableMap | null,
  svgMap: CondensedSvgMap | null,
  ctx: CondensedV2Context
): string {
  const indent = "  ".repeat(depth);
  const semantic = inferSemanticRole(node);
  const type = semantic ? semantic.role : node.type;
  const parts: string[] = [`[${type}`, quoteCondensedValue(node.name)];
  const size = condensedV2SizeValue(node);
  if (size) {
    const sizeRef = ctx.sizes.get(size);
    parts.push(sizeRef ? `size:${sizeRef}` : size);
  }

  const icon = ctx.icons.get(node.id);
  if (icon) {
    parts.push(`icon:${icon.ref}`);
  } else if (isLikelyIconNode(node) || svgMap?.[node.id]) {
    parts.push("icon");
  }

  if (ctx.overlayParentNodes.has(node.id)) {
    parts.push("has-overlay");
  }
  if (ctx.overlayDecorNodes.has(node.id)) {
    parts.push("overlay:next");
    parts.push("layer:decor");
  } else if (ctx.overlayParentDecorNodes.has(node.id)) {
    parts.push("overlay:parent");
    parts.push("layer:decor");
  } else if (ctx.overlayContentNodes.has(node.id)) {
    parts.push("layer:content");
  }
  if (isAbsolutePositionedNode(node)) {
    parts.push("pos:absolute");
  }

  const styleTokens = condensedV2StyleTokens(node, variableMap, ctx);
  const signature = styleTokens.join(" ");
  const styleRef = ctx.styleRefs.get(signature);
  if (styleRef) {
    parts.push(`@${styleRef}`);
  } else {
    parts.push(...styleTokens);
  }

  if (node.type === "TEXT") {
    const text = (node.characters || "").slice(0, 80);
    if (text) parts.push(quoteCondensedValue(text));
  }

  if (hasImageFill(node) && node.type !== "IMAGE") {
    parts.push("has-image");
  }

  if (semantic && semantic.html !== "div" && semantic.html !== "span") {
    parts.push(`<${semantic.html}>`);
  }

  return `${indent}${parts.join(" ")}]`;
}

function condensedV2StyleTokens(
  node: FigmaNode,
  variableMap: CondensedVariableMap | null,
  ctx: CondensedV2Context
): string[] {
  const tokens: string[] = [];
  const allFills = (node.fills || []).filter((f) => f.visible !== false);
  const solidFills = allFills.filter((f) => f.type === "SOLID");
  const gradientFills = allFills.filter((f) => f.type?.startsWith("GRADIENT_"));

  if (node.type !== "TEXT") {
    if (gradientFills.length > 0) {
      const cssGradient = gradientToCSS(gradientFills[0]);
      if (cssGradient) tokens.push(`bg:${registerCondensedV2Value(ctx.gradients, "g", cssGradient)}`);
    } else if (solidFills.length > 0) {
      const color = colorToString(solidFills[0].color, solidFills[0].opacity);
      if (color) tokens.push(`bg:${registerCondensedV2Value(ctx.colors, "c", color)}`);
    }
  }

  const effects = parseEffects(node.effects);
  if (effects) {
    for (const effect of effects) {
      const effectToken = condensedV2EffectValue(effect, ctx);
      if (effectToken) tokens.push(`fx:${registerCondensedV2Value(ctx.effects, "e", effectToken)}`);
    }
  }

  if (node.cornerRadius) {
    tokens.push(`radius:${node.cornerRadius}`);
  } else if (node.rectangleCornerRadii) {
    const r = node.rectangleCornerRadii;
    if (r[0] === r[1] && r[1] === r[2] && r[2] === r[3]) {
      if (r[0] > 0) tokens.push(`radius:${r[0]}`);
    } else {
      tokens.push(`radius:${r.join(",")}`);
    }
  }

  const strokes = (node.strokes || []).filter((s) => s.visible !== false);
  if (strokes.length > 0 && strokes[0].color) {
    const color = colorToString(strokes[0].color);
    if (color) tokens.push(`border:${node.strokeWeight || 1}px,${registerCondensedV2Value(ctx.colors, "c", color)}`);
  }

  if (node.layoutMode && node.layoutMode !== "NONE") {
    tokens.push(node.layoutMode === "HORIZONTAL" ? "flex-row" : "flex-col");
    if (node.itemSpacing) tokens.push(`gap:${node.itemSpacing}`);

    const padding = compactPadding(node);
    if (padding && padding !== 0 && padding !== "0") {
      tokens.push(`p:${padding}`);
    }

    const align = mapAlign(node.primaryAxisAlignItems);
    if (align && align !== "start") tokens.push(align);
    const crossAlign = mapAlign(node.counterAxisAlignItems);
    if (crossAlign && crossAlign !== "start") tokens.push(`cross:${crossAlign}`);

    if (node.layoutWrap === "WRAP") tokens.push("wrap");
  }

  const inferredLayout = inferLayoutFromChildBounds(node);
  if (inferredLayout) {
    tokens.push(`inferred-${inferredLayout.mode}`);
    if (inferredLayout.gap) tokens.push(`inferred-gap:${inferredLayout.gap}`);
    tokens.push(`confidence:${inferredLayout.confidence}`);
  }

  if (node.opacity !== undefined && node.opacity !== 1) {
    tokens.push(`opacity:${Math.round(node.opacity * 100) / 100}`);
  }

  const resize = nodeResizeSemantics(node);
  if (resize) tokens.push(`resize:x-${resize.horizontal}/y-${resize.vertical}`);

  if (node.type === "TEXT") {
    const style = node.style || {};
    const textParts: string[] = [];
    if (style.fontSize) textParts.push(`${style.fontSize}`);
    if (style.fontWeight) textParts.push(`${style.fontWeight}`);
    if (textParts.length > 0) tokens.push(`font:${textParts.join("/")}`);

    const textFills = (node.fills || []).filter((f) => f.visible !== false && f.type === "SOLID");
    if (textFills.length > 0) {
      const color = colorToString(textFills[0].color, textFills[0].opacity);
      if (color) tokens.push(`text:${registerCondensedV2Value(ctx.colors, "c", color)}`);
    }
  }

  if (variableMap) {
    const tokenParts = collectVariableTokenParts(node, variableMap, "=");
    if (tokenParts.length > 0) {
      tokens.push(`vars:{${tokenParts.join(",")}}`);
    }
  }

  return tokens;
}

function collectCondensedV2Size(node: FigmaNode, ctx: CondensedV2Context): void {
  const size = condensedV2SizeValue(node);
  if (!size) return;

  const count = (ctx.sizeCounts.get(size) || 0) + 1;
  ctx.sizeCounts.set(size, count);

  if (count === 2 && !ctx.sizes.has(size)) {
    ctx.sizes.set(size, `z${ctx.sizes.size + 1}`);
  }
}

function condensedV2SizeValue(node: FigmaNode): string | null {
  const bbox = node.absoluteBoundingBox;
  if (!bbox) return null;
  return `${Math.round(bbox.width)}x${Math.round(bbox.height)}`;
}

function isAbsolutePositionedNode(node: FigmaNode): boolean {
  return node.layoutPositioning === "ABSOLUTE";
}

function isLikelyOverlayPair(decor: FigmaNode, content: FigmaNode): boolean {
  const decorBox = decor.absoluteBoundingBox;
  const contentBox = content.absoluteBoundingBox;
  if (!decorBox || !contentBox) return false;
  if (!hasSimilarOverlaySize(decorBox, contentBox)) return false;
  if (!hasStrongDecorSignal(decor)) return false;
  if (hasMeaningfulContent(decor)) return false;
  if (!hasMeaningfulContent(content) && hasStrongDecorSignal(content)) return false;
  if (!hasSimilarVisualTreatment(decor, content)) return false;

  return true;
}

function hasSimilarOverlaySize(
  a: { width: number; height: number },
  b: { width: number; height: number }
): boolean {
  const widthDelta = Math.abs(Math.round(a.width) - Math.round(b.width));
  const heightDelta = Math.abs(Math.round(a.height) - Math.round(b.height));
  return widthDelta <= 2 && heightDelta <= 2;
}

function hasStrongDecorSignal(node: FigmaNode): boolean {
  const name = (node.name || "").toLowerCase();
  if (hasDecorNameSignal(node)) return true;

  const effects = parseEffects(node.effects);
  if (effects?.some((effect) => effect.type === "blur" || effect.type === "backdrop-blur")) {
    return true;
  }

  return node.opacity !== undefined && node.opacity < 0.8 && !hasMeaningfulContent(node);
}

function isLikelyParentBackgroundDecor(node: FigmaNode): boolean {
  if (hasMeaningfulContent(node)) return false;

  if (node.type === "ELLIPSE") {
    return isLargeEnoughForBackgroundDecor(node) && (hasDecorNameSignal(node) || hasBlurEffect(node) || isLowOpacityNode(node));
  }

  const children = (node.children || []).filter((child) => child.visible !== false);
  if (children.length === 0) return false;
  return hasDecorNameSignal(node) && children.every(isLikelyParentBackgroundDecor);
}

function hasDecorNameSignal(node: FigmaNode): boolean {
  const name = (node.name || "").toLowerCase();
  return /发光|光晕|背景光|底部光|glow|blur|shadow|light|halo/.test(name);
}

function hasBlurEffect(node: FigmaNode): boolean {
  const effects = parseEffects(node.effects);
  return !!effects?.some((effect) => effect.type === "blur" || effect.type === "backdrop-blur");
}

function isLowOpacityNode(node: FigmaNode): boolean {
  return node.opacity !== undefined && node.opacity < 0.8;
}

function isLargeEnoughForBackgroundDecor(node: FigmaNode): boolean {
  const box = node.absoluteBoundingBox;
  if (!box) return false;
  return Math.max(box.width || 0, box.height || 0) >= 80;
}

function hasMeaningfulContent(node: FigmaNode): boolean {
  if (node.type === "TEXT" && (node.characters || "").trim()) return true;
  if (isLikelyIconNode(node)) return true;
  return (node.children || []).some((child) => child.visible !== false && hasMeaningfulContent(child));
}

function hasSimilarVisualTreatment(a: FigmaNode, b: FigmaNode): boolean {
  const aBg = primaryVisualFill(a);
  const bBg = primaryVisualFill(b);
  if (aBg && bBg && aBg === bBg) return true;
  return radiusSignature(a) !== "" && radiusSignature(a) === radiusSignature(b);
}

function primaryVisualFill(node: FigmaNode): string | null {
  const allFills = (node.fills || []).filter((f) => f.visible !== false);
  const gradient = allFills.find((f) => f.type?.startsWith("GRADIENT_"));
  if (gradient) return gradientToCSS(gradient);

  const solid = allFills.find((f) => f.type === "SOLID");
  if (solid?.color) return colorToString(solid.color, solid.opacity);

  return null;
}

function radiusSignature(node: FigmaNode): string {
  if (node.cornerRadius) return String(node.cornerRadius);
  if (node.rectangleCornerRadii) return node.rectangleCornerRadii.join(",");
  return "";
}

function registerCondensedV2Icon(
  node: FigmaNode,
  svgMap: CondensedSvgMap | null,
  ctx: CondensedV2Context
): void {
  const svgRef = svgMap?.[node.id];
  if (!svgRef && !isLikelyIconNode(node)) return;

  if (ctx.icons.has(node.id)) return;
  const filename = svgRef?.filename || (svgRef?.path ? basenameFromCondensedPath(svgRef.path) : undefined);
  ctx.icons.set(node.id, {
    ref: `i${ctx.icons.size + 1}`,
    nodeId: node.id,
    name: node.name,
    filename,
    path: svgRef?.path ? normalizeCondensedPath(svgRef.path) : undefined,
    href: svgRef?.href,
  });
}

function condensedV2EffectValue(effect: ParsedEffect, ctx: CondensedV2Context): string | null {
  if (effect.type === "drop-shadow") {
    const color = effect.color ? registerCondensedV2Value(ctx.colors, "c", effect.color) : "none";
    return `shadow:${effect.offset!.x},${effect.offset!.y},${effect.radius},${color}`;
  }
  if (effect.type === "inner-shadow") {
    const color = effect.color ? registerCondensedV2Value(ctx.colors, "c", effect.color) : "none";
    return `inner-shadow:${effect.offset!.x},${effect.offset!.y},${effect.radius},${color}`;
  }
  if (effect.type === "blur") {
    return `blur:${effect.radius}`;
  }
  if (effect.type === "backdrop-blur") {
    return `backdrop-blur:${effect.radius}`;
  }
  return null;
}

function registerCondensedV2Value(map: Map<string, string>, prefix: string, value: string): string {
  const existing = map.get(value);
  if (existing) return existing;
  const ref = `${prefix}${map.size + 1}`;
  map.set(value, ref);
  return ref;
}

function appendCondensedV2MapSection(lines: string[], header: string, map: Map<string, string>): void {
  if (map.size === 0) return;
  lines.push("", header);
  for (const [value, ref] of map.entries()) {
    lines.push(`${ref}=${value}`);
  }
}

function condensedV2MetaLine(node: FigmaNode, ctx: CondensedV2Context): string {
  const parts = [
    `root:${quoteCondensedValue(node.name)}`,
    `type:${node.type}`,
    `nodes:${ctx.nodeCount}`,
  ];
  const bbox = node.absoluteBoundingBox;
  if (bbox) {
    parts.push(`size:${Math.round(bbox.width)}x${Math.round(bbox.height)}`);
  }
  return `@meta ${parts.join(" ")}`;
}

function condensedV2AssetsLines(ctx: CondensedV2Context): string[] {
  const lines: string[] = [];
  if (ctx.svgBase) lines.push(`svgBase:${quoteCondensedPath(ctx.svgBase)}`);
  if (ctx.svgHrefBase) lines.push(`svgHrefBase:${quoteCondensedValue(ctx.svgHrefBase)}`);
  return lines;
}

function normalizeCondensedPath(value: string): string {
  return value.replace(/\\/g, "/");
}

function basenameFromCondensedPath(value: string): string {
  const normalized = normalizeCondensedPath(value);
  return normalized.split("/").filter(Boolean).pop() || normalized;
}

function commonBaseDirectory(values: string[]): string | undefined {
  if (values.length === 0) return undefined;
  const dirs = values.map((value) => {
    const normalized = normalizeCondensedPath(value);
    const index = normalized.lastIndexOf("/");
    return index >= 0 ? normalized.slice(0, index + 1) : "";
  });
  const first = dirs[0];
  if (!first) return undefined;
  return dirs.every((dir) => dir === first) ? first : undefined;
}

function normalizeMaxDepth(maxDepth: number | undefined, fallback: number): number {
  if (!Number.isFinite(maxDepth)) return fallback;
  return Math.max(0, Math.floor(maxDepth!));
}

/** 将 Figma RGBA 颜色转为 CSS 字符串（hex 或 rgba） */
export function colorToString(color: FigmaColor | undefined, opacity?: number): string | null {
  if (!color) return null;
  const r = Math.round(color.r * 255);
  const g = Math.round(color.g * 255);
  const b = Math.round(color.b * 255);
  const a = opacity !== undefined ? opacity : color.a !== undefined ? color.a : 1;

  if (a < 1) {
    return `rgba(${r}, ${g}, ${b}, ${Math.round(a * 100) / 100})`;
  }
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

function colorToHex(color: FigmaColor | undefined): string {
  if (!color) return "#000000";
  const r = Math.round(color.r * 255);
  const g = Math.round(color.g * 255);
  const b = Math.round(color.b * 255);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

function collectVariableTokenParts(node: FigmaNode, variableMap: CondensedVariableMap, separator: ":" | "="): string[] {
  const parts: string[] = [];
  const seen = new Set<string>();

  const add = (prop: string, id: unknown): void => {
    if (typeof id !== "string") return;
    const cssVar = variableMap[id];
    if (!cssVar) return;

    const part = `${prop}${separator}var(${cssVar})`;
    if (seen.has(part)) return;
    seen.add(part);
    parts.push(part);
  };

  const collectBinding = (prop: string, binding: any): void => {
    if (!binding) return;
    if (Array.isArray(binding)) {
      binding.forEach((item, index) => add(`${prop}[${index}]`, item?.id));
      return;
    }
    add(prop, binding.id);
  };

  if (node.boundVariables) {
    for (const [prop, binding] of Object.entries(node.boundVariables)) {
      collectBinding(prop, binding);
    }
  }

  collectPaintVariables(node.fills, "fill", add);
  collectPaintVariables(node.strokes, "stroke", add);

  for (const [index, effect] of (node.effects || []).entries()) {
    add(`effect[${index}].color`, effect.boundVariables?.color?.id);
  }

  return parts;
}

function collectPaintVariables(
  paints: FigmaFill[] | undefined,
  prop: string,
  add: (prop: string, id: unknown) => void
): void {
  for (const [index, paint] of (paints || []).entries()) {
    add(`${prop}[${index}].color`, paint.boundVariables?.color?.id);

    for (const [stopIndex, stop] of (paint.gradientStops || []).entries()) {
      add(`${prop}[${index}].stop[${stopIndex}]`, stop.boundVariables?.color?.id);
    }
  }
}

/** 将 Figma 渐变填充转为 CSS gradient 字符串 */
export function gradientToCSS(fill: FigmaFill): string | null {
  if (!fill || !fill.gradientStops) return null;

  const fillOpacity = fill.opacity !== undefined ? fill.opacity : 1;

  const stops = fill.gradientStops.map((stop) => {
    const stopAlpha = (stop.color?.a !== undefined ? stop.color.a : 1) * fillOpacity;
    const color = colorToString(stop.color, stopAlpha);
    const position = Math.round(stop.position * 1000) / 10;
    return `${color} ${position}%`;
  }).join(", ");

  if (fill.type === "GRADIENT_LINEAR") {
    const angle = calcGradientAngle(fill.gradientHandlePositions);
    return `linear-gradient(${angle}deg, ${stops})`;
  } else if (fill.type === "GRADIENT_RADIAL") {
    const { rx, ry, cx, cy } = calcRadialGradientParams(fill.gradientHandlePositions);
    return `radial-gradient(${rx}% ${ry}% at ${cx}% ${cy}%, ${stops})`;
  } else if (fill.type === "GRADIENT_ANGULAR") {
    return `conic-gradient(${stops})`;
  } else if (fill.type === "GRADIENT_DIAMOND") {
    const { rx, ry, cx, cy } = calcRadialGradientParams(fill.gradientHandlePositions);
    return `radial-gradient(${rx}% ${ry}% at ${cx}% ${cy}%, ${stops})`;
  }
  return null;
}


function calcRadialGradientParams(positions: FigmaPosition[] | undefined): { rx: number; ry: number; cx: number; cy: number } {
  if (!positions || positions.length < 3) {
    return { rx: 50, ry: 50, cx: 50, cy: 50 };
  }
  const center = positions[0];
  const p1 = positions[1];
  const p2 = positions[2];

  const ry = Math.sqrt((p1.x - center.x) ** 2 + (p1.y - center.y) ** 2) * 100;
  const rx = Math.sqrt((p2.x - center.x) ** 2 + (p2.y - center.y) ** 2) * 100;

  const cx = Math.round(center.x * 100 * 100) / 100;
  const cy = Math.round(center.y * 100 * 100) / 100;

  return {
    rx: Math.round(rx * 100) / 100,
    ry: Math.round(ry * 100) / 100,
    cx,
    cy,
  };
}

function calcGradientAngle(positions: FigmaPosition[] | undefined): number {
  if (!positions || positions.length < 2) return 180;
  const start = positions[0];
  const end = positions[1];
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const angle = Math.round(Math.atan2(dx, -dy) * (180 / Math.PI));
  return ((angle % 360) + 360) % 360;
}

const _parseEffectsCache = new WeakMap<FigmaEffect[], ParsedEffect[] | null>();

/** 解析 Figma effects 数组为标准化的 ParsedEffect 列表（带缓存） */
export function parseEffects(effects: FigmaEffect[] | undefined): ParsedEffect[] | null {
  if (!effects || effects.length === 0) return null;
  const cached = _parseEffectsCache.get(effects);
  if (cached !== undefined) return cached;

  const result: ParsedEffect[] = [];
  for (const effect of effects) {
    if (effect.visible === false) continue;

    if (effect.type === "DROP_SHADOW" || effect.type === "INNER_SHADOW") {
      result.push({
        type: effect.type === "DROP_SHADOW" ? "drop-shadow" : "inner-shadow",
        color: colorToString(effect.color, effect.color?.a),
        offset: { x: effect.offset?.x || 0, y: effect.offset?.y || 0 },
        radius: effect.radius || 0,
        spread: effect.spread || 0,
      });
    } else if (effect.type === "LAYER_BLUR") {
      result.push({
        type: "blur",
        radius: effect.radius || 0,
      });
    } else if (effect.type === "BACKGROUND_BLUR") {
      result.push({
        type: "backdrop-blur",
        radius: effect.radius || 0,
      });
    }
  }
  const parsed = result.length > 0 ? result : null;
  _parseEffectsCache.set(effects, parsed);
  return parsed;
}

/** 将 effects 转为 CSS 属性（box-shadow、filter、backdrop-filter） */
export function effectsToCSS(effects: FigmaEffect[] | undefined): Record<string, string> {
  const css: Record<string, string> = {};
  const parsed = parseEffects(effects);
  if (!parsed) return css;

  const shadows: string[] = [];
  for (const e of parsed) {
    if (e.type === "drop-shadow") {
      shadows.push(`${e.offset!.x}px ${e.offset!.y}px ${e.radius}px ${e.spread || 0}px ${e.color}`);
    } else if (e.type === "inner-shadow") {
      shadows.push(`inset ${e.offset!.x}px ${e.offset!.y}px ${e.radius}px ${e.spread || 0}px ${e.color}`);
    } else if (e.type === "blur") {
      css["filter"] = `blur(${e.radius}px)`;
    } else if (e.type === "backdrop-blur") {
      css["backdrop-filter"] = `blur(${e.radius}px)`;
    }
  }
  if (shadows.length > 0) {
    css["box-shadow"] = shadows.join(", ");
  }
  return css;
}


/** 将 fills 转为 CSS background 属性（支持多层填充） */
export function fillsToCSS(fills: FigmaFill[] | undefined): Record<string, string> {
  const css: Record<string, string> = {};
  if (!fills || fills.length === 0) return css;

  const visibleFills = fills.filter((f) => f.visible !== false);
  if (visibleFills.length === 0) return css;

  const backgrounds: string[] = [];
  for (const fill of visibleFills) {
    if (fill.type === "SOLID" && fill.color) {
      const color = colorToString(fill.color, fill.opacity);
      if (color) backgrounds.push(color);
    } else if (fill.type?.startsWith("GRADIENT_")) {
      const g = gradientToCSS(fill);
      if (g) {
        backgrounds.push(g);
      }
    }
  }

  if (backgrounds.length === 1) {
    css["background"] = backgrounds[0];
  } else if (backgrounds.length > 1) {
    css["background"] = backgrounds.join(", ");
  }

  return css;
}

function compactPadding(node: FigmaNode): string | number {
  const t = node.paddingTop || 0;
  const r = node.paddingRight || 0;
  const b = node.paddingBottom || 0;
  const l = node.paddingLeft || 0;

  if (t === r && r === b && b === l) return t;
  if (t === b && l === r) return `${t} ${r}`;
  return `${t} ${r} ${b} ${l}`;
}

function boundsOf(node: FigmaNode): { x: number; y: number; w: number; h: number; cx: number; cy: number } | null {
  const box = node.absoluteBoundingBox;
  if (!box || box.width <= 0 || box.height <= 0) return null;
  return {
    x: box.x,
    y: box.y,
    w: box.width,
    h: box.height,
    cx: box.x + box.width / 2,
    cy: box.y + box.height / 2,
  };
}

function averageGap(
  boxes: { x: number; y: number; w: number; h: number; cx: number; cy: number }[],
  axis: "x" | "y"
): number | undefined {
  if (boxes.length < 2) return undefined;
  const sorted = [...boxes].sort((a, b) => a[axis] - b[axis]);
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const previousEnd = axis === "x" ? sorted[i - 1].x + sorted[i - 1].w : sorted[i - 1].y + sorted[i - 1].h;
    const currentStart = sorted[i][axis];
    const gap = currentStart - previousEnd;
    if (gap >= 0) gaps.push(gap);
  }
  if (gaps.length === 0) return undefined;
  return Math.round(gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length);
}

const _inferLayoutCache = new WeakMap<FigmaNode, InferredLayout | null>();

/** 从子节点位置推断布局方向（row/col/grid），用于没有 layoutMode 的节点 */
function inferLayoutFromChildBounds(node: FigmaNode): InferredLayout | null {
  const cached = _inferLayoutCache.get(node);
  if (cached !== undefined) return cached;

  const result = _inferLayoutFromChildBoundsImpl(node);
  _inferLayoutCache.set(node, result);
  return result;
}

function _inferLayoutFromChildBoundsImpl(node: FigmaNode): InferredLayout | null {
  if (node.layoutMode && node.layoutMode !== "NONE") return null;
  if (!node.children || node.children.length < 2) return null;

  const boxes = node.children
    .filter((child) => child.visible !== false)
    .map(boundsOf)
    .filter(Boolean) as { x: number; y: number; w: number; h: number; cx: number; cy: number }[];

  if (boxes.length < 2) return null;

  const xRange = Math.max(...boxes.map((box) => box.cx)) - Math.min(...boxes.map((box) => box.cx));
  const yRange = Math.max(...boxes.map((box) => box.cy)) - Math.min(...boxes.map((box) => box.cy));
  const avgWidth = boxes.reduce((sum, box) => sum + box.w, 0) / boxes.length;
  const avgHeight = boxes.reduce((sum, box) => sum + box.h, 0) / boxes.length;
  const rowLike = xRange > avgWidth * 0.8 && yRange <= avgHeight * 0.75;
  const colLike = yRange > avgHeight * 0.8 && xRange <= avgWidth * 0.75;

  if (rowLike) {
    return { mode: "row", confidence: "high", source: "bounds", gap: averageGap(boxes, "x") };
  }

  if (colLike) {
    return { mode: "col", confidence: "high", source: "bounds", gap: averageGap(boxes, "y") };
  }

  if (xRange > avgWidth * 0.8 && yRange > avgHeight * 0.8 && boxes.length >= 4) {
    return { mode: "grid", confidence: "medium", source: "bounds" };
  }

  return null;
}

function mapAlign(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const map: Record<string, string> = {
    MIN: "start",
    CENTER: "center",
    MAX: "end",
    SPACE_BETWEEN: "space-between",
  };
  return map[value] || value;
}

function normalizeSizingMode(value: unknown): "hug" | "fill" | "fixed" | string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.toUpperCase();
  if (normalized === "HUG" || normalized === "AUTO") return "hug";
  if (normalized === "FILL") return "fill";
  if (normalized === "FIXED") return "fixed";
  return value.toLowerCase();
}

function nodeResizeSemantics(node: FigmaNode): { horizontal: string; vertical: string; source: string } | null {
  const horizontal = normalizeSizingMode(node.layoutSizingHorizontal)
    || inferLegacyResizeMode(node, "horizontal");
  const vertical = normalizeSizingMode(node.layoutSizingVertical)
    || inferLegacyResizeMode(node, "vertical");

  if (!horizontal && !vertical) return null;
  return {
    horizontal: horizontal || "unknown",
    vertical: vertical || "unknown",
    source: node.layoutSizingHorizontal || node.layoutSizingVertical ? "layoutSizing" : "legacy-layout",
  };
}

function inferLegacyResizeMode(node: FigmaNode, axis: "horizontal" | "vertical"): string | undefined {
  if (axis === "horizontal") {
    if (node.layoutGrow === 1 || node.layoutAlign === "STRETCH") return "fill";
    if (node.primaryAxisSizingMode === "AUTO" || node.counterAxisSizingMode === "AUTO") return "hug";
    if (node.primaryAxisSizingMode === "FIXED" || node.counterAxisSizingMode === "FIXED") return "fixed";
    return undefined;
  }

  if (node.layoutAlign === "STRETCH") return "fill";
  if (node.counterAxisSizingMode === "AUTO" || node.primaryAxisSizingMode === "AUTO") return "hug";
  if (node.counterAxisSizingMode === "FIXED" || node.primaryAxisSizingMode === "FIXED") return "fixed";
  return undefined;
}

function roundNumber(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 从 Figma Variables API 响应构建 variableId → CSS 变量名映射 */
export function buildVariableMap(variablesData: any): Record<string, string> {
  const map: Record<string, string> = {};
  if (!variablesData || !variablesData.meta || !variablesData.meta.variables) {
    return map;
  }
  for (const [id, variable] of Object.entries(variablesData.meta.variables) as [string, any][]) {
    const collection = variablesData.meta.variableCollections?.[variable.variableCollectionId];
    const prefix = collection ? collection.name : "";
    map[id] = prefix ? `--${prefix}-${variable.name}` : `--${variable.name}`;
  }
  return map;
}

/** 构建语义变量定义：从 Variables API 数据提取完整的 token 信息（含模式值、CSS 变量名） */
export function buildSemanticVariableDefinitions(variablesData: any): Record<string, SemanticVariableDefinition> {
  const result: Record<string, SemanticVariableDefinition> = {};
  if (!variablesData?.meta?.variables) return result;

  const variables = variablesData.meta.variables || {};
  const collections = variablesData.meta.variableCollections || {};

  for (const [id, variable] of Object.entries(variables) as [string, any][]) {
    const collection = collections[variable.variableCollectionId];
    const cssVar = variable.codeSyntax?.WEB || (
      collection?.name ? `--${toCssTokenName(`${collection.name}-${variable.name}`)}` : `--${toCssTokenName(variable.name)}`
    );
    const modes = collection?.modes || [];
    const values: Record<string, string> = {};

    for (const mode of modes) {
      const value = variable.valuesByMode?.[mode.modeId];
      if (value !== undefined) values[mode.name] = formatVariableValue(value);
    }

    result[id] = {
      id,
      name: variable.name,
      type: variable.resolvedType,
      collectionId: variable.variableCollectionId,
      collectionName: collection?.name,
      cssVar,
      codeSyntax: variable.codeSyntax,
      modes: modes.map((mode: any) => mode.name),
      values: Object.keys(values).length > 0 ? values : undefined,
    };
  }

  return result;
}

/** 将语义变量定义转为扁平的 variableId → cssVar 映射 */
export function semanticDefinitionsToVariableMap(
  definitions: Record<string, SemanticVariableDefinition> | null | undefined
): CondensedVariableMap | null {
  if (!definitions) return null;

  const result: CondensedVariableMap = {};
  for (const [id, definition] of Object.entries(definitions)) {
    if (definition.cssVar) result[id] = definition.cssVar;
  }

  return Object.keys(result).length > 0 ? result : null;
}

function toCssTokenName(value: string): string {
  return String(value || "token")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "token";
}

function formatVariableValue(value: any): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") return String(value);
  if (value.r !== undefined && value.g !== undefined && value.b !== undefined) return colorToString(value) || "#000000";
  if (value.type === "VARIABLE_ALIAS") return `alias(${value.id})`;
  return JSON.stringify(value);
}


/** 从节点树中的 boundVariables 反向构建变量映射（不依赖 Variables API） */
export function buildVariableMapFromNodes(node: FigmaNode): Record<string, { color: string; cssVar: string }> {
  const varEntries: Record<string, { color: string; contexts: any[] }> = {};

  function addEntry(id: string, color: FigmaColor | undefined, context: { node: string; type: string; usage: string }): void {
    const hex = colorToHex(color);
    if (!varEntries[id]) {
      varEntries[id] = { color: hex, contexts: [] };
    }
    varEntries[id].contexts.push(context);
  }

  function collectFills(fills: FigmaFill[], nodeName: string, nodeType: string, usage: string): void {
    for (const fill of fills) {
      if (fill.type === "SOLID" && fill.boundVariables?.color?.id) {
        addEntry(fill.boundVariables.color.id, fill.color, { node: nodeName, type: nodeType, usage });
      }
      if (fill.gradientStops) {
        for (const stop of fill.gradientStops) {
          if (stop.boundVariables?.color?.id) {
            addEntry(stop.boundVariables.color.id, stop.color, { node: nodeName, type: nodeType, usage: "gradient-stop" });
          }
        }
      }
    }
  }

  function collect(n: FigmaNode): void {
    if (!n) return;

    if (n.fills) collectFills(n.fills, n.name, n.type, "fill");
    if (n.strokes) collectFills(n.strokes, n.name, n.type, "stroke");

    if (n.effects) {
      for (const effect of n.effects) {
        if (effect.boundVariables?.color?.id) {
          addEntry(effect.boundVariables.color.id, effect.color, { node: n.name, type: n.type, usage: "effect" });
        }
      }
    }

    if (n.children) {
      for (const child of n.children) {
        collect(child);
      }
    }
  }

  collect(node);

  const result: Record<string, { color: string; cssVar: string }> = {};
  for (const [id, entry] of Object.entries(varEntries)) {
    const cssVar = inferVarName(id, entry.color, entry.contexts[0]);
    result[id] = { color: entry.color, cssVar };
  }
  return result;
}


/** 根据变量使用上下文推断 CSS 变量名前缀（bg/text/border/gradient/effect） */
function inferVarName(id: string, color: string, context: any): string {
  const idNum = id.replace("VariableID:", "").replace(/:/g, "-");
  const usage = context?.usage || "color";
  const nodeType = context?.type || "";

  let prefix = "color";
  if (usage === "fill") {
    prefix = nodeType === "TEXT" ? "text" : "bg";
  } else if (usage === "stroke" || usage === "stroke-gradient") {
    prefix = "border";
  } else if (usage === "gradient-stop") {
    prefix = "gradient";
  } else if (usage === "effect") {
    prefix = "effect";
  }

  return `--${prefix}-${idNum}`;
}

/** 从约束条件推断响应式布局提示（stretch-x、fluid-width 等） */
function inferResponsiveHint(node: FigmaNode): string | null {
  const bbox = node.absoluteBoundingBox;
  const constraints = node.constraints;
  if (!bbox || !constraints) return null;

  const hints: string[] = [];

  if (constraints.horizontal === "LEFT_RIGHT") {
    hints.push("stretch-x");
  } else if (constraints.horizontal === "SCALE") {
    hints.push("fluid-width");
  } else if (constraints.horizontal === "CENTER") {
    hints.push("center-x");
  }

  if (constraints.vertical === "TOP_BOTTOM") {
    hints.push("stretch-y");
  } else if (constraints.vertical === "SCALE") {
    hints.push("fluid-height");
  } else if (constraints.vertical === "CENTER") {
    hints.push("center-y");
  }

  if (bbox.width > 1200) {
    hints.push("full-width, use max-width");
  } else if (bbox.width > 768 && constraints.horizontal === "LEFT") {
    hints.push("fixed-desktop, needs mobile adaptation");
  }

  return hints.length > 0 ? hints.join(", ") : null;
}

/** 递归遍历简化节点树，收集统计信息 */
function walkTree(node: SimplifiedNode, stats: { total: number; types: Record<string, number>; texts: any[]; components: any[] }): void {
  stats.total++;
  stats.types[node.type] = (stats.types[node.type] || 0) + 1;

  if (node.type === "TEXT" && node.text) {
    stats.texts.push({ name: node.name, text: node.text.slice(0, 100) });
  }
  if (node.type === "INSTANCE") {
    stats.components.push({ name: node.name, componentId: (node as any).componentId });
  }

  if (node.children) {
    for (const child of node.children) {
      walkTree(child, stats);
    }
  }
}

/** 粗略估算文本的 token 数（按每 4 字符 ≈ 1 token） */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** 判断节点是否可能是图标（名称匹配 + 容器类型 + 图标尺寸） */
export function isLikelyIconNode(node: FigmaNode): boolean {
  if (!node) return false;

  const semantic = inferSemanticRole(node);
  if (semantic?.role === "ICON") return true;

  if (!node.type || !ICON_CONTAINER_TYPES.has(node.type)) return false;
  if (!node.name || !ICON_NAME_PATTERN.test(node.name.trim())) return false;

  const bbox = node.absoluteBoundingBox;
  if (!bbox) return false;

  const width = Number(bbox.width || 0);
  const height = Number(bbox.height || 0);
  if (width <= 0 || height <= 0) return false;
  if (Math.abs(width - height) > ICON_SIZE_TOLERANCE) return false;
  if (Math.max(width, height) > MAX_ICON_DIMENSION) return false;

  return COMMON_ICON_SIZES.some((size) => (
    Math.abs(width - size) <= ICON_SIZE_TOLERANCE &&
    Math.abs(height - size) <= ICON_SIZE_TOLERANCE
  ));
}

function quoteCondensedValue(value: string): string {
  return JSON.stringify(value);
}

function quoteCondensedPath(value: string): string {
  return JSON.stringify(value.replace(/\\/g, "/"));
}


/** 生成 condensed v1 单行表示：[TYPE "name" size bg:color ...] */
function toCondensedLine(
  node: FigmaNode,
  depth: number,
  variableMap: CondensedVariableMap | null,
  svgMap: CondensedSvgMap | null
): string {
  const indent = "  ".repeat(depth);
  const parts: string[] = [];

  const semantic = inferSemanticRole(node);
  const type = semantic ? semantic.role : node.type;
  const name = `"${node.name}"`;
  const svgRef = svgMap?.[node.id];

  const bbox = node.absoluteBoundingBox;
  let size = "";
  if (bbox) {
    size = `${Math.round(bbox.width)}x${Math.round(bbox.height)}`;
  }

  parts.push(`[${type} ${name}`);
  if (size) parts.push(size);
  if (isLikelyIconNode(node) || svgRef) parts.push("icon");
  if (svgRef?.filename) parts.push(`svg:${quoteCondensedValue(svgRef.filename)}`);
  if (svgRef?.path) parts.push(`svgPath:${quoteCondensedPath(svgRef.path)}`);
  if (svgRef?.href) parts.push(`svgHref:${quoteCondensedValue(svgRef.href)}`);
  if (isAbsolutePositionedNode(node)) parts.push("pos:absolute");

  const allFills = (node.fills || []).filter((f) => f.visible !== false);
  const solidFills = allFills.filter((f) => f.type === "SOLID");
  const gradientFills = allFills.filter((f) => f.type?.startsWith("GRADIENT_"));

  if (node.type !== "TEXT") {
    if (gradientFills.length > 0) {
      const cssGradient = gradientToCSS(gradientFills[0]);
      if (cssGradient) parts.push(`bg:${cssGradient}`);
    } else if (solidFills.length > 0) {
      parts.push(`bg:${colorToString(solidFills[0].color, solidFills[0].opacity)}`);
    }
  }

  const effects = parseEffects(node.effects);
  if (effects) {
    for (const effect of effects) {
      if (effect.type === "drop-shadow") {
        parts.push(`shadow:${effect.offset!.x},${effect.offset!.y},${effect.radius},${effect.color}`);
      } else if (effect.type === "inner-shadow") {
        parts.push(`inner-shadow:${effect.offset!.x},${effect.offset!.y},${effect.radius},${effect.color}`);
      } else if (effect.type === "blur") {
        parts.push(`blur:${effect.radius}`);
      } else if (effect.type === "backdrop-blur") {
        parts.push(`backdrop-blur:${effect.radius}`);
      }
    }
  }

  if (node.cornerRadius) {
    parts.push(`radius:${node.cornerRadius}`);
  } else if (node.rectangleCornerRadii) {
    const r = node.rectangleCornerRadii;
    if (r[0] === r[1] && r[1] === r[2] && r[2] === r[3]) {
      if (r[0] > 0) parts.push(`radius:${r[0]}`);
    } else {
      parts.push(`radius:${r.join(",")}`);
    }
  }

  const strokes = (node.strokes || []).filter((s) => s.visible !== false);
  if (strokes.length > 0 && strokes[0].color) {
    parts.push(`border:${node.strokeWeight || 1}px,${colorToString(strokes[0].color)}`);
  }

  if (node.layoutMode && node.layoutMode !== "NONE") {
    parts.push(node.layoutMode === "HORIZONTAL" ? "flex-row" : "flex-col");
    if (node.itemSpacing) parts.push(`gap:${node.itemSpacing}`);

    const padding = compactPadding(node);
    if (padding && padding !== 0 && padding !== "0") {
      parts.push(`p:${padding}`);
    }

    const align = mapAlign(node.primaryAxisAlignItems);
    if (align && align !== "start") parts.push(align);
    const crossAlign = mapAlign(node.counterAxisAlignItems);
    if (crossAlign && crossAlign !== "start") parts.push(`cross:${crossAlign}`);

    if (node.layoutWrap === "WRAP") parts.push("wrap");
  }

  const inferredLayout = inferLayoutFromChildBounds(node);
  if (inferredLayout) {
    parts.push(`inferred-${inferredLayout.mode}`);
    if (inferredLayout.gap) parts.push(`inferred-gap:${inferredLayout.gap}`);
    parts.push(`confidence:${inferredLayout.confidence}`);
  }

  if (node.opacity !== undefined && node.opacity !== 1) {
    parts.push(`opacity:${Math.round(node.opacity * 100) / 100}`);
  }

  if (node.type === "TEXT") {
    const style = node.style || {};
    const textParts: string[] = [];
    if (style.fontSize) textParts.push(`${style.fontSize}px`);
    if (style.fontWeight) textParts.push(`/${style.fontWeight}`);
    if (textParts.length > 0) parts.push(textParts.join(""));

    const textFills = (node.fills || []).filter((f) => f.visible !== false && f.type === "SOLID");
    if (textFills.length > 0) {
      parts.push(colorToString(textFills[0].color, textFills[0].opacity) || "");
    }

    const text = (node.characters || "").slice(0, 50);
    if (text) parts.push(`"${text}"`);
  }

  if (hasImageFill(node) && node.type !== "IMAGE") {
    parts.push("has-image");
  }

  if (semantic && semantic.html !== "div" && semantic.html !== "span") {
    parts.push(`<${semantic.html}>`);
  }

  if (variableMap) {
    const tokenParts = collectVariableTokenParts(node, variableMap, ":");
    if (tokenParts.length > 0) {
      parts.push(`{${tokenParts.join(",")}}`);
    }
  }

  return indent + parts.join(" ") + "]";
}

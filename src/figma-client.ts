/**
 * Figma REST API 客户端
 *
 * 核心能力：
 * 1. 并发控制 — 信号量模式，最多 5 个并行请求，超出排队等待
 * 2. LRU 缓存 — Map 实现，TTL 可配置（默认 60s），最多 50 条
 * 3. 指数退避重试 — 429/5xx 最多重试 3 次，尊重 Retry-After 头
 * 4. 请求超时 — AbortController，默认 20s
 *
 * 所有 Figma API 请求都通过 this.request() 统一处理
 */

/** API 请求参数类型 */
export interface FigmaRequestParams {
  [key: string]: string | number | boolean | undefined | null;
}

/** API 响应回调类型，用于 debug 日志 */
type ResponseCallback = (path: string, params: FigmaRequestParams, data: unknown) => void;

/** LRU 缓存条目 */
interface CacheEntry {
  data: unknown;
  timestamp: number;
  key: string;
}

export interface FigmaNode {
  id: string;
  name: string;
  type: string;
  visible?: boolean;
  children?: FigmaNode[];
  absoluteBoundingBox?: { x: number; y: number; width: number; height: number };
  [key: string]: any;
}

export interface FigmaFileResponse {
  name: string;
  lastModified: string;
  document: FigmaNode;
}

export interface FigmaNodesResponse {
  nodes: Record<string, { document: FigmaNode }>;
}

export interface FigmaVersionsResponse {
  versions: Array<{
    id: string;
    created_at: string;
    label?: string;
    description?: string;
    user?: { handle?: string };
  }>;
}

export interface FigmaVariablesResponse {
  meta?: {
    variables?: Record<string, any>;
    variableCollections?: Record<string, any>;
  };
}

export interface FigmaStylesResponse {
  meta?: {
    styles?: Array<{
      name: string;
      style_type: string;
      description?: string;
    }>;
  };
}

export interface FigmaImagesResponse {
  images?: Record<string, string>;
}

export interface FigmaComponentsResponse {
  meta?: {
    components?: Array<{
      key: string;
      name: string;
      description?: string;
    }>;
  };
}

/** 自定义 API 错误类，携带 HTTP 状态码 */
export class FigmaApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "FigmaApiError";
    this.status = status;
  }
}

export class FigmaClient {
  private token: string;
  private baseUrl: string;
  private cache: Map<string, CacheEntry>;       // LRU 缓存（Map 保持插入顺序）
  private cacheTTL: number;                     // 缓存过期时间（ms）
  private cacheMaxSize: number;                 // 缓存最大条目数
  private maxRetries: number;                   // 最大重试次数
  private maxConcurrency: number;               // 最大并发请求数
  private requestTimeoutMs: number;             // 单次请求超时（ms）
  private activeRequests: number;               // 当前活跃请求数（信号量计数器）
  private requestQueue: Array<{ resolve: () => void }>; // 等待队列（信号量排队）
  onResponse: ResponseCallback | null;          // 响应回调（用于 debug 日志）

  constructor(token: string) {
    this.token = token;
    this.baseUrl = "https://api.figma.com/v1";
    this.cache = new Map();
    // 支持环境变量配置缓存 TTL 和超时时间
    this.cacheTTL = parseInt(process.env.FIGMA_CACHE_TTL || "60000", 10);
    this.cacheMaxSize = 50;
    this.maxRetries = 3;
    this.maxConcurrency = 5;
    this.requestTimeoutMs = parseInt(process.env.FIGMA_REQUEST_TIMEOUT_MS || "20000", 10);
    this.activeRequests = 0;
    this.requestQueue = [];
    this.onResponse = null;
  }

  /**
   * 获取并发槽位（信号量 acquire）
   * 如果当前活跃请求数 < 上限，直接通过
   * 否则创建 Promise 排队等待，直到有请求完成释放槽位
   */
  private async acquireConcurrency(): Promise<void> {
    if (this.activeRequests < this.maxConcurrency) {
      this.activeRequests++;
      return;
    }
    await new Promise<void>((resolve) => {
      this.requestQueue.push({ resolve });
    });
    this.activeRequests++;
  }

  /** 释放并发槽位（信号量 release），唤醒队头等待者 */
  private releaseConcurrency(): void {
    this.activeRequests--;
    const next = this.requestQueue.shift();
    if (next) next.resolve();
  }

  /**
   * LRU 缓存写入
   * 先 delete 再 set，保证条目在 Map 末尾（最近使用）
   * 超出容量时淘汰 Map 头部（最久未使用）
   */
  private cacheSet(key: string, data: unknown): void {
    this.cache.delete(key);
    if (this.cache.size >= this.cacheMaxSize) {
      const firstKey = this.cache.keys().next().value!;
      this.cache.delete(firstKey);
    }
    this.cache.set(key, { data, timestamp: Date.now(), key });
  }

  /**
   * LRU 缓存读取
   * 命中后 delete + set 将条目移到末尾（刷新热度）
   * 过期则删除返回 null
   */
  private cacheGet(key: string): unknown | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (this.cacheTTL <= 0 || Date.now() - entry.timestamp > this.cacheTTL) {
      this.cache.delete(key);
      return null;
    }
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.data;
  }

  /** 判断 HTTP 状态码是否可重试（429 限流 或 5xx 服务端错误） */
  private isRetryable(status: number): boolean {
    return status === 429 || status >= 500;
  }

  private async sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * 核心请求方法 — 所有 API 调用的统一入口
   *
   * 执行流程：
   * 1. 构建 URL，检查缓存
   * 2. 获取并发槽位（可能排队等待）
   * 3. 循环重试（最多 maxRetries 次）：
   *    - 首次直接请求，后续按指数退避延迟
   *    - 成功 → 写入缓存，返回数据
   *    - 429/5xx → 检查 Retry-After 头，继续重试
   *    - 其他 4xx → 直接抛出，不重试
   * 4. finally 中释放并发槽位
   */
  async request(path: string, params: FigmaRequestParams = {}): Promise<unknown> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    }

    const cacheKey = url.toString();
    const cached = this.cacheGet(cacheKey);
    if (cached !== null) return cached;

    await this.acquireConcurrency();
    try {
      let lastError: Error | null = null;

      for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
        if (attempt > 0) {
          const delay = Math.min(1000 * Math.pow(2, attempt - 1), 8000);
          await this.sleep(delay);
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
        let response: Response;
        try {
          response = await fetch(url.toString(), {
            headers: { "X-Figma-Token": this.token },
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timeout);
        }

        if (response.ok) {
          const data = await response.json();
          if (this.onResponse) this.onResponse(path, params, data);
          this.cacheSet(cacheKey, data);
          return data;
        }

        const text = await response.text();
        lastError = new FigmaApiError(response.status, `Figma API ${response.status}: ${text}`);

        if (!this.isRetryable(response.status)) throw lastError;

        const retryAfter = response.headers.get("Retry-After");
        if (retryAfter && attempt < this.maxRetries) {
          const retryMs = parseInt(retryAfter, 10) * 1000;
          if (!isNaN(retryMs) && retryMs > 0) {
            await this.sleep(Math.min(retryMs, 10000));
            continue;
          }
        }
      }

      throw lastError!;
    } finally {
      this.releaseConcurrency();
    }
  }

  // ==================== 便捷 API 方法 ====================
  // 每个方法对应一个 Figma REST API 端点，返回类型化的响应

  /** 获取整个文件结构（可限制深度） */
  async getFile(fileKey: string, { depth }: { depth?: number } = {}): Promise<FigmaFileResponse> {
    return this.request(`/files/${fileKey}`, { depth }) as Promise<FigmaFileResponse>;
  }

  /** 获取指定节点的详细数据（支持版本和深度参数） */
  async getFileNodes(fileKey: string, nodeIds: string[], version?: string, depth?: number): Promise<FigmaNodesResponse> {
    const ids = nodeIds.join(",");
    return this.request(`/files/${fileKey}/nodes`, { ids, version, depth }) as Promise<FigmaNodesResponse>;
  }

  async getFileVersions(fileKey: string): Promise<FigmaVersionsResponse> {
    return this.request(`/files/${fileKey}/versions`) as Promise<FigmaVersionsResponse>;
  }

  async getFileComponents(fileKey: string): Promise<FigmaComponentsResponse> {
    return this.request(`/files/${fileKey}/components`) as Promise<FigmaComponentsResponse>;
  }

  async getFileStyles(fileKey: string): Promise<FigmaStylesResponse> {
    return this.request(`/files/${fileKey}/styles`) as Promise<FigmaStylesResponse>;
  }

  async getVariables(fileKey: string): Promise<FigmaVariablesResponse> {
    return this.request(`/files/${fileKey}/variables/local`) as Promise<FigmaVariablesResponse>;
  }

  async getPublishedVariables(fileKey: string): Promise<FigmaVariablesResponse> {
    return this.request(`/files/${fileKey}/variables/published`) as Promise<FigmaVariablesResponse>;
  }

  async getImages(fileKey: string, nodeIds: string[], format: string = "png", scale: number = 2): Promise<FigmaImagesResponse> {
    const ids = nodeIds.join(",");
    return this.request(`/images/${fileKey}`, { ids, format, scale }) as Promise<FigmaImagesResponse>;
  }

  async getComponentSet(fileKey: string, nodeId: string): Promise<unknown> {
    return this.request(`/files/${fileKey}/nodes`, { ids: nodeId });
  }
}

/**
 * [GQAI 추가] Vercel Function용 Express 앱
 *
 * 원본 src/server/http-server.ts에서 갈라져 나온 파일이다. 원본은 마지막에
 * app.listen()으로 포트를 잡는데, Vercel Function은 요청 객체를 핸들러로 넘기는
 * 모델이라 listen하는 서버를 export할 수 없다. 그래서 "앱을 만들어 반환"까지만
 * 하고 리스닝은 하지 않는다. 원본 파일은 로컬 개발·Fly 배포용으로 그대로 둔다.
 *
 * 원본 대비 달라진 점(모두 계획서 근거):
 *   1. app.listen / graceful shutdown 제거 — 서버리스에는 해당 개념이 없다
 *   2. 인메모리 토큰버킷·일일캡 → Redis 전역 카운터 (관문 C: 다중 인스턴스 일관성)
 *   3. IP 제한을 '사용자 식별'에서 '봇 방어'로 격하 (3.4절: 원격 MCP는 egress IP 공유)
 *   4. Host 헤더 검증 추가 (3.5절: DNS rebinding 방어)
 *   5. /health에 캐시·한도·저장소 상태 노출 (11.1절 모니터링 지표)
 *
 * upstream 병합 시 이 파일과 http-server.ts의 diff를 함께 확인할 것.
 */

import express from "express"
import { timingSafeEqual } from "node:crypto"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { requestContext } from "../lib/session-state.js"
import { maskSensitiveUrl } from "../lib/fetch-with-retry.js"
import { LawApiClient } from "../lib/api-client.js"
import { registerTools, TOOL_COUNTS } from "../tool-registry.js"
import { VERSION } from "../version.js"
import { createGlobalLimiter, createIpLimiter, limiterStats } from "../lib/global-rate-limit.js"
import { installLawCache, cacheStats, cacheEnabled } from "../lib/law-cache.js"
import { kvConfigured } from "../lib/kv-store.js"
import { syntheticStats } from "../lib/synthetic.js"

/** 서비스 식별자 — MCP 클라이언트 목록에 표시되는 이름 */
const SERVICE_NAME = process.env.MCP_SERVER_NAME || "gqai-law"

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

function bearerValue(raw: string | undefined): string {
  return raw ? raw.replace(/^Bearer\s+/i, "") : ""
}

function scrubError(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) {
    return {
      message: maskSensitiveUrl(error.message),
      stack: error.stack ? maskSensitiveUrl(error.stack) : undefined,
    }
  }
  return { message: maskSensitiveUrl(String(error)) }
}

// ── MCP 서버 팩토리 ────────────────────────────────────────────────────────
// stateless 모드는 요청마다 새 Server 인스턴스를 만든다. apiClient는 상태가
// 없으므로 모듈 스코프에서 1회만 생성해 콜드스타트 비용을 줄인다.
const apiClient = new LawApiClient({
  apiKey: process.env.LAW_OC || process.env.KOREAN_LAW_API_KEY || "",
})

function createMcpServer(): Server {
  const s = new Server(
    { name: SERVICE_NAME, version: VERSION },
    { capabilities: { tools: {} } }
  )
  registerTools(s, apiClient)
  return s
}

// ── 앱 구성 ────────────────────────────────────────────────────────────────

export function createApp(): express.Express {
  // 법제처 응답 캐시를 전역 fetch에 설치 (콜드스타트 1회)
  installLawCache()

  const app = express()

  // Vercel 엣지가 1단 프록시 — X-Forwarded-For 스푸핑으로 IP 버킷을 우회하지
  // 못하도록 신뢰 홉 수를 명시한다. 'true'로 두면 클라이언트가 헤더를 위조할 수 있다.
  app.set("trust proxy", parseInt(process.env.TRUST_PROXY || "1", 10))

  if (process.env.ACCESS_LOG === "1") {
    app.use((req, _res, next) => {
      // req.path만 기록 — 쿼리스트링에는 oc= 키가 실릴 수 있다
      console.log(`[access] ${req.method} ${req.path} ip=${req.ip} ua="${req.headers["user-agent"] ?? "-"}"`)
      next()
    })
  }

  // ── Host 헤더 검증 (DNS rebinding 방어, 계획서 3.5절) ────────────────────
  // 공격자가 자기 도메인을 이 서버 IP로 가리켜두고 피해자 브라우저에서 호출하게
  // 만드는 공격을 막는다. Origin 검증은 브라우저가 헤더를 붙일 때만 동작하므로
  // Host 검증을 별도로 둔다(MCP 명세 권고).
  const extraHosts = (process.env.ALLOWED_HOSTS || "")
    .split(",").map(h => h.trim().toLowerCase()).filter(Boolean)

  function hostAllowed(hostHeader: string | undefined): boolean {
    if (!hostHeader) return false
    const host = hostHeader.toLowerCase().split(":")[0]
    if (host === "law.gqai.kr") return true
    if (host === "localhost" || host === "127.0.0.1") return true
    // Preview 배포는 무작위 *.vercel.app 호스트를 받는다 — 단계 2 검증에 필요
    if (/\.vercel\.app$/.test(host)) return true
    return extraHosts.includes(host)
  }

  app.use((req, res, next) => {
    if (hostAllowed(req.headers.host)) return next()
    res.status(403).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Host not allowed." },
      id: null,
    })
  })

  // ── Origin 검증 (upstream 동작 유지) ─────────────────────────────────────
  const corsOriginConfigured = process.env.CORS_ORIGIN !== undefined
  const corsOrigin = process.env.CORS_ORIGIN || "*"
  const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
    .split(",").map(o => o.trim()).filter(Boolean)

  function resolveOrigin(origin: string | undefined): string | null {
    if (!origin) return corsOrigin // 브라우저가 아닌 MCP 클라이언트
    if (allowedOrigins.includes(origin)) return origin
    if (allowedOrigins.length === 0 && corsOriginConfigured) {
      if (corsOrigin === "*") return "*"
      if (corsOrigin === origin) return origin
    }
    return null
  }

  app.use((req, res, next) => {
    if (req.path === "/health" || req.path === "/") return next()
    const allowed = resolveOrigin(req.headers.origin as string | undefined)
    if (allowed === null) {
      res.status(403).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Origin not allowed." },
        id: null,
      })
      return
    }
    res.header("Access-Control-Allow-Origin", allowed)
    if (allowed !== "*") res.header("Vary", "Origin")
    next()
  })

  // ── 접근 인증 (비공개 베타용, MCP_AUTH_TOKEN 설정 시에만 활성) ───────────
  const authToken = process.env.MCP_AUTH_TOKEN || ""
  app.use((req, res, next) => {
    if (!authToken) return next()
    if (req.method === "OPTIONS") return next()
    if (req.path === "/health" || req.path === "/") return next()

    const presented =
      (req.headers["x-mcp-token"] as string | undefined) ||
      bearerValue(req.headers["authorization"] as string | undefined)

    if (!presented || !safeEqual(presented, authToken)) {
      res.status(401).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Unauthorized." },
        id: null,
      })
      return
    }
    next()
  })

  app.use(express.json({ limit: process.env.MCP_BODY_LIMIT || "100kb" }))

  // ── 한도 게이트 ─────────────────────────────────────────────────────────
  const maxBatchCalls = parseInt(process.env.MCP_MAX_BATCH_CALLS || "20", 10)
  const ipRpm = parseInt(process.env.RATE_LIMIT_RPM || "120", 10)
  const keyPrefix = process.env.LIMIT_PREFIX || `gqai:${process.env.VERCEL_ENV || "dev"}`

  const ipLimiter = createIpLimiter(keyPrefix, ipRpm)
  const globalLimiter = createGlobalLimiter({
    ratePerMin: parseInt(process.env.FALLBACK_RATE_LIMIT_RPM || "120", 10),
    burst: parseInt(process.env.FALLBACK_RATE_LIMIT_BURST || process.env.FALLBACK_RATE_LIMIT_RPM || "120", 10),
    dailyCap: parseInt(process.env.FALLBACK_DAILY_CAP || "0", 10),
    prefix: keyPrefix,
  })

  /** 요청 본문에서 실제 쿼터를 소모하는 tools/call 개수를 센다 */
  function countToolCalls(body: unknown): number {
    const msgs = Array.isArray(body) ? body : [body]
    return msgs.filter((m: any) => m?.method === "tools/call").length
  }

  app.use(async (req, res, next) => {
    if (req.path === "/health" || req.path === "/") return next()
    if (req.method !== "POST") return next()

    // initialize·tools/list 같은 핸드셰이크는 법제처 쿼터를 쓰지 않는다.
    // 이걸 429로 막으면 클라이언트가 도구 목록조차 못 받아 "도구 없음"이 된다.
    const callCount = countToolCalls(req.body)
    if (callCount === 0) return next()

    // 배치 증폭 차단 — 한 POST에 tools/call을 무한정 담으면 한도가 배수로 우회된다
    if (callCount > maxBatchCalls) {
      res.status(429).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: `Too many tool calls in one request (max ${maxBatchCalls}).` },
        id: null,
      })
      return
    }

    const ip = req.ip || req.socket.remoteAddress || "unknown"
    const ipVerdict = await ipLimiter.take(ip, callCount)
    if (!ipVerdict.ok) {
      res.setHeader("Retry-After", String(ipVerdict.retryAfterSec))
      res.status(429).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: `Too many requests — retry in ${ipVerdict.retryAfterSec}s.` },
        id: null,
      })
      return
    }
    next()
  })

  // ── 보안 헤더 ───────────────────────────────────────────────────────────
  app.use((req, res, next) => {
    res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
    res.header(
      "Access-Control-Allow-Headers",
      "Content-Type, mcp-session-id, last-event-id, apikey, x-api-key, x-mcp-token, authorization"
    )
    res.header("X-Content-Type-Options", "nosniff")
    res.header("X-Frame-Options", "DENY")
    res.header("Referrer-Policy", "strict-origin-when-cross-origin")
    if (req.method === "OPTIONS") return res.sendStatus(200)
    next()
  })

  // ── 상태 엔드포인트 ─────────────────────────────────────────────────────
  app.get("/", (_req, res) => {
    res.json({
      name: "GQAI 법령조회 MCP",
      version: VERSION,
      status: "running",
      transport: "streamable-http (stateless)",
      endpoints: { mcp: "/mcp", health: "/health" },
      tools: { exposed: TOOL_COUNTS.exposed, total: TOOL_COUNTS.total },
      notice: "조회 결과는 참고용입니다. 법적 효력이 필요한 판단은 국가법령정보센터 원문을 확인하세요.",
      source: "법제처 국가법령정보센터 OPEN API (https://open.law.go.kr/)",
    })
  })

  app.get("/health", async (_req, res) => {
    // 운영 판단에 필요한 상태를 한 번에 노출 — 비밀정보는 담지 않는다.
    // synthetic은 저장소 왕복이 필요하므로 실패해도 헬스체크는 계속 응답한다.
    const synthetic = await syntheticStats().catch(() => null)
    res.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      version: VERSION,
      region: process.env.VERCEL_REGION || null,
      env: process.env.VERCEL_ENV || "development",
      config: {
        lawOcConfigured: Boolean(process.env.LAW_OC || process.env.KOREAN_LAW_API_KEY),
        kvConfigured: kvConfigured(),
        cacheEnabled: cacheEnabled(),
        authRequired: Boolean(process.env.MCP_AUTH_TOKEN),
      },
      // 적용 중인 한도값 — 환경변수가 실제로 먹었는지 배포 후 바로 확인하기 위한 것.
      // 값 자체는 비밀이 아니며, dailyCap이 0이면 공용 키에 일일 상한이 없다는 뜻이다.
      limits: {
        fallbackRpm: parseInt(process.env.FALLBACK_RATE_LIMIT_RPM || "120", 10),
        fallbackDailyCap: parseInt(process.env.FALLBACK_DAILY_CAP || "0", 10),
        ipRpm: parseInt(process.env.RATE_LIMIT_RPM || "120", 10),
        maxBatchCalls: parseInt(process.env.MCP_MAX_BATCH_CALLS || "20", 10),
      },
      cache: cacheStats(),
      limiter: limiterStats(),
      synthetic,
    })
  })

  // ── MCP 엔드포인트 ──────────────────────────────────────────────────────
  app.post("/mcp", async (req, res) => {
    const authHeader = bearerValue(req.headers["authorization"] as string | undefined)
    const authHeaderIsAccessToken =
      Boolean(authToken) && authHeader && safeEqual(authHeader, authToken)
    // 쿼리스트링 키는 엣지 액세스 로그에 평문으로 남는다 — 기본 차단
    const queryKey =
      process.env.ALLOW_QUERY_API_KEY === "1" ? (req.query.oc as string | undefined) : undefined

    const apiKey =
      (req.headers["apikey"] as string | undefined) ||
      (req.headers["law_oc"] as string | undefined) ||
      (req.headers["law-oc"] as string | undefined) ||
      (req.headers["x-api-key"] as string | undefined) ||
      (authHeaderIsAccessToken ? undefined : authHeader || undefined) ||
      (req.headers["x-law-oc"] as string | undefined) ||
      queryKey

    // 자체 키 없는 요청만 공용 서버 OC를 소모한다 → 전역 한도 적용
    const fallbackCallCount = countToolCalls(req.body)
    if (!apiKey && fallbackCallCount > 0) {
      const verdict = await globalLimiter.take(fallbackCallCount)
      if (!verdict.ok) {
        res.setHeader("Retry-After", String(verdict.retryAfterSec))
        res.status(429).json({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: verdict.daily
              ? "공용 서버 키의 일일 조회 한도에 도달했습니다. 내일 다시 시도하시거나, 직접 발급받은 법제처 인증키를 'apiKey' 헤더로 전달하세요 (무료: https://open.law.go.kr)."
              : `공용 서버 키의 분당 한도를 초과했습니다 — ${verdict.retryAfterSec}초 후 재시도하거나, 직접 발급받은 법제처 인증키를 'apiKey' 헤더로 전달하세요 (무료: https://open.law.go.kr).`,
          },
          id: null,
        })
        return
      }
    }

    let server: Server | undefined
    let transport: StreamableHTTPServerTransport | undefined

    try {
      server = createMcpServer()
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless — 인스턴스 간 세션 공유가 불가능하므로 필수
        enableJsonResponse: true,
      })

      res.on("close", () => {
        try { transport?.close() } catch { /* ignore */ }
        server?.close().catch(() => {})
      })

      await server.connect(transport)

      // ALS로 요청 단위 API 키 격리 (동시 요청 간 키 혼선 방지)
      await requestContext.run({ apiKey }, async () => {
        await transport!.handleRequest(req, res, req.body)
      })
    } catch (error) {
      const scrubbed = scrubError(error)
      console.error("[POST /mcp] Error:", scrubbed.message)
      if (scrubbed.stack && process.env.NODE_ENV !== "production") {
        console.error(scrubbed.stack)
      }
      try { transport?.close() } catch { /* ignore */ }
      server?.close().catch(() => {})
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        })
      }
    }
  })

  // stateless 모드에서 GET/DELETE /mcp는 SSE 스트림·세션 종료용이라 성립하지 않는다
  const methodNotAllowed = (_req: express.Request, res: express.Response) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed. Server runs in stateless mode." },
      id: null,
    })
  }
  app.get("/mcp", methodNotAllowed)
  app.delete("/mcp", methodNotAllowed)

  // 최종 에러 핸들러 — Express 기본 핸들러는 스택 트레이스와 설치 경로를 본문에 싣는다
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = typeof err?.status === "number" ? err.status : 500
    const scrubbed = scrubError(err)
    console.error(`[express] ${status} ${scrubbed.message}`)
    if (res.headersSent) return
    res.status(status).json({
      jsonrpc: "2.0",
      error: {
        code: status === 413 ? -32600 : -32603,
        message: status === 413 ? "Request entity too large." : "Internal server error",
      },
      id: null,
    })
  })

  return app
}

/** Vercel Function이 재사용할 단일 앱 인스턴스 (콜드스타트 1회 구성) */
export const app = createApp()
export default app

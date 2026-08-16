/**
 * [GQAI 추가] 법제처 응답 캐시 — 쿼터 보호 1차 방어선
 *
 * 왜 캐시가 rate limit보다 먼저인가(계획서 3.4절):
 *   법령 조문·판례 전문은 개정 전까지 불변이고, 트래픽은 인기 법령
 *   (민법·근로기준법 등)에 강하게 쏠린다. 한도 제한은 쿼터가 소진되는 '속도'만
 *   늦추지만, 캐시는 법제처 호출 '자체'를 없앤다. 공용 서버 OC를 다수 사용자가
 *   공유하는 구조에서 실효 방어는 캐시 쪽이다.
 *
 * 왜 fetch 인터셉트인가:
 *   모든 법제처 호출은 lib/api-client.ts → fetchWithRetry → 전역 fetch를 지난다.
 *   여기 한 곳만 감싸면 원본 파일을 전혀 수정하지 않고 전 도구에 캐시가 걸린다.
 *   upstream을 월 1회 병합해야 하므로(계획서 단계 6) 수정 면적을 0으로 두는 편이
 *   개별 호출부에 캐시를 심는 것보다 유지보수가 싸다.
 */

import { createHash } from "node:crypto"
import { kvConfigured, kvGet, kvSet, KvError } from "./kv-store.js"

const PREFIX = process.env.CACHE_PREFIX || "gqai:law"

/** 조문·법령 전문 등 본문 조회 TTL (초). 개정 전까지 불변이라 길게 잡는다. */
const TTL_LAW = parseInt(process.env.CACHE_TTL_LAW || "86400", 10)
/** 검색 결과 TTL (초). 신규 제·개정 반영 지연을 감안해 짧게 잡는다. */
const TTL_SEARCH = parseInt(process.env.CACHE_TTL_SEARCH || "3600", 10)
/** 캐시에 담을 응답 본문 상한 (바이트). 초과분은 저장 비용 대비 실익이 낮다. */
const MAX_BYTES = parseInt(process.env.CACHE_MAX_BYTES || "524288", 10)

const stats = { hit: 0, miss: 0, store: 0, skip: 0, error: 0 }
export function cacheStats() {
  const total = stats.hit + stats.miss
  return {
    ...stats,
    enabled: cacheEnabled(),
    backend: kvConfigured() ? "redis" : "disabled",
    hitRate: total > 0 ? Number((stats.hit / total).toFixed(3)) : null,
  }
}

export function cacheEnabled(): boolean {
  return kvConfigured() && process.env.CACHE_DISABLED !== "1"
}

function isLawGoKrHost(url: string): boolean {
  try {
    return /(^|\.)law\.go\.kr$/i.test(new URL(url).hostname)
  } catch {
    return false
  }
}

/**
 * 캐시 키 — OC를 제거한 URL의 해시.
 *
 * OC를 키에 넣지 않는 이유는 두 가지다. 첫째, 인증키는 어떤 형태로도 저장소에
 * 남기지 않는다(계획서 비밀정보 운영 원칙). 둘째, 같은 조문은 어떤 유효 키로
 * 조회하든 응답이 같으므로 키별로 캐시를 쪼개면 적중률만 떨어진다.
 * 자체 키 사용자의 조회가 공용 캐시를 채우고 그 반대도 성립한다.
 */
export function cacheKey(url: string): string {
  let normalized = url
  try {
    const u = new URL(url)
    // 인증키 계열 파라미터 전부 제거 후, 순서 무관하게 정렬해 키 분산을 막는다
    for (const p of ["OC", "oc", "apikey", "api_key", "authkey", "auth_key", "key"]) {
      u.searchParams.delete(p)
    }
    u.searchParams.sort()
    normalized = `${u.origin}${u.pathname}?${u.searchParams.toString()}`
  } catch {
    /* URL 파싱 실패 시 원문 해시 — 최소한 OC가 섞인 키가 저장되진 않게 아래에서 거른다 */
    if (/[?&](oc|apikey)=/i.test(url)) return ""
  }
  return `${PREFIX}:v1:${createHash("sha256").update(normalized).digest("hex").slice(0, 40)}`
}

export function ttlFor(url: string): number {
  // lawService.do = 본문 조회(조문·전문), lawSearch.do = 목록 검색
  if (/lawService\.do/i.test(url)) return TTL_LAW
  return TTL_SEARCH
}

/**
 * 캐시에 넣어도 되는 응답인지 판정.
 *
 * 특히 위험한 것은 법제처가 200으로 돌려주는 인증 실패 XML이다
 * ("사용자 정보 검증에 실패하였습니다..."). 이걸 캐시하면 OC·도메인 문제를
 * 고친 뒤에도 TTL 내내 실패가 재생되어 장애를 자가 연장한다.
 * 빈 본문·HTML 점검 페이지도 같은 이유로 제외한다.
 */
export function isCacheable(body: string): boolean {
  const t = body.trim()
  if (!t) return false
  if (/^<!doctype html/i.test(t) || /^<html[\s>]/i.test(t)) return false
  if (t.includes("사용자 정보 검증에 실패")) return false
  if (t.includes("등록되지 않은") && t.includes("OC")) return false
  if (Buffer.byteLength(t, "utf8") > MAX_BYTES) return false
  return true
}

let installed = false
let originalFetchRef: typeof fetch | null = null

/**
 * 캐시를 거치지 않는 원본 fetch.
 *
 * synthetic 감시(api/synthetic.ts)가 반드시 이걸 써야 한다. 캐시를 타면
 * 법제처가 완전히 끊긴 상태에서도 저장된 응답이 돌아와 "정상"으로 보고되고,
 * 감시가 감시 대상을 가리는 상태가 된다 — 관문 A의 출구 IP 판단이 통째로 무의미해진다.
 */
export function bypassFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  return (originalFetchRef ?? globalThis.fetch)(input as any, init)
}

/**
 * 전역 fetch를 캐시 레이어로 감싼다. 콜드스타트마다 1회, 중복 설치는 무시.
 * 법제처 GET 요청만 대상이며 그 외는 원본 fetch로 그대로 통과시킨다.
 */
export function installLawCache(): void {
  if (installed) return
  installed = true

  const originalFetch = globalThis.fetch
  originalFetchRef = originalFetch

  globalThis.fetch = async function cachedFetch(
    input: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    const method = (init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase()

    if (!cacheEnabled() || method !== "GET" || !isLawGoKrHost(url)) {
      return originalFetch(input, init)
    }

    const key = cacheKey(url)
    if (!key) return originalFetch(input, init)

    // ── 조회 ──
    try {
      const cached = await kvGet(key)
      if (cached !== null) {
        stats.hit++
        return new Response(cached, {
          status: 200,
          headers: {
            "content-type": "application/json; charset=UTF-8",
            "x-gqai-cache": "HIT",
          },
        })
      }
      stats.miss++
    } catch (e) {
      // 캐시 조회 실패가 본 요청을 막으면 안 된다 — 원본으로 진행
      stats.error++
      if (e instanceof KvError) console.error(`[cache] 조회 실패(통과): ${e.message}`)
    }

    const response = await originalFetch(input, init)
    if (!response.ok) return response

    // ── 저장 ──
    // 본문을 읽어야 캐시 가능 여부를 판정할 수 있으므로 clone으로 읽고,
    // 호출부에는 본문이 소비되지 않은 새 Response를 돌려준다.
    let body: string
    try {
      body = await response.clone().text()
    } catch {
      return response
    }

    if (!isCacheable(body)) {
      stats.skip++
      return response
    }

    // 저장은 응답을 붙잡지 않도록 백그라운드로 — 실패해도 사용자 요청엔 영향 없음
    kvSet(key, body, ttlFor(url))
      .then(() => { stats.store++ })
      .catch((e) => {
        stats.error++
        if (e instanceof KvError) console.error(`[cache] 저장 실패: ${e.message}`)
      })

    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: (() => {
        const h = new Headers(response.headers)
        h.set("x-gqai-cache", "MISS")
        return h
      })(),
    })
  } as typeof fetch
}

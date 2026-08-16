/**
 * fetch 인터셉트 통합 시험.
 *
 * 이 계층은 모든 법제처 호출이 지나는 단일 통로다. 여기가 틀리면 특정 도구가
 * 아니라 서비스 전체가 조용히 깨지거나(본문 소실) 쿼터가 무방비가 된다.
 * 저장소는 인메모리로 대체하고 통로 동작만 검증한다.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const store = new Map<string, string>()

vi.mock("./kv-store.js", () => ({
  kvConfigured: () => true,
  kvGet: async (k: string) => (store.has(k) ? store.get(k)! : null),
  kvSet: async (k: string, v: string) => { store.set(k, v) },
  kvIncrBy: async () => 1,
  kvEval: async () => [1, 0],
  kvPing: async () => true,
  KvError: class KvError extends Error {},
}))

const LAW_URL = "https://www.law.go.kr/DRF/lawSearch.do?OC=secret&target=law&query=민법"
const BODY = '{"LawSearch":{"totalCnt":"1","law":[{"법령명한글":"민법"}]}}'

let upstreamCalls = 0

beforeEach(() => {
  store.clear()
  upstreamCalls = 0
})

describe("installLawCache", () => {
  it("첫 호출은 원본을 부르고 두 번째는 캐시로 응답한다", async () => {
    globalThis.fetch = (async () => {
      upstreamCalls++
      return new Response(BODY, { status: 200, headers: { "content-type": "application/json" } })
    }) as typeof fetch

    const { installLawCache } = await import("./law-cache.js")
    installLawCache()

    const first = await fetch(LAW_URL)
    expect(await first.text()).toBe(BODY)
    expect(first.headers.get("x-gqai-cache")).toBe("MISS")
    expect(upstreamCalls).toBe(1)

    // 저장은 백그라운드라 다음 tick을 한 번 넘긴다
    await new Promise((r) => setTimeout(r, 10))

    const second = await fetch(LAW_URL)
    expect(await second.text()).toBe(BODY)
    expect(second.headers.get("x-gqai-cache")).toBe("HIT")
    expect(upstreamCalls).toBe(1) // 법제처를 다시 부르지 않았다 = 쿼터 절약
  })

  it("법제처 계열이 아닌 호스트는 통과시킨다", async () => {
    globalThis.fetch = (async () => {
      upstreamCalls++
      return new Response("ok", { status: 200 })
    }) as typeof fetch

    const { installLawCache } = await import("./law-cache.js")
    installLawCache()

    await fetch("https://example.com/anything")
    await fetch("https://example.com/anything")
    expect(upstreamCalls).toBe(2)
    expect(store.size).toBe(0)
  })

  it("인증 실패 응답은 캐시에 남기지 않는다", async () => {
    // 캐시되면 원인을 고쳐도 TTL 동안 실패가 재생된다
    globalThis.fetch = (async () => {
      upstreamCalls++
      return new Response(
        "<Law><resultMsg>사용자 정보 검증에 실패하였습니다.</resultMsg></Law>",
        { status: 200 }
      )
    }) as typeof fetch

    const { installLawCache } = await import("./law-cache.js")
    installLawCache()

    await fetch(LAW_URL)
    await new Promise((r) => setTimeout(r, 10))
    expect(store.size).toBe(0)

    await fetch(LAW_URL)
    expect(upstreamCalls).toBe(2) // 캐시로 가려지지 않고 매번 원본을 재시도
  })

  it("본문을 소비하지 않은 응답을 돌려준다", async () => {
    // clone으로 읽은 뒤 원본 스트림을 그대로 넘기면 호출부에서 'body already
    // consumed'로 터진다. 새 Response를 만들어 돌려주는지 확인한다.
    globalThis.fetch = (async () =>
      new Response(BODY, { status: 200 })) as typeof fetch

    const { installLawCache } = await import("./law-cache.js")
    installLawCache()

    const res = await fetch(LAW_URL)
    expect(res.bodyUsed).toBe(false)
    expect(await res.clone().text()).toBe(BODY) // upstream fetchWithRetry가 쓰는 패턴
    expect(await res.text()).toBe(BODY)
  })
})

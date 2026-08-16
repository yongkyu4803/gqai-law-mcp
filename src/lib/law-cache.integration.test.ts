/**
 * fetch 인터셉트 통합 시험.
 *
 * 이 계층은 모든 법제처 호출이 지나는 단일 통로다. 여기가 틀리면 특정 도구가
 * 아니라 서비스 전체가 조용히 깨지거나(본문 소실) 쿼터가 무방비가 된다.
 * 저장소는 인메모리로 대체하고 통로 동작만 검증한다.
 *
 * ⚠️ 시험마다 vi.resetModules()가 필요하다.
 * installLawCache()는 모듈 스코프의 `installed` 플래그로 중복 설치를 막는데,
 * 모듈을 리셋하지 않으면 두 번째 시험부터 설치가 no-op이 된다. 그 상태에서
 * 각 시험이 globalThis.fetch에 자기 스텁을 꽂으면 캐시 래퍼가 통째로 벗겨져,
 * "캐시를 안 타서" 통과하는 가짜 성공이 된다(실제로 그렇게 통과하고 있었다).
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const store = new Map<string, string>()
/** 전역 통계 해시 대용 — bump()가 실제로 카운터를 올리는지 확인용 */
const hashes = new Map<string, Record<string, number>>()

/** 파이프라인이 실제로 어떤 명령을 보냈는지 — 저장이 '요청됐는지' 확인용 */
const sentCommands: string[][] = []

vi.mock("./kv-store.js", () => ({
  kvConfigured: () => true,
  kvGet: async (k: string) => (store.has(k) ? store.get(k)! : null),
  kvSet: async (k: string, v: string) => { store.set(k, v) },
  kvIncrBy: async () => 1,
  kvEval: async () => [1, 0],
  kvPing: async () => true,
  kstDayKey: () => "2026-01-01",
  kvHGetAll: async (k: string) =>
    Object.fromEntries(Object.entries(hashes.get(k) ?? {}).map(([f, v]) => [f, String(v)])),
  kvPipeline: async (cmds: (string | number)[][]) => {
    return cmds.map((c) => {
      const op = String(c[0]).toUpperCase()
      sentCommands.push(c.map(String))
      if (op === "GET") return store.get(String(c[1])) ?? null
      if (op === "SET") { store.set(String(c[1]), String(c[2])); return "OK" }
      if (op === "HINCRBY") {
        const h = hashes.get(String(c[1])) ?? {}
        h[String(c[2])] = (h[String(c[2])] ?? 0) + Number(c[3])
        hashes.set(String(c[1]), h)
        return h[String(c[2])]
      }
      return 1
    })
  },
  KvError: class KvError extends Error {},
}))

const LAW_URL = "https://www.law.go.kr/DRF/lawSearch.do?OC=secret&target=law&query=민법"
const BODY = '{"LawSearch":{"totalCnt":"1","law":[{"법령명한글":"민법"}]}}'

let upstreamCalls = 0

beforeEach(() => {
  store.clear()
  hashes.clear()
  sentCommands.length = 0
  upstreamCalls = 0
  vi.resetModules() // installed 플래그를 초기화해 매 시험이 실제로 래퍼를 설치하게 한다
})

/** 지정한 응답을 돌려주는 상류 스텁을 꽂고 캐시 래퍼를 새로 설치한다 */
async function setupWith(makeResponse: () => Response) {
  globalThis.fetch = (async () => {
    upstreamCalls++
    return makeResponse()
  }) as typeof fetch
  const mod = await import("./law-cache.js")
  mod.installLawCache()
  // 설치 후 globalThis.fetch는 캐시 래퍼여야 한다 — 이게 아니면 아래 시험이 무의미하다
  return mod
}

/** 백그라운드 저장·통계 기록이 끝날 틈을 준다 */
const settle = () => new Promise((r) => setTimeout(r, 10))

describe("installLawCache", () => {
  it("첫 호출은 원본을 부르고 두 번째는 캐시로 응답한다", async () => {
    await setupWith(() => new Response(BODY, { status: 200 }))

    const first = await fetch(LAW_URL)
    expect(first.headers.get("x-gqai-cache")).toBe("MISS")
    expect(await first.text()).toBe(BODY)
    expect(upstreamCalls).toBe(1)

    await settle()

    const second = await fetch(LAW_URL)
    expect(second.headers.get("x-gqai-cache")).toBe("HIT")
    expect(await second.text()).toBe(BODY)
    expect(upstreamCalls).toBe(1) // 법제처를 다시 부르지 않았다 = 쿼터 절약
  })

  it("법제처 계열이 아닌 호스트는 통과시킨다", async () => {
    await setupWith(() => new Response("ok", { status: 200 }))

    await fetch("https://example.com/anything")
    await settle()
    await fetch("https://example.com/anything")

    expect(upstreamCalls).toBe(2) // 매번 상류로 나갔다
    expect(store.size).toBe(0)    // 캐시에 아무것도 남기지 않았다
  })

  it("인증 실패 응답은 캐시에 남기지 않는다", async () => {
    // 캐시되면 OC·도메인을 고쳐도 TTL 내내 실패가 재생된다
    await setupWith(() =>
      new Response("<Law><resultMsg>사용자 정보 검증에 실패하였습니다.</resultMsg></Law>", { status: 200 })
    )

    await fetch(LAW_URL)
    await settle()
    expect(store.size).toBe(0)

    await fetch(LAW_URL)
    expect(upstreamCalls).toBe(2) // 캐시로 가려지지 않고 매번 원본을 재시도
  })

  it("본문을 소비하지 않은 응답을 돌려준다", async () => {
    // clone으로 읽은 뒤 원본 스트림을 그대로 넘기면 호출부에서 'body already
    // consumed'로 터진다. upstream fetchWithRetry가 실제로 clone().text()를 쓴다.
    await setupWith(() => new Response(BODY, { status: 200 }))

    const res = await fetch(LAW_URL)
    expect(res.headers.get("x-gqai-cache")).toBe("MISS") // 래퍼를 탔음을 먼저 확인
    expect(res.bodyUsed).toBe(false)
    expect(await res.clone().text()).toBe(BODY)
    expect(await res.text()).toBe(BODY)
  })
})

describe("전역 통계", () => {
  it("적중·미스가 인스턴스가 아니라 공유 저장소에 누적된다", async () => {
    // 인스턴스 로컬 카운터는 콜드스타트마다 0으로 돌아가고 요청이 여러 인스턴스로
    // 흩어지면 일부만 반영된다. 적중률을 운영 지표로 쓰려면 전역이어야 한다.
    const mod = await setupWith(() => new Response(BODY, { status: 200 }))

    await fetch(LAW_URL) // miss
    await settle()
    await fetch(LAW_URL) // hit
    await settle()

    const stats = await mod.cacheStats()
    expect(stats.scope).toBe("global")
    expect(stats.hit).toBe(1)
    expect(stats.miss).toBe(1)
    expect(stats.hitRate).toBe(0.5)
    expect(stats.savedUpstreamCalls).toBe(1)
  })
})

describe("저장 보장", () => {
  it("응답을 돌려주기 전에 저장이 끝나 있다", async () => {
    // 백그라운드로 던지면 Vercel이 응답 직후 함수를 얼려 저장이 유실될 수 있다.
    // settle()을 기다리지 않고도 저장이 이미 끝나 있어야 한다.
    await setupWith(() => new Response(BODY, { status: 200 }))

    await fetch(LAW_URL)

    // 여기서 setTimeout을 한 번도 넘기지 않았는데 이미 저장돼 있어야 한다
    expect(store.size).toBe(1)
    expect(sentCommands.some((c) => c[0] === "SET")).toBe(true)
  })

  it("캐시 불가 응답은 저장하지 않고 skip으로 기록한다", async () => {
    await setupWith(() => new Response("", { status: 200 }))

    await fetch(LAW_URL)

    expect(store.size).toBe(0)
    expect(sentCommands.some((c) => c[0] === "SET")).toBe(false)
    expect(hashes.get("gqai:law:stats:2026-01-01")?.skip).toBe(1)
  })
})

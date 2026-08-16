/**
 * [GQAI 추가] Redis REST 클라이언트 — 서버리스 전역 상태 저장소
 *
 * 왜 필요한가:
 *   Vercel Function은 요청마다 다른 인스턴스에서 실행될 수 있다. 원본의
 *   프로세스 메모리 기반 토큰버킷·일일캡·캐시는 인스턴스별로 분리되므로
 *   "전체 호출량"을 전혀 보호하지 못한다(계획서 3.4절, 위험표 '인스턴스별 상태 분리').
 *   전역 카운터와 응답 캐시를 외부 저장소로 옮기기 위한 최소 클라이언트다.
 *
 * 왜 REST인가:
 *   TCP 기반 redis 클라이언트는 서버리스에서 연결 재사용이 어렵고 콜드스타트마다
 *   핸드셰이크 비용이 든다. Upstash REST는 fetch 한 번이라 추가 npm 의존성이
 *   전혀 없고(번들 크기 = 0) Function 번들 한도 위험도 늘리지 않는다.
 *
 * 환경변수는 Upstash 표준과 Vercel KV 표준을 모두 받는다 —
 * Vercel Marketplace로 Redis를 붙이면 KV_* 이름으로 주입되는 경우가 있다.
 */

const REST_URL =
  process.env.UPSTASH_REDIS_REST_URL ||
  process.env.KV_REST_API_URL ||
  ""

const REST_TOKEN =
  process.env.UPSTASH_REDIS_REST_TOKEN ||
  process.env.KV_REST_API_TOKEN ||
  ""

/** 저장소가 설정되어 있는지. false면 호출부가 로컬 폴백으로 degrade한다. */
export function kvConfigured(): boolean {
  return Boolean(REST_URL && REST_TOKEN)
}

/** 저장소 호출 타임아웃 — 캐시/한도 확인이 본 요청을 붙잡고 있으면 안 된다. */
const KV_TIMEOUT_MS = parseInt(process.env.KV_TIMEOUT_MS || "1500", 10)

export class KvError extends Error {}

/**
 * Redis 명령 1건 실행. 실패는 throw — 호출부가 폴백 정책을 결정한다.
 * (여기서 조용히 null을 반환하면 한도 게이트가 자기도 모르게 무력화된다.)
 */
async function command(args: (string | number)[]): Promise<unknown> {
  if (!kvConfigured()) throw new KvError("KV not configured")

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), KV_TIMEOUT_MS)
  try {
    const res = await fetch(REST_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${REST_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(args.map(String)),
      signal: controller.signal,
    })
    if (!res.ok) throw new KvError(`KV HTTP ${res.status}`)
    const json = (await res.json()) as { result?: unknown; error?: string }
    if (json.error) throw new KvError(`KV error: ${json.error}`)
    return json.result
  } catch (e) {
    if (e instanceof KvError) throw e
    throw new KvError(e instanceof Error ? e.message : String(e))
  } finally {
    clearTimeout(timer)
  }
}

export async function kvGet(key: string): Promise<string | null> {
  const r = await command(["GET", key])
  return typeof r === "string" ? r : null
}

/** @param ttlSec 만료 초. 0 이하면 만료 없음 */
export async function kvSet(key: string, value: string, ttlSec: number): Promise<void> {
  if (ttlSec > 0) await command(["SET", key, value, "EX", ttlSec])
  else await command(["SET", key, value])
}

export async function kvIncrBy(key: string, n: number, ttlSec: number): Promise<number> {
  const r = await command(["INCRBY", key, n])
  const v = Number(r)
  // 첫 증가에서만 만료를 건다 (매번 걸면 카운터가 영원히 리셋되지 않는다)
  if (v === n && ttlSec > 0) await command(["EXPIRE", key, ttlSec])
  return v
}

/**
 * Lua 스크립트 실행. 토큰버킷처럼 read-modify-write가 원자적이어야 하는
 * 연산에 사용한다 — GET 후 SET으로 나누면 동시 요청에서 한도가 새어나간다.
 */
export async function kvEval(
  script: string,
  keys: string[],
  args: (string | number)[]
): Promise<unknown> {
  return command(["EVAL", script, keys.length, ...keys, ...args])
}

/**
 * 여러 명령을 한 번의 HTTP 왕복으로 실행.
 * 카운터 증가처럼 "증가 + 만료설정"이 늘 짝으로 가는 연산에 쓴다 —
 * 나눠 보내면 왕복이 두 배가 되고, 그 사이 인스턴스가 얼어붙으면 만료가 안 걸린다.
 */
export async function kvPipeline(commands: (string | number)[][]): Promise<unknown[]> {
  if (!kvConfigured()) throw new KvError("KV not configured")

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), KV_TIMEOUT_MS)
  try {
    const res = await fetch(`${REST_URL}/pipeline`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${REST_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(commands.map((c) => c.map(String))),
      signal: controller.signal,
    })
    if (!res.ok) throw new KvError(`KV HTTP ${res.status}`)
    const json = (await res.json()) as { result?: unknown; error?: string }[]
    return json.map((r) => {
      if (r.error) throw new KvError(`KV error: ${r.error}`)
      return r.result
    })
  } catch (e) {
    if (e instanceof KvError) throw e
    throw new KvError(e instanceof Error ? e.message : String(e))
  } finally {
    clearTimeout(timer)
  }
}

/** 해시 전체 조회. 카운터 여러 개를 한 번의 왕복으로 읽는다. */
export async function kvHGetAll(key: string): Promise<Record<string, string>> {
  const r = await command(["HGETALL", key])
  // Upstash는 버전에 따라 평탄 배열 [f1,v1,f2,v2] 또는 객체를 돌려준다
  if (Array.isArray(r)) {
    const out: Record<string, string> = {}
    for (let i = 0; i + 1 < r.length; i += 2) out[String(r[i])] = String(r[i + 1])
    return out
  }
  if (r && typeof r === "object") {
    return Object.fromEntries(
      Object.entries(r as Record<string, unknown>).map(([k, v]) => [k, String(v)])
    )
  }
  return {}
}

/**
 * KST 기준 달력일 키.
 * 롤링 24시간 대신 달력일을 쓰는 이유는 운영 해석이 단순하기 때문이다 —
 * "오늘 몇 건"이 법제처 일일 쿼터와 바로 대응된다.
 */
export function kstDayKey(now = Date.now()): string {
  return new Date(now + 9 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

/** 저장소 왕복 확인 (헬스체크용) */
export async function kvPing(): Promise<boolean> {
  try {
    const r = await command(["PING"])
    return r === "PONG" || r === "pong"
  } catch {
    return false
  }
}

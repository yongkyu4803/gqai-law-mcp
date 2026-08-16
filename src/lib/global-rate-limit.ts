/**
 * [GQAI 추가] 전역 호출 한도 — Redis 기반 토큰버킷 + 일일 캡
 *
 * 원본(src/lib/rate-limit.ts)은 프로세스 메모리에 버킷을 둔다. 단일 프로세스
 * (Fly 컨테이너)에서는 맞지만 Vercel Function은 인스턴스가 수평 확장되므로
 * 인스턴스 수만큼 한도가 곱해진다 — 서버 OC 쿼터 보호가 사실상 무력해진다.
 * 계획서 관문 C("다중 인스턴스에 걸쳐 일관되게 작동")를 만족시키기 위해
 * 카운터를 Redis로 옮긴 구현이다.
 *
 * 저장소 장애 시 정책 (fail-degraded):
 *   Redis가 죽었을 때 fail-open이면 쿼터가 무방비로 소진되고, fail-closed면
 *   저장소 장애가 곧 전체 서비스 중단이 된다. 어느 쪽도 받아들이기 어렵다.
 *   그래서 원본의 인메모리 버킷으로 degrade하되 한도를 인스턴스 수로 나눠
 *   보수적으로 잡는다(KV_FALLBACK_DIVISOR). 보호가 약해진 상태임을 카운터로
 *   노출해 /health에서 관측할 수 있게 한다.
 */

import { kvConfigured, kvEval, kvIncrBy, kstDayKey, KvError } from "./kv-store.js"
import { createTokenBucket, createDailyCap, type Verdict } from "./rate-limit.js"

/** 원자적 토큰버킷 — HMGET/계산/HSET을 한 번의 EVAL로 묶는다 */
const TOKEN_BUCKET_LUA = `
local key   = KEYS[1]
local rate  = tonumber(ARGV[1])
local burst = tonumber(ARGV[2])
local now   = tonumber(ARGV[3])
local n     = tonumber(ARGV[4])

local data   = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(data[1])
local ts     = tonumber(data[2])
if tokens == nil or ts == nil then
  tokens = burst
  ts = now
end

local elapsed = now - ts
if elapsed < 0 then elapsed = 0 end
tokens = math.min(burst, tokens + (elapsed / 60000) * rate)

local allowed = 0
local retry = 0
if tokens >= n then
  tokens = tokens - n
  allowed = 1
else
  local want = n
  if want > burst then want = burst end
  local deficit = want - tokens
  retry = math.ceil((deficit / rate) * 60)
  if retry < 1 then retry = 1 end
end

redis.call('HSET', key, 'tokens', tokens, 'ts', now)
redis.call('EXPIRE', key, 3600)
return { allowed, retry }
`

/** 일일 캡 — 초과 시 증가시키지 않는다(거부분이 카운터를 소모하면 안 됨) */
const DAILY_CAP_LUA = `
local key   = KEYS[1]
local limit = tonumber(ARGV[1])
local n     = tonumber(ARGV[2])
local ttl   = tonumber(ARGV[3])

local cur = tonumber(redis.call('GET', key) or '0')
if cur + n > limit then
  return { 0, cur }
end
local newv = redis.call('INCRBY', key, n)
if newv == n then redis.call('EXPIRE', key, ttl) end
return { 1, newv }
`

const OK: Verdict = { ok: true, retryAfterSec: 0 }

/** 저장소 장애로 인메모리 폴백을 쓴 횟수 — 보호 약화 상태 관측용 */
let degradedCount = 0
let lastDegradedAt = 0
/** 캡 사용량 최근 관측치 (/health 표기용, 정확한 값은 Redis가 소유) */
let lastDailyUsed = -1

export function limiterStats() {
  return {
    backend: kvConfigured() ? "redis" : "memory",
    degradedCount,
    lastDegradedAt: lastDegradedAt ? new Date(lastDegradedAt).toISOString() : null,
    lastDailyUsed: lastDailyUsed < 0 ? null : lastDailyUsed,
  }
}

function noteDegraded() {
  degradedCount++
  lastDegradedAt = Date.now()
}

/** 남은 KST 당일 초 (캡 키 TTL·Retry-After 산출용) */
function secondsUntilKstMidnight(now = Date.now()): number {
  const kst = now + 9 * 60 * 60 * 1000
  const dayMs = 86_400_000
  return Math.max(60, Math.ceil((dayMs - (kst % dayMs)) / 1000))
}

export interface GlobalLimiterOptions {
  /** 분당 리필량. 0 이하면 폴백 자체를 비활성(모든 무키 요청 거부) */
  ratePerMin: number
  /** 버킷 용량. 기본 1분치 */
  burst: number
  /** 일일 상한. 0 이하면 캡 없음 */
  dailyCap: number
  /** 키 접두사 — Preview/Production이 같은 Redis를 공유해도 섞이지 않게 한다 */
  prefix: string
}

export interface GlobalLimiter {
  /** @param n 이 요청이 소모하는 tools/call 개수 */
  take(n: number): Promise<Verdict & { daily: boolean; degraded: boolean }>
}

export function createGlobalLimiter(opts: GlobalLimiterOptions): GlobalLimiter {
  const { ratePerMin, burst, dailyCap, prefix } = opts

  // 저장소 장애 시 쓸 인메모리 폴백. 인스턴스가 여러 개인 상황을 가정해
  // 한도를 나눠 잡는다 — 정확하진 않지만 무방비보다 낫다.
  const divisor = Math.max(1, parseInt(process.env.KV_FALLBACK_DIVISOR || "4", 10))
  const memMinute = createTokenBucket(
    Math.max(1, Math.floor(ratePerMin / divisor)),
    Math.max(1, Math.floor(burst / divisor))
  )
  const memDay = createDailyCap(dailyCap > 0 ? Math.max(1, Math.floor(dailyCap / divisor)) : 0)

  function memoryTake(n: number): Verdict & { daily: boolean; degraded: boolean } {
    const minute = memMinute.take(n)
    if (!minute.ok) return { ...minute, daily: false, degraded: true }
    const day = memDay.take(n)
    return { ok: day.ok, retryAfterSec: day.retryAfterSec, daily: !day.ok, degraded: true }
  }

  return {
    async take(n: number) {
      if (ratePerMin <= 0) {
        return { ok: false, retryAfterSec: 60, daily: false, degraded: false }
      }
      if (!kvConfigured()) return memoryTake(n)

      try {
        const minuteRaw = (await kvEval(
          TOKEN_BUCKET_LUA,
          [`${prefix}:fallback:bucket`],
          [ratePerMin, burst, Date.now(), n]
        )) as [number, number]

        if (Number(minuteRaw?.[0]) !== 1) {
          return {
            ok: false,
            retryAfterSec: Math.max(1, Number(minuteRaw?.[1]) || 60),
            daily: false,
            degraded: false,
          }
        }

        if (dailyCap <= 0) return { ...OK, daily: false, degraded: false }

        const ttl = secondsUntilKstMidnight()
        const dayRaw = (await kvEval(
          DAILY_CAP_LUA,
          [`${prefix}:fallback:daily:${kstDayKey()}`],
          [dailyCap, n, ttl]
        )) as [number, number]

        lastDailyUsed = Number(dayRaw?.[1]) || lastDailyUsed
        if (Number(dayRaw?.[0]) !== 1) {
          return { ok: false, retryAfterSec: ttl, daily: true, degraded: false }
        }
        return { ...OK, daily: false, degraded: false }
      } catch (e) {
        if (e instanceof KvError) {
          noteDegraded()
          console.error(`[limiter] KV 실패 — 인메모리 폴백으로 degrade: ${e.message}`)
          return memoryTake(n)
        }
        throw e
      }
    },
  }
}

/**
 * IP별 제한 — 봇 방어 수준으로만 운용한다.
 *
 * 원격 MCP 클라이언트(claude.ai 커넥터 등) 트래픽은 최종 사용자 IP가 아니라
 * 클라이언트 운영사의 소수 egress IP로 도달한다. 그래서 IP는 '사용자 식별'
 * 수단이 될 수 없다 — 빡빡하게 걸면 정상 사용자 전체가 한 버킷에 묶여
 * 오차단되고, 느슨하게 걸면 무의미하다(계획서 3.4절).
 * 총량 보호는 위 전역 한도가 맡고, 여기서는 명백한 스크래핑만 끊는다.
 */
export function createIpLimiter(prefix: string, rpm: number) {
  return {
    async take(ip: string, n: number): Promise<Verdict> {
      if (rpm <= 0) return OK
      if (!kvConfigured()) return OK // 저장소 없으면 전역 한도에 위임
      try {
        const used = await kvIncrBy(`${prefix}:ip:${ip}:${Math.floor(Date.now() / 60_000)}`, n, 120)
        if (used > rpm) return { ok: false, retryAfterSec: 60 }
        return OK
      } catch {
        return OK // 봇 방어는 실패 시 통과 — 총량은 전역 한도가 지킨다
      }
    },
  }
}

/**
 * [GQAI 추가] Synthetic 정기 점검 — Vercel 출구에서 법제처가 계속 응답하는지 감시
 *
 * 왜 필요한가(계획서 2.4·관문 A):
 *   Vercel 기본 출구 IP는 동적 풀에서 배정된다. 배포 직후 20회 연속 성공은
 *   "그 시점에 배정된 IP가 통과했다"는 뜻일 뿐, 이후 IP 로테이션으로 간헐 실패가
 *   날 수 있다. 고정 IP가 정말 불필요한지는 1~2주간의 실패율로만 확정된다.
 *
 * 반드시 캐시를 우회한다:
 *   캐시를 타면 법제처가 끊겨도 저장된 응답이 돌아와 계속 "정상"으로 보고된다.
 *   감시가 감시 대상을 가리게 되므로 bypassFetch로 실호출만 측정한다.
 */

import { bypassFetch } from "./law-cache.js"
import { getLawApiBaseUrl } from "./law-url-config.js"
import { kvConfigured, kvGet, kvSet, kvIncrBy } from "./kv-store.js"
import { maskSensitiveUrl } from "./fetch-with-retry.js"

const PREFIX = process.env.SYNTHETIC_PREFIX || "gqai:synthetic"
/** 일자별 카운터 보존 기간 — 1~2주 관측 창을 충분히 덮는다 */
const COUNTER_TTL_SEC = 60 * 60 * 24 * 30

export interface ProbeResult {
  name: string
  ok: boolean
  ms: number
  detail: string
}

export interface SyntheticReport {
  ok: boolean
  timestamp: string
  region: string | null
  probes: ProbeResult[]
}

function kstDay(now = Date.now()): string {
  return new Date(now + 9 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

/**
 * 응답 본문이 '실제 법령 데이터'인지 판정.
 *
 * HTTP 200만 보고 통과시키면 안 된다 — 법제처는 인증 실패와 안티봇 페이지를
 * 200으로 돌려준다. 이걸 성공으로 세면 감시가 장애를 놓친다.
 */
function classify(body: string): { ok: boolean; detail: string } {
  const t = body.trim()
  if (!t) return { ok: false, detail: "빈 응답" }
  if (t.includes("사용자 정보 검증에 실패")) {
    return { ok: false, detail: "인증 실패 — OC/도메인 등록 또는 Referer 확인 필요" }
  }
  if (/^<!doctype html/i.test(t) || /^<html[\s>]/i.test(t)) {
    return { ok: false, detail: "HTML 페이지 반환 — 안티봇 또는 점검" }
  }
  if (!/^[<{[]/.test(t)) return { ok: false, detail: `예상 밖 형식: ${t.slice(0, 60)}` }
  return { ok: true, detail: `${Buffer.byteLength(t, "utf8")}B` }
}

/** 법제처 실호출 1건. 본문까지 반환해 후속 프로브가 식별자를 뽑아 쓸 수 있게 한다. */
async function probe(name: string, url: string): Promise<ProbeResult & { body: string }> {
  const started = Date.now()
  try {
    const res = await bypassFetch(url, {
      headers: {
        // 원본과 동일한 헤더 조합 — 이 두 개가 법제처 통과의 결정적 요소다
        "user-agent":
          process.env.LAW_USER_AGENT ||
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        referer: process.env.LAW_REFERER || "https://www.law.go.kr/",
      },
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) {
      return { name, ok: false, ms: Date.now() - started, detail: `HTTP ${res.status}`, body: "" }
    }
    const body = await res.text()
    const verdict = classify(body)
    return { name, ok: verdict.ok, ms: Date.now() - started, detail: verdict.detail, body }
  } catch (e) {
    const msg = e instanceof Error ? maskSensitiveUrl(e.message) : String(e)
    return { name, ok: false, ms: Date.now() - started, detail: msg.slice(0, 160), body: "" }
  }
}

/** 검색 응답에서 법령일련번호(MST) 추출 — 필드명이 버전마다 흔들려 넓게 잡는다 */
function extractMst(body: string): string | null {
  const m =
    body.match(/"법령일련번호"\s*:\s*"?(\d{4,})"?/) ||
    body.match(/<법령일련번호>\s*(\d{4,})\s*</) ||
    body.match(/"MST"\s*:\s*"?(\d{4,})"?/)
  return m ? m[1] : null
}

/**
 * 핵심 조회 2건(법령 검색 → 본문 조회)을 실사용 경로 그대로 호출한다.
 *
 * 두 단계로 나눈 이유: 검색(lawSearch.do)과 본문(lawService.do)은 법제처 내부에서
 * 다른 엔드포인트라 한쪽만 죽는 장애가 실제로 있다. 또 본문 조회에 필요한 MST를
 * 하드코딩하면 법령 개편 시 감시가 조용히 거짓 실패를 내므로 매번 검색으로 얻는다.
 */
export async function runSynthetic(): Promise<SyntheticReport> {
  const oc = process.env.LAW_OC || process.env.KOREAN_LAW_API_KEY || ""
  const base = getLawApiBaseUrl()

  if (!oc) {
    return {
      ok: false,
      timestamp: new Date().toISOString(),
      region: process.env.VERCEL_REGION || null,
      probes: [{ name: "config", ok: false, ms: 0, detail: "LAW_OC 미설정" }],
    }
  }

  const probes: ProbeResult[] = []

  const searchParams = new URLSearchParams({
    OC: oc, target: "law", type: "JSON", query: "민법", display: "5",
  })
  const search = await probe("law_search", `${base}/lawSearch.do?${searchParams.toString()}`)
  probes.push({ name: search.name, ok: search.ok, ms: search.ms, detail: search.detail })

  if (search.ok) {
    const mst = extractMst(search.body)
    if (!mst) {
      probes.push({ name: "law_service", ok: false, ms: 0, detail: "검색 응답에서 MST 추출 실패" })
    } else {
      const detailParams = new URLSearchParams({
        OC: oc, target: "eflaw", type: "JSON", MST: mst, JO: "000100",
      })
      const svc = await probe("law_service", `${base}/lawService.do?${detailParams.toString()}`)
      probes.push({ name: svc.name, ok: svc.ok, ms: svc.ms, detail: svc.detail })
    }
  } else {
    probes.push({ name: "law_service", ok: false, ms: 0, detail: "검색 실패로 건너뜀" })
  }

  const report: SyntheticReport = {
    ok: probes.every((p) => p.ok),
    timestamp: new Date().toISOString(),
    region: process.env.VERCEL_REGION || null,
    probes,
  }

  await record(report)
  return report
}

/** 결과를 일자별 카운터와 최근 실행 스냅샷으로 남긴다 */
async function record(report: SyntheticReport): Promise<void> {
  if (!kvConfigured()) return
  try {
    const day = kstDay()
    await kvIncrBy(`${PREFIX}:${day}:${report.ok ? "ok" : "fail"}`, 1, COUNTER_TTL_SEC)
    await kvSet(`${PREFIX}:last`, JSON.stringify(report), COUNTER_TTL_SEC)
    if (!report.ok) {
      await kvSet(`${PREFIX}:lastFail`, JSON.stringify(report), COUNTER_TTL_SEC)
    }
  } catch {
    /* 기록 실패가 점검 자체를 실패로 만들진 않는다 */
  }
}

/** /health에 실을 관측치 — 오늘 실패율과 최근 실패 스냅샷 */
export async function syntheticStats(): Promise<Record<string, unknown> | null> {
  if (!kvConfigured()) return null
  try {
    const day = kstDay()
    const [okRaw, failRaw, last, lastFail] = await Promise.all([
      kvGet(`${PREFIX}:${day}:ok`),
      kvGet(`${PREFIX}:${day}:fail`),
      kvGet(`${PREFIX}:last`),
      kvGet(`${PREFIX}:lastFail`),
    ])
    const ok = Number(okRaw || 0)
    const fail = Number(failRaw || 0)
    const total = ok + fail
    return {
      today: day,
      ok,
      fail,
      failRate: total > 0 ? Number((fail / total).toFixed(3)) : null,
      last: last ? JSON.parse(last) : null,
      lastFail: lastFail ? JSON.parse(lastFail) : null,
    }
  } catch {
    return null
  }
}

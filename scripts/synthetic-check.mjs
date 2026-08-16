#!/usr/bin/env node
/**
 * 운영 상태 확인 — 계획서 단계 6의 "첫 7일간 매일 확인" 항목을 한 화면으로 묶은 도구.
 *
 * 감시 자체는 Vercel Cron이 /api/synthetic을 돌려 수행하고, 이 스크립트는 그
 * 누적 결과와 캐시·한도 상태를 /health에서 읽어 사람이 읽을 형태로 요약한다.
 * (감시를 외부에서 돌리면 Vercel 출구가 아닌 다른 경로를 재게 되어 의미가 없다.)
 *
 * 사용:
 *   node scripts/synthetic-check.mjs https://law.gqai.kr
 *   node scripts/synthetic-check.mjs https://law.gqai.kr --run   # 감시 1회 즉시 실행
 *
 * --run 에는 CRON_SECRET 환경변수가 필요하다.
 */

const BASE = (process.argv[2] || process.env.BASE_URL || "http://127.0.0.1:8000").replace(/\/$/, "")
const RUN_NOW = process.argv.includes("--run")

/** 실패율이 이 값을 넘으면 고정 IP 검토 대상으로 본다(계획서 관문 A) */
const FAIL_RATE_THRESHOLD = Number(process.env.SYNTHETIC_FAIL_THRESHOLD || "0.02")

function line(label, value, note = "") {
  console.log(`  ${label.padEnd(22)} ${String(value)}${note ? `  ${note}` : ""}`)
}

async function main() {
  console.log(`\nGQAI 법령조회 MCP 운영 확인 → ${BASE}\n${"─".repeat(62)}`)

  if (RUN_NOW) {
    const secret = process.env.CRON_SECRET
    if (!secret) {
      console.error("--run 에는 CRON_SECRET 환경변수가 필요합니다.\n")
      process.exit(2)
    }
    process.stdout.write("감시 1회 실행 중... ")
    const res = await fetch(`${BASE}/api/synthetic`, {
      headers: { authorization: `Bearer ${secret}` },
    })
    const body = await res.json().catch(() => null)
    console.log(res.ok ? "정상" : `실패 (HTTP ${res.status})`)
    if (body?.probes) {
      for (const p of body.probes) {
        console.log(`    - ${p.name}: ${p.ok ? "ok" : "FAIL"} ${p.ms}ms ${p.detail}`)
      }
    }
    console.log("")
  }

  const res = await fetch(`${BASE}/health`).catch(() => null)
  if (!res?.ok) {
    console.error(`❌ /health 응답 없음 — 서비스 상태를 확인하세요.\n`)
    process.exit(1)
  }
  const h = await res.json()

  console.log("\n[구성]")
  line("환경", `${h.env} (${h.region ?? "region 미상"})`)
  line("버전", h.version)
  line("법제처 키", h.config?.lawOcConfigured ? "설정됨" : "❌ 미설정")
  line("저장소(Redis)", h.config?.kvConfigured ? "연결됨" : "❌ 미설정")
  line("캐시", h.config?.cacheEnabled ? "활성" : "❌ 비활성")
  line("접근 인증", h.config?.authRequired ? "비공개 베타" : "공개")

  console.log("\n[캐시] — 쿼터 보호 1차 방어선")
  const c = h.cache ?? {}
  // scope=instance면 그 인스턴스가 본 것만이라 운영 지표로 읽으면 안 된다
  line("집계 범위", c.scope ?? "?", c.scope === "global" ? `(${c.day ?? ""} KST 전체)` : "⚠️ 인스턴스 한정")
  line("적중률", c.hitRate === null || c.hitRate === undefined ? "표본 없음" : `${(c.hitRate * 100).toFixed(1)}%`)
  line("hit / miss", `${c.hit ?? 0} / ${c.miss ?? 0}`)
  line("아낀 법제처 호출", c.savedUpstreamCalls ?? c.hit ?? 0, "건")
  line("저장 / 제외", `${c.store ?? 0} / ${c.skip ?? 0}`, c.skip > 0 ? "(제외=비정상 응답 차단)" : "")
  line("저장소 오류", c.error ?? 0, c.error > 0 ? "⚠️ 저장소 상태 확인" : "")

  console.log("\n[한도] — 공용 키 총량 보호")
  const lim = h.limits ?? {}
  line("일일 상한", lim.fallbackDailyCap ?? "?",
    !lim.fallbackDailyCap ? "⚠️ 0 = 무제한 — FALLBACK_DAILY_CAP을 설정하세요" : "")
  line("분당 상한", lim.fallbackRpm ?? "?")
  const l = h.limiter ?? {}
  line("백엔드", l.backend, l.backend === "memory" ? "⚠️ 인스턴스별 분리 — 총량 미보호" : "")
  line("degrade 횟수", l.degradedCount ?? 0, (l.degradedCount ?? 0) > 0 ? `⚠️ 최근 ${l.lastDegradedAt}` : "")
  line("금일 사용량", l.lastDailyUsed ?? "관측 없음")

  console.log("\n[감시] — Vercel 출구 → 법제처 도달성")
  const s = h.synthetic
  let exitCode = 0
  if (!s) {
    line("상태", "기록 없음", "저장소 미설정이거나 아직 실행 전")
  } else {
    const rate = s.failRate
    line("관측일(KST)", s.today)
    line("성공 / 실패", `${s.ok} / ${s.fail}`)
    if (rate === null) {
      line("실패율", "표본 없음")
    } else {
      const over = rate > FAIL_RATE_THRESHOLD
      line("실패율", `${(rate * 100).toFixed(1)}%`,
        over ? `⚠️ 임계(${(FAIL_RATE_THRESHOLD * 100).toFixed(0)}%) 초과 — 고정 IP 검토 대상` : "정상 범위")
      if (over) exitCode = 1
    }
    if (s.last) {
      line("최근 실행", `${s.last.timestamp} ${s.last.ok ? "정상" : "실패"}`)
      for (const p of s.last.probes ?? []) {
        console.log(`    - ${p.name}: ${p.ok ? "ok" : "FAIL"} ${p.ms}ms ${p.detail}`)
      }
    }
    if (s.lastFail) {
      console.log(`\n  최근 실패 스냅샷: ${s.lastFail.timestamp}`)
      for (const p of s.lastFail.probes ?? []) {
        if (!p.ok) console.log(`    - ${p.name}: ${p.detail}`)
      }
    }
  }

  console.log(`\n${"─".repeat(62)}\n`)
  process.exit(exitCode)
}

main().catch((e) => {
  console.error("확인 실패:", e.message)
  process.exit(1)
})

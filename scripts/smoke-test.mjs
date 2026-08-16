#!/usr/bin/env node
/**
 * 수용 기준 회귀 시험 — 계획서 7장 표를 그대로 자동화한 것.
 *
 * 왜 스크립트인가: upstream을 월 1회 병합하고(단계 6) 그때마다 같은 시나리오를
 * 다시 돌려야 한다. 수동 반복은 지속되지 않으므로 관문 D의 판정을 코드로 고정한다.
 *
 * 사용:
 *   node scripts/smoke-test.mjs [baseUrl]
 *   BASE_URL=https://law.gqai.kr node scripts/smoke-test.mjs
 *
 * 환경변수:
 *   MCP_AUTH_TOKEN  비공개 베타 기간의 접근 토큰
 *   SMOKE_REGRESSION_RUNS  '회귀' 항목 연속 성공 횟수 (기본 20, 0이면 생략)
 */

const BASE = (process.argv[2] || process.env.BASE_URL || "http://127.0.0.1:8000").replace(/\/$/, "")
const TOKEN = process.env.MCP_AUTH_TOKEN || ""
const REGRESSION_RUNS = parseInt(process.env.SMOKE_REGRESSION_RUNS ?? "20", 10)

const results = []
let rpcId = 0

function record(category, name, status, detail) {
  results.push({ category, name, status, detail })
  const mark = status === "pass" ? "✅" : status === "skip" ? "⏭️ " : "❌"
  console.log(`${mark} [${category}] ${name}${detail ? ` — ${detail}` : ""}`)
}

function authHeaders() {
  return TOKEN ? { "x-mcp-token": TOKEN } : {}
}

/** Streamable HTTP 응답은 JSON 또는 SSE로 온다 — 양쪽 다 파싱 */
async function readRpcBody(res) {
  const text = await res.text()
  const ctype = res.headers.get("content-type") || ""
  if (ctype.includes("text/event-stream")) {
    const line = text.split("\n").find((l) => l.startsWith("data:"))
    return line ? JSON.parse(line.slice(5).trim()) : null
  }
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

async function rpc(method, params, extraHeaders = {}) {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // SDK는 두 타입을 모두 요구한다 — 빠지면 406
      accept: "application/json, text/event-stream",
      ...authHeaders(),
      ...extraHeaders,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  })
  return { res, body: await readRpcBody(res) }
}

/** tools/call 결과에서 텍스트만 뽑는다 */
async function callTool(name, args) {
  const { res, body } = await rpc("tools/call", { name, arguments: args })
  const text = (body?.result?.content || []).map((c) => c.text).join("\n")
  return { status: res.status, isError: body?.result?.isError === true, text, body }
}

async function getHealth() {
  const res = await fetch(`${BASE}/health`)
  return res.ok ? res.json() : null
}

/**
 * 임의의 Host 헤더로 /mcp를 호출하고 상태코드만 돌려준다.
 * fetch()는 Host를 forbidden header로 막으므로 저수준 클라이언트를 쓴다.
 * TLS 대상에서는 SNI를 원래 호스트로 유지해 연결은 성립시키고 Host만 바꾼다.
 */
async function rawRequestWithHost(fakeHost) {
  const u = new URL(`${BASE}/mcp`)
  const isTls = u.protocol === "https:"
  const mod = await import(isTls ? "node:https" : "node:http")
  const payload = JSON.stringify({ jsonrpc: "2.0", id: 999, method: "tools/list", params: {} })

  return new Promise((resolve) => {
    const req = mod.request(
      {
        host: u.hostname,
        port: u.port || (isTls ? 443 : 80),
        path: u.pathname,
        method: "POST",
        servername: isTls ? u.hostname : undefined, // SNI는 실제 호스트 유지
        headers: {
          Host: fakeHost,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "content-length": Buffer.byteLength(payload),
          ...authHeaders(),
        },
      },
      (res) => {
        res.resume()
        resolve(res.statusCode ?? null)
      }
    )
    req.on("error", () => resolve(null))
    req.write(payload)
    req.end()
  })
}

// ── 시험 항목 ────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nGQAI 법령조회 MCP 수용 시험 → ${BASE}\n${"─".repeat(60)}`)

  const health = await getHealth()
  if (!health) {
    record("연결", "/health", "fail", "응답 없음 — 서버가 떠 있는지 확인")
    return finish()
  }
  record("연결", "/health", "pass", `env=${health.env} region=${health.region ?? "-"}`)

  const hasOc = health.config?.lawOcConfigured === true
  const cacheOn = health.config?.cacheEnabled === true
  if (!hasOc) console.log("\n⚠️  LAW_OC 미설정 — 법제처 실호출 항목은 skip 처리됩니다.\n")
  if (!cacheOn) console.log("⚠️  캐시 저장소 미설정 — 캐시 항목은 skip 처리됩니다.\n")

  // 1. initialize
  {
    const { res, body } = await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "gqai-smoke", version: "1.0.0" },
    })
    const proto = body?.result?.protocolVersion
    if (res.status === 200 && proto) {
      record("연결", "MCP initialize", "pass", `protocol=${proto}, server=${body.result.serverInfo?.name}`)
    } else {
      record("연결", "MCP initialize", "fail", `status=${res.status} body=${JSON.stringify(body)?.slice(0, 200)}`)
    }
  }

  // 2. tools/list
  let toolNames = []
  {
    const { res, body } = await rpc("tools/list", {})
    toolNames = (body?.result?.tools || []).map((t) => t.name)
    const required = ["search_law", "get_law_text", "search_decisions", "get_decision_text"]
    const missing = required.filter((t) => !toolNames.includes(t))
    if (res.status === 200 && missing.length === 0) {
      record("도구", "tools/list", "pass", `${toolNames.length}개 노출`)
    } else {
      record("도구", "tools/list", "fail", missing.length ? `누락: ${missing.join(", ")}` : `status=${res.status}`)
    }
  }

  // 3. 법령 검색 — 정확 일치가 최상단
  let mst = null
  if (hasOc) {
    const r = await callTool("search_law", { query: "민법" })
    if (!r.isError && r.text.includes("민법")) {
      // 후속 조문 조회용 식별자 확보
      const m = r.text.match(/mst[^\d]{0,4}(\d{4,})/i) || r.text.match(/MST['":\s]+(\d{4,})/)
      mst = m ? m[1] : null
      record("법령", "민법 검색", "pass", mst ? `mst=${mst}` : "식별자 추출 실패(조문 항목 skip)")
    } else {
      record("법령", "민법 검색", "fail", r.text.slice(0, 200))
    }
  } else {
    record("법령", "민법 검색", "skip", "LAW_OC 미설정")
  }

  // 4. 조문 조회
  // jo는 '제38조' 또는 6자리('003800') 형식을 받는다. 정수 문자열("1")을 넘기면
  // 법령 헤더만 돌아오고 조문 본문은 NOT_FOUND가 된다.
  if (hasOc && mst) {
    const r = await callTool("get_law_text", { mst, jo: "제1조" })
    const gotArticle = !r.isError && !/NOT_FOUND/.test(r.text) && r.text.length > 50
    if (gotArticle) {
      record("조문", "민법 제1조 조회", "pass", `${r.text.length}자 반환`)
    } else {
      record("조문", "민법 제1조 조회", "fail", r.text.slice(0, 200))
    }
  } else {
    record("조문", "민법 제1조 조회", "skip", hasOc ? "mst 미확보" : "LAW_OC 미설정")
  }

  // 5. 판례 검색 + 전문 조회
  if (hasOc) {
    const r = await callTool("search_decisions", { query: "손해배상", domain: "precedent" })
    if (!r.isError && r.text.length > 50) {
      record("판례", "판례 검색", "pass", `${r.text.length}자 반환`)
    } else {
      record("판례", "판례 검색", "fail", r.text.slice(0, 200))
    }
  } else {
    record("판례", "판례 검색", "skip", "LAW_OC 미설정")
  }

  // 6. 시점 비교 — 서로 다른 두 기준일이 각각 그 시점의 시행 버전으로 해석되는지
  //
  // get_law_text의 efYd로는 이걸 시험할 수 없다. efYd는 '임의의 날짜'가 아니라
  // 실제 시행일과 정확히 일치해야 하는 값이라, 아무 과거 날짜나 넣으면 NOT_FOUND가 된다.
  // 시점 해석은 legal_analysis의 applicable_law(행위시법 판단)가 담당한다 —
  // 기준일에 시행 중이던 버전을 역산해 그 시점 조문과 부칙 경과조치까지 준다.
  if (hasOc) {
    const pick = (t) => (t.match(/MST\s*(\d{4,})/) || [])[1] ?? null
    const past = await callTool("legal_analysis", {
      mode: "applicable_law", lawName: "민법", jo: "제1조", date: "2010-01-01",
    })
    const recent = await callTool("legal_analysis", {
      mode: "applicable_law", lawName: "민법", jo: "제1조", date: "2023-01-01",
    })
    const pastMst = pick(past.text)
    const recentMst = pick(recent.text)

    if (past.isError || recent.isError) {
      record("시점", "두 시점 버전 해석", "fail", (past.text || recent.text).slice(0, 200))
    } else if (pastMst && recentMst && pastMst !== recentMst) {
      // 두 날짜가 서로 다른 버전으로 갈렸다 = 시점 해석이 실제로 동작한다
      record("시점", "두 시점 버전 해석", "pass", `2010→MST ${pastMst}, 2023→MST ${recentMst}`)
    } else if (/기준일에 시행 중이던 버전/.test(past.text)) {
      record("시점", "두 시점 버전 해석", "pass", "버전 해석 동작(두 시점 동일 버전)")
    } else {
      record("시점", "두 시점 버전 해석", "fail", past.text.slice(0, 200))
    }
  } else {
    record("시점", "두 시점 버전 해석", "skip", "LAW_OC 미설정")
  }

  // 7. 오류 처리 — 존재하지 않는 조문
  if (hasOc && mst) {
    const r = await callTool("get_law_text", { mst, jo: "제9999조" })
    // 기대: 에러 플래그 또는 '찾을 수 없음' 계열 안내. 500이나 빈 응답이면 실패.
    const handled = r.isError || /찾을 수 없|없습니다|NOT_FOUND|확인해/i.test(r.text)
    record("오류", "존재하지 않는 조문", handled ? "pass" : "fail", r.text.slice(0, 120))
  } else {
    record("오류", "존재하지 않는 조문", "skip", hasOc ? "mst 미확보" : "LAW_OC 미설정")
  }

  // 8. 공개키 폴백 — 클라이언트가 OC를 안 보내도 서버 키로 조회
  if (hasOc) {
    const r = await callTool("search_law", { query: "상법" })
    record("공개키", "클라이언트 OC 미전달", r.isError ? "fail" : "pass", r.isError ? r.text.slice(0, 150) : "서버 OC 폴백 동작")
  } else {
    record("공개키", "클라이언트 OC 미전달", "skip", "LAW_OC 미설정")
  }

  // 9. 캐시 — 같은 조회를 반복하면 2회차는 법제처를 다시 부르지 않아야 한다
  //
  // 반드시 판례(search_decisions)로 시험한다. 법령 검색으로 하면 upstream의
  // 인메모리 lawCache가 도구 결과 단계에서 먼저 응답해버려 fetch 계층까지
  // 내려오지 않고, 그러면 이 캐시의 카운터가 전혀 움직이지 않아 '실패'로 보인다.
  // 판례 경로는 upstream이 캐시하지 않으므로 이 캐시가 유일한 계층이다.
  if (hasOc && cacheOn) {
    const q = { query: "근로계약 해지 위약금", domain: "precedent" }
    await callTool("search_decisions", q) // 캐시를 채운다
    const before = (await getHealth())?.cache ?? {}
    await callTool("search_decisions", q) // 이번엔 전부 적중해야 한다
    const after = (await getHealth())?.cache ?? {}
    const lookupDelta = (after.lookup ?? 0) - (before.lookup ?? 0)
    const missDelta = (after.miss ?? 0) - (before.miss ?? 0)
    const ok = lookupDelta > 0 && missDelta === 0
    record("캐시", "동일 조회 반복", ok ? "pass" : "fail",
      `조회 ${lookupDelta}건 중 미스 ${missDelta}건, 누적 적중률=${after.hitRate ?? "-"}`)
  } else {
    record("캐시", "동일 조회 반복", "skip", cacheOn ? "LAW_OC 미설정" : "캐시 저장소 미설정")
  }

  // 10. 보안 — 비정상 Host 헤더 거부 (DNS rebinding 방어)
  // fetch()는 Host를 금지 헤더로 취급해 덮어쓸 수 없다 → node:http로 직접 보낸다
  {
    const status = await rawRequestWithHost("evil.example.com")
    if (status === null) {
      record("보안", "비정상 Host 거부", "skip", "요청 전송 실패")
    } else if (status === 403) {
      record("보안", "비정상 Host 거부", "pass", "앱 미들웨어가 차단 (403)")
    } else if (status === 404) {
      // Vercel 엣지는 Host로 프로젝트를 고르므로 미등록 Host는 함수에 닿지 못한다
      record("보안", "비정상 Host 거부", "pass", "플랫폼 엣지가 차단 (404, 함수 미도달)")
    } else {
      record("보안", "비정상 Host 거부", "fail", `거부되지 않음 status=${status}`)
    }
  }

  // 11. 보안 — 응답/오류에 OC가 섞여 나오지 않는가
  if (hasOc) {
    const oc = process.env.LAW_OC || process.env.KOREAN_LAW_API_KEY || ""
    const r = await callTool("get_law_text", { mst: "0000000" })
    const leaked = oc && r.text.includes(oc)
    record("보안", "오류 메시지 OC 미노출", leaked ? "fail" : "pass", leaked ? "OC가 응답에 노출됨" : "노출 없음")
  } else {
    record("보안", "오류 메시지 OC 미노출", "skip", "LAW_OC 미설정")
  }

  // 12. 한도 — 배치 상한 초과 시 429 + Retry-After
  {
    const over = parseInt(process.env.MCP_MAX_BATCH_CALLS || "20", 10) + 5
    const batch = Array.from({ length: over }, (_, i) => ({
      jsonrpc: "2.0", id: 5000 + i, method: "tools/call",
      params: { name: "search_law", arguments: { query: "민법" } },
    }))
    const res = await fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...authHeaders(),
      },
      body: JSON.stringify(batch),
    })
    record("한도", "배치 상한 초과", res.status === 429 ? "pass" : "fail", `status=${res.status}`)
  }

  // 13. 도메인 — 원격 대상일 때만 TLS 확인
  if (BASE.startsWith("https://")) {
    const res = await fetch(`${BASE}/health`).catch(() => null)
    record("도메인", "TLS·HTTPS", res?.ok ? "pass" : "fail", res ? `status=${res.status}` : "연결 실패")
  } else {
    record("도메인", "TLS·HTTPS", "skip", "로컬 대상")
  }

  // 14. 회귀 — 핵심 시나리오 연속 성공
  if (hasOc && REGRESSION_RUNS > 0) {
    let ok = 0
    for (let i = 0; i < REGRESSION_RUNS; i++) {
      const r = await callTool("search_law", { query: "민법" })
      if (!r.isError) ok++
      else break
    }
    record("회귀", `연속 조회 ${REGRESSION_RUNS}회`, ok === REGRESSION_RUNS ? "pass" : "fail", `${ok}/${REGRESSION_RUNS} 성공`)
  } else {
    record("회귀", "연속 조회", "skip", hasOc ? "SMOKE_REGRESSION_RUNS=0" : "LAW_OC 미설정")
  }

  finish()
}

function finish() {
  const pass = results.filter((r) => r.status === "pass").length
  const fail = results.filter((r) => r.status === "fail").length
  const skip = results.filter((r) => r.status === "skip").length
  console.log(`${"─".repeat(60)}\n결과: ${pass} pass / ${fail} fail / ${skip} skip\n`)
  if (fail > 0) {
    console.log("실패 항목:")
    for (const r of results.filter((x) => x.status === "fail")) {
      console.log(`  • [${r.category}] ${r.name} — ${r.detail}`)
    }
    console.log("")
  }
  process.exit(fail > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error("시험 실행 오류:", e)
  process.exit(1)
})

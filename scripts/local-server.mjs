#!/usr/bin/env node
/**
 * 로컬 검증 서버 — Vercel에 배포되는 것과 '같은' Express 앱을 그대로 띄운다.
 *
 * 원본의 `npm start`(http-server.ts)를 쓰면 Vercel용 코드 경로(전역 캐시·Redis
 * 한도·Host 검증)가 전혀 실행되지 않아 로컬 통과가 배포 통과를 보장하지 못한다.
 * 그래서 build/server/vercel-app.js를 직접 listen시켜 동일 경로를 검증한다.
 *
 * 사용: npm run build && node scripts/local-server.mjs [port]
 */

import { createApp } from "../build/server/vercel-app.js"

const port = parseInt(process.argv[2] || process.env.PORT || "8000", 10)
const app = createApp()

app.listen(port, "127.0.0.1", () => {
  console.log(`GQAI 법령조회 MCP (로컬 검증) → http://127.0.0.1:${port}`)
  console.log(`  MCP    : http://127.0.0.1:${port}/mcp`)
  console.log(`  Health : http://127.0.0.1:${port}/health`)
  if (!process.env.LAW_OC && !process.env.KOREAN_LAW_API_KEY) {
    console.log("  ⚠️  LAW_OC 미설정 — 법제처 실호출 시험은 건너뜁니다.")
  }
})

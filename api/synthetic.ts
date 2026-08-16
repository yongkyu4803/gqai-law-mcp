/**
 * Synthetic 정기 점검 엔드포인트 (Vercel Cron 전용)
 *
 * Vercel Cron이 이 경로를 주기 호출한다. 외부에서 프로브를 돌리지 않고 굳이
 * Function 안에서 도는 이유는, 감시 대상이 '법제처 응답'이 아니라
 * 'Vercel 출구에서 본 법제처 응답'이기 때문이다. 실제 사용자 트래픽과 같은
 * 출구를 써야 IP 로테이션에 따른 간헐 실패가 잡힌다(계획서 관문 A).
 *
 * 인증: Vercel Cron은 Authorization: Bearer $CRON_SECRET 을 보낸다.
 * CRON_SECRET을 설정하지 않으면 이 엔드포인트는 열린 상태가 되므로 반드시 설정한다.
 */

import { runSynthetic } from "../build/lib/synthetic.js"

interface Req {
  headers: Record<string, string | string[] | undefined>
  method?: string
}
interface Res {
  status(code: number): Res
  json(body: unknown): void
  setHeader(name: string, value: string): void
}

export default async function handler(req: Req, res: Res) {
  const secret = process.env.CRON_SECRET || ""
  const presented = String(req.headers["authorization"] || "")

  if (secret && presented !== `Bearer ${secret}`) {
    res.status(401).json({ error: "Unauthorized" })
    return
  }
  if (!secret) {
    // 열린 상태를 조용히 넘기지 않는다 — 로그에 남겨 설정 누락을 드러낸다
    console.warn("[synthetic] CRON_SECRET 미설정 — 엔드포인트가 인증 없이 노출되어 있습니다.")
  }

  const report = await runSynthetic()

  // 실패는 경고 수준으로 남겨 Vercel 로그 드레인·알림이 잡을 수 있게 한다
  if (!report.ok) {
    console.error(
      `[synthetic] 실패 region=${report.region ?? "-"} ` +
        report.probes.map((p) => `${p.name}=${p.ok ? "ok" : `FAIL(${p.detail})`}`).join(" ")
    )
  } else {
    console.log(
      `[synthetic] 정상 region=${report.region ?? "-"} ` +
        report.probes.map((p) => `${p.name}=${p.ms}ms`).join(" ")
    )
  }

  res.setHeader("cache-control", "no-store")
  // 실패 시 5xx로 응답해 Vercel 배포/모니터링 쪽에서도 이상으로 집계되게 한다
  res.status(report.ok ? 200 : 503).json(report)
}

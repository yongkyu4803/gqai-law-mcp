/**
 * [GQAI 추가] 행정규칙 부분 조회 — read_admin_rule
 *
 * 왜 필요한가:
 *   upstream의 get_admin_rule은 전문을 한 문자열로 이어붙인 뒤 50,000자에서
 *   잘라낸다. 금융투자업규정 실측 기준 전체 750,711자 중 6.7%만 노출되고,
 *   조문 뒤에 붙는 부칙 101건·별표 79개(362,660자)는 구조적으로 도달 불가다.
 *   법령 조회와 달리 뒷부분을 가져올 수단이 없어 4단 비교표 같은 작업이 막힌다.
 *
 * 왜 법제처 파라미터로 못 푸는가:
 *   lawService.do?target=admrul 은 JO 파라미터를 무시한다. 000300 / 031200 /
 *   0312 / 3-12 / 000100 다섯 형식을 실측했고 전부 동일한 전문(1.6MB)을 반환했다.
 *   따라서 전문을 받아 서버에서 잘라 주는 수밖에 없다.
 *
 * 왜 조문 분할이 가능한가:
 *   응답의 조문내용은 개행이 0개인 단일 문자열이지만, 조문 머리말
 *   `제N조(`, `제N-M조(`, `제N조의M(` 패턴으로 자를 수 있다. 인용문
 *   ("법 제9조(정의)에 따라")이 섞여 오탐이 나므로 조문 번호가 단조 증가해야
 *   한다는 제약으로 걸러낸다. 실측 4개 규칙에서 커버리지 100%/99.8%, 중복 0.
 */

import { z } from "zod"
import type { LawApiClient } from "../lib/api-client.js"
import { truncateResponse } from "../lib/schemas.js"
import { formatToolError } from "../lib/errors.js"

export const ReadAdminRuleSchema = z.object({
  id: z.string().describe("행정규칙일련번호 13자리 (search_admin_rule 결과의 '행정규칙일련번호'). 4~5자리 '행정규칙ID'로는 조회되지 않음"),
  mode: z.enum(["toc", "article", "annex", "addendum"]).optional().default("toc")
    .describe("toc=목차(편·장·조 목록, 기본값) | article=조문 본문 | annex=별표 | addendum=부칙"),
  jo: z.string().optional()
    .describe("[article] 조문 번호. '제3-12조' '3-12' '제12조' '제12조의2' 모두 인식. 생략 시 앞에서부터"),
  to: z.string().optional()
    .describe("[article] 범위 끝 조문. jo와 함께 쓰면 jo~to 구간을 반환"),
  annex: z.string().optional()
    .describe("[annex] 별표 번호 또는 제목 일부. 생략 시 별표 목록만 반환"),
  maxChars: z.number().optional().default(40000)
    .describe("응답 최대 길이. 초과 시 어디까지 반환했는지와 다음 호출 방법을 안내"),
  apiKey: z.string().optional().describe("법제처 Open API 인증키(OC). 사용자가 제공한 경우 전달"),
})

export type ReadAdminRuleInput = z.infer<typeof ReadAdminRuleSchema>

// ── 조문 분할 ────────────────────────────────────────────────────────────────

/** 조문 머리말. 세 체계를 모두 받는다: 제N조( / 제N-M조( / 제N조의M( */
const ARTICLE_HEAD = /제(\d+)(?:-(\d+))?조(?:의(\d+))?\s*\(/g

type ArtKey = [number, number, number]
const keyOf = (m: RegExpMatchArray): ArtKey => [Number(m[1]), m[2] ? Number(m[2]) : 0, m[3] ? Number(m[3]) : 0]
const cmpKey = (a: ArtKey, b: ArtKey) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]

function labelOf(m: RegExpMatchArray): string {
  const base = m[2] ? `제${m[1]}-${m[2]}조` : `제${m[1]}조`
  return m[3] ? `${base}의${m[3]}` : base
}

export interface Article { id: string; title: string; text: string; key: ArtKey }

/**
 * 조문 단위로 자른다.
 *
 * 단조 증가 제약이 핵심이다. 본문에는 다른 법령을 인용하는 "제9조(정의)" 같은
 * 문자열이 섞여 있는데, 이를 조문 시작으로 오인하면 한 조문이 조각나고 목차가
 * 오염된다. 번호가 앞 조문보다 크지 않으면 인용으로 보고 앞 조문에 흡수시킨다.
 */
export function splitArticles(text: string): Article[] {
  const cands = [...text.matchAll(ARTICLE_HEAD)]
  const kept: { m: RegExpMatchArray; key: ArtKey }[] = []
  let prev: ArtKey | null = null
  for (const m of cands) {
    const k = keyOf(m)
    if (prev && cmpKey(k, prev) <= 0) continue
    kept.push({ m, key: k })
    prev = k
  }
  return kept.map((c, i) => {
    const start = c.m.index!
    const end = i + 1 < kept.length ? kept[i + 1].m.index! : text.length
    const body = text.slice(start, end)
    return {
      id: labelOf(c.m),
      title: (body.match(/^[^(]*\(([^)]{0,60})\)/) || [])[1] || "",
      text: body.trim(),
      key: c.key,
    }
  })
}

/** 사용자 입력('3-12', '제3-12조', '제12조의2')을 정렬키로 */
function parseJo(input: string): ArtKey | null {
  const m = input.match(/(\d+)(?:\s*-\s*(\d+))?(?:\s*조)?(?:\s*의\s*(\d+))?/)
  if (!m) return null
  return [Number(m[1]), m[2] ? Number(m[2]) : 0, m[3] ? Number(m[3]) : 0]
}

// ── 응답 파싱 ────────────────────────────────────────────────────────────────

interface AdmRule {
  name: string
  type: string
  org: string
  promDate: string
  articles: Article[]
  annexes: { no: string; kind: string; title: string; content: string; fileLink: string }[]
  addenda: { date: string; no: string; content: string }[]
  bodyLength: number
}

const asArray = <T>(v: T | T[] | undefined | null): T[] =>
  v == null ? [] : Array.isArray(v) ? v : [v]

/**
 * 별표 번호 정규화.
 * 법제처는 별표번호를 "0002" 처럼 4자리로 채워 보낸다. 이걸 그대로 두면
 * 사용자가 자연스럽게 넣는 "2"가 정확 일치에 실패하고 제목 검색으로 새어
 * 엉뚱한 별표들이 잡힌다(실측: "5" → 제5-50조가 제목에 든 별표 5건).
 */
function normalizeAnnexNo(no: unknown, branch: unknown): string {
  const strip = (v: unknown) => String(v ?? "").trim().replace(/^0+(?=\d)/, "")
  const n = strip(no)
  const b = strip(branch)
  return b && b !== "0" ? `${n}-${b}` : n
}

function parseAdmRule(json: string): AdmRule | null {
  let root: any
  try { root = JSON.parse(json) } catch { return null }
  const b = root?.[Object.keys(root)[0]]
  if (!b || typeof b !== "object") return null

  const info = b.행정규칙기본정보 ?? {}
  const jo = b.조문내용
  const body = Array.isArray(jo) ? jo.join("\n") : (typeof jo === "string" ? jo : "")

  const annexes = asArray<any>(b.별표?.별표단위).map((x) => ({
    no: normalizeAnnexNo(x?.별표번호, x?.별표가지번호),
    // 같은 번호가 별표·서식 등으로 중복될 수 있어 구분을 함께 보여준다
    kind: String(x?.별표구분 ?? "").trim(),
    title: String(x?.별표제목 ?? "").trim(),
    content: String(x?.별표내용 ?? "").trim(),
    fileLink: String(x?.별표서식파일링크 ?? x?.별표서식PDF파일링크 ?? "").trim(),
  }))

  // 부칙은 내용·공포일자·공포번호가 각각 평행 배열로 온다
  const contents = asArray<any>(b.부칙?.부칙내용)
  const dates = asArray<any>(b.부칙?.부칙공포일자)
  const nos = asArray<any>(b.부칙?.부칙공포번호)
  const addenda = contents.map((c, i) => ({
    date: String(dates[i] ?? ""),
    no: String(nos[i] ?? ""),
    content: (Array.isArray(c) ? c.join("\n") : String(c ?? "")).trim(),
  }))

  return {
    name: String(b.행정규칙명 ?? info.행정규칙명 ?? "").trim() || "알 수 없음",
    type: String(b.행정규칙종류 ?? info.행정규칙종류 ?? "").trim(),
    org: String(b.소관부처 ?? info.담당부서기관명 ?? "").trim(),
    promDate: String(b.공포일자 ?? info.발령일자 ?? "").trim(),
    articles: splitArticles(body),
    annexes,
    addenda,
    bodyLength: body.length,
  }
}

// ── 렌더링 ───────────────────────────────────────────────────────────────────

function header(r: AdmRule): string {
  let s = `행정규칙명: ${r.name}\n`
  if (r.type) s += `종류: ${r.type}\n`
  if (r.org) s += `소관: ${r.org}\n`
  if (r.promDate) s += `발령일: ${r.promDate}\n`
  return s
}

/** 응답이 상한을 넘으면 어디서 끊겼고 다음에 뭘 부르면 되는지 반드시 알린다 */
function capped(text: string, max: number, resumeHint: string): string {
  if (text.length <= max) return text
  return text.slice(0, max) + `\n\n⚠️ 여기까지 ${max.toLocaleString()}자입니다. 이어서 보려면: ${resumeHint}`
}

function renderToc(r: AdmRule, id: string, max: number): Rendered {
  let s = header(r)
  s += `\n총 조문 ${r.articles.length}개 · 부칙 ${r.addenda.length}건 · 별표 ${r.annexes.length}개`
  s += ` (본문 ${r.bodyLength.toLocaleString()}자)\n`
  s += `\n조문을 읽으려면: read_admin_rule({ id: "${id}", mode: "article", jo: "제N조" })\n`
  if (r.annexes.length) s += `별표를 보려면: read_admin_rule({ id: "${id}", mode: "annex" })\n`
  if (r.addenda.length) s += `부칙을 보려면: read_admin_rule({ id: "${id}", mode: "addendum" })\n`
  s += `\n--- 조문 목차 ---\n`

  let lastPart = ""
  for (const a of r.articles) {
    // 편이 바뀌는 지점을 표시해 LLM이 구간을 잡기 쉽게 한다
    const part = a.key[1] > 0 ? `제${a.key[0]}편` : ""
    if (part && part !== lastPart) { s += `\n[${part}]\n`; lastPart = part }
    s += `  ${a.id}${a.title ? `(${a.title})` : ""}\n`
  }
  return { text: capped(s, max, `mode:"article" 으로 필요한 조문을 지정하세요`) }
}

interface Rendered { text: string; isError?: boolean }

function renderArticles(r: AdmRule, id: string, input: ReadAdminRuleInput, max: number): Rendered {
  let list = r.articles
  const from = input.jo ? parseJo(input.jo) : null
  const to = input.to ? parseJo(input.to) : null

  if (from) {
    if (to) {
      list = list.filter((a) => cmpKey(a.key, from) >= 0 && cmpKey(a.key, to) <= 0)
    } else {
      // 단일 지정: 정확 일치 우선, 없으면 그 지점부터 이어서
      const exact = list.filter((a) => cmpKey(a.key, from) === 0)
      list = exact.length ? exact : list.filter((a) => cmpKey(a.key, from) >= 0)
    }
  }

  if (!list.length) {
    const near = r.articles.slice(0, 5).map((a) => a.id).join(", ")
    return {
      isError: true,
      text: `${header(r)}\n[NOT_FOUND] 지정한 조문을 찾을 수 없습니다 (jo=${input.jo ?? "-"}).\n` +
        `이 규칙의 조문 예: ${near} …\n전체 목록은 mode:"toc" 로 확인하세요.\n` +
        `⚠️ LLM은 조문 내용을 추측/생성하지 마세요.`,
    }
  }

  let s = header(r) + `\n`
  let used = s.length
  const out: string[] = []
  let stoppedAt: string | null = null
  for (const a of list) {
    if (used + a.text.length > max && out.length) { stoppedAt = a.id; break }
    out.push(a.text)
    used += a.text.length + 2
  }
  s += out.join("\n\n")
  if (stoppedAt) {
    s += `\n\n⚠️ 길이 제한으로 ${stoppedAt} 앞에서 끊었습니다. 이어서 보려면: ` +
      `read_admin_rule({ id: "${id}", mode: "article", jo: "${stoppedAt}" })`
  }
  return { text: s }
}

function renderAnnex(r: AdmRule, id: string, input: ReadAdminRuleInput, max: number): Rendered {
  if (!r.annexes.length) return { text: `${header(r)}\n이 행정규칙에는 별표가 없습니다.` }

  if (!input.annex) {
    let s = header(r) + `\n별표 ${r.annexes.length}개\n\n`
    for (const a of r.annexes) s += `  [${a.kind || "별표"} ${a.no}] ${a.title}\n`
    s += `\n본문을 보려면: read_admin_rule({ id: "${id}", mode: "annex", annex: "번호 또는 제목 일부" })`
    return { text: capped(s, max, `annex 파라미터로 하나를 지정하세요`) }
  }

  const q = input.annex.trim()
  // 번호는 정규화 후 정확 일치를 우선한다. 접두·제목 매칭만 쓰면 "5"가
  // 50·51이나 제목 속 "제5-50조"까지 끌어와 상한을 채우고 정작 원한 별표가 잘린다.
  const qn = q.replace(/^0+(?=\d)/, "")
  const exact = r.annexes.filter((a) => a.no === qn)
  const hit = exact.length
    ? exact
    : r.annexes.filter((a) => a.no.startsWith(`${qn}-`) || a.title.includes(q))
  if (!hit.length) {
    return {
      isError: true,
      text: `${header(r)}\n[NOT_FOUND] '${q}'에 해당하는 별표가 없습니다.\n` +
        `mode:"annex" 로 목록을 먼저 확인하세요.`,
    }
  }
  let s = header(r) + `\n`
  for (const a of hit.slice(0, 5)) {
    s += `\n[${a.kind || "별표"} ${a.no}] ${a.title}\n`
    s += a.content ? `${a.content}\n` : `(본문이 첨부파일로만 제공됩니다)\n`
    if (a.fileLink) s += `파일: https://www.law.go.kr${a.fileLink}\n`
  }
  return { text: capped(s, max, `annex 를 더 구체적으로 지정하세요`) }
}

function renderAddendum(r: AdmRule, max: number): Rendered {
  if (!r.addenda.length) return { text: `${header(r)}\n이 행정규칙에는 부칙 정보가 없습니다.` }
  let s = header(r) + `\n부칙 ${r.addenda.length}건 (최신순)\n\n`
  for (const a of [...r.addenda].reverse()) {
    s += `◆ ${a.date}${a.no ? ` 제${a.no}호` : ""}\n${a.content}\n\n`
  }
  return { text: capped(s, max, `최신 부칙부터 표시했습니다`) }
}

// ── 핸들러 ───────────────────────────────────────────────────────────────────

export async function readAdminRule(
  apiClient: LawApiClient,
  input: ReadAdminRuleInput
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  try {
    // 법제처가 부분 조회를 지원하지 않아 매번 전문을 받는다.
    // 응답이 크므로(1.6MB급) 캐시 상한을 넉넉히 잡아둔 것이 전제다.
    const json = await apiClient.fetchApi({
      endpoint: "lawService.do",
      target: "admrul",
      type: "JSON",
      extraParams: { ID: input.id },
      apiKey: input.apiKey,
    })

    const rule = parseAdmRule(json)
    if (!rule || (!rule.articles.length && !rule.annexes.length && !rule.addenda.length)) {
      return {
        content: [{
          type: "text",
          text: `[NOT_FOUND] 행정규칙 전문을 조회할 수 없습니다 (id=${input.id}).\n\n` +
            `id에는 search_admin_rule 결과의 '행정규칙일련번호'(13자리)를 넘겨야 합니다. ` +
            `'행정규칙ID'(4~5자리)로는 조회되지 않습니다.\n` +
            `본문이 첨부파일로만 제공되는 행정규칙일 수도 있습니다.\n` +
            `⚠️ LLM은 행정규칙 내용을 추측/생성하지 마세요.`,
        }],
        isError: true,
      }
    }

    const max = Math.max(1000, input.maxChars ?? 40000)
    let out: Rendered
    switch (input.mode ?? "toc") {
      case "article": out = renderArticles(rule, input.id, input, max); break
      case "annex": out = renderAnnex(rule, input.id, input, max); break
      case "addendum": out = renderAddendum(rule, max); break
      default: out = renderToc(rule, input.id, max)
    }

    // 상한 로직이 이미 안내를 붙이므로 여기서는 안전망으로만 둔다
    return {
      content: [{ type: "text", text: truncateResponse(out.text, max + 500) }],
      isError: out.isError,
    }
  } catch (error) {
    return formatToolError(error, "read_admin_rule")
  }
}

/**
 * 조문 분할기 시험.
 *
 * 법제처 행정규칙 본문은 개행이 0개인 단일 문자열로 온다. 여기서 조문 경계를
 * 잘못 잡으면 목차가 오염되고 범위 조회가 엉뚱한 구간을 준다 — 이 도구의
 * 정확성이 전부 이 함수에 달려 있다. 실측한 세 가지 번호 체계와
 * 인용문 오탐을 고정한다.
 */
import { describe, it, expect } from "vitest"
import { splitArticles } from "./gqai-admin-rule.js"

describe("splitArticles — 번호 체계", () => {
  it("제N-M조 (편-조 체계: 금융투자업규정·외국환거래규정)", () => {
    const t = "제1-1조(목적) 가나다.<개정 2013. 9. 17.>제1-2조(정의) 라마바.제2-1조(적용) 사아자."
    const a = splitArticles(t)
    expect(a.map((x) => x.id)).toEqual(["제1-1조", "제1-2조", "제2-1조"])
    expect(a[0].title).toBe("목적")
    expect(a[1].text).toContain("라마바")
  })

  it("제N조 (평문 체계: 근로감독관집무규정)", () => {
    const t = "제1조(목적) 가나다.제2조(정의) 라마바.제3조(적용) 사아자."
    expect(splitArticles(t).map((x) => x.id)).toEqual(["제1조", "제2조", "제3조"])
  })

  it("제N조의M (가지번호)", () => {
    const t = "제7조(가) 본문.제7조의2(나) 본문.제8조(다) 본문."
    expect(splitArticles(t).map((x) => x.id)).toEqual(["제7조", "제7조의2", "제8조"])
  })
})

describe("splitArticles — 인용문 오탐", () => {
  it("본문에 섞인 다른 법령 인용을 조문 시작으로 오인하지 않는다", () => {
    // "법 제9조(정의)"는 인용이지 이 규칙의 조문이 아니다.
    // 번호가 앞 조문보다 작으므로 앞 조문에 흡수되어야 한다.
    const t = "제10-1조(가) 「자본시장법」 제9조(정의)에 따라 한다.제10-2조(나) 본문."
    const a = splitArticles(t)
    expect(a.map((x) => x.id)).toEqual(["제10-1조", "제10-2조"])
    expect(a[0].text).toContain("제9조(정의)") // 흡수되어 본문에 남아 있다
  })

  it("같은 번호가 다시 나와도 새 조문으로 세지 않는다", () => {
    const t = "제3조(가) 앞.제3조(가) 뒤 인용.제4조(나) 본문."
    expect(splitArticles(t).map((x) => x.id)).toEqual(["제3조", "제4조"])
  })
})

describe("splitArticles — 무결성", () => {
  it("본문을 빠짐없이 나눠 갖는다", () => {
    const t = "제1조(가) " + "가".repeat(100) + "제2조(나) " + "나".repeat(100) + "제3조(다) 끝"
    const a = splitArticles(t)
    // 앞머리가 없는 경우 조각 합계가 원문 길이와 같아야 한다(공백 trim 제외)
    const joined = a.map((x) => x.text).join("")
    expect(joined.replace(/\s/g, "")).toBe(t.replace(/\s/g, ""))
  })

  it("조문이 하나도 없으면 빈 배열", () => {
    expect(splitArticles("조문 형식이 아닌 안내문입니다.")).toEqual([])
    expect(splitArticles("")).toEqual([])
  })

  it("조문 번호가 중복되지 않는다", () => {
    const t = "제1-1조(가) A제1-2조(나) B제2-1조(다) C제2-2조(라) D"
    const ids = splitArticles(t).map((x) => x.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

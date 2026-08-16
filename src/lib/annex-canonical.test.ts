import { describe, it, expect } from "vitest"
import { findMissingUnits, parseLawAnnexUnits, pickAnnexUnit } from "./annex-canonical.js"

// #77 실증 응답 축소판: 각급 법원의 설치와 관할구역에 관한 법률 (MST 284429)
const FIXTURE = JSON.stringify({
  법령: {
    별표: {
      별표단위: [
        {
          별표번호: "0003",
          별표가지번호: "00",
          별표구분: "별표",
          별표제목: "고등법원ㆍ지방법원과 그 지원의 관할구역",
          별표서식파일링크: "/LSW/flDownload.do?flSeq=164115145",
          별표서식PDF파일링크: "/LSW/flDownload.do?flSeq=164115147",
          별표서식이미지파일링크: [
            "/LSW/flDownload.do?flSeq=164115149",
            "/LSW/flDownload.do?flSeq=164115151",
          ],
        },
        {
          별표번호: "0011",
          별표가지번호: "00",
          별표구분: "별표",
          별표제목: "해사국제상사법원의 관할구역",
          별표서식파일링크: "/LSW/flDownload.do?flSeq=164115203",
          별표서식PDF파일링크: "/LSW/flDownload.do?flSeq=164115205",
        },
      ],
    },
  },
})

describe("parseLawAnnexUnits — lawService 별표단위 파싱", () => {
  it("별표번호+가지번호 → 6자리 code6, HWP/PDF 링크 추출", () => {
    const units = parseLawAnnexUnits(FIXTURE)
    expect(units).toHaveLength(2)
    expect(units[0]).toMatchObject({
      code6: "000300",
      kind: "별표",
      hwpLink: "/LSW/flDownload.do?flSeq=164115145",
      pdfLink: "/LSW/flDownload.do?flSeq=164115147",
    })
    expect(units[1].code6).toBe("001100")
  })

  it("단일 객체 응답(배열 아님)도 정규화", () => {
    const single = JSON.stringify({
      법령: { 별표: { 별표단위: { 별표번호: "0001", 별표가지번호: "02", 별표구분: "서식", 별표제목: "x", 별표서식파일링크: "/a" } } },
    })
    const units = parseLawAnnexUnits(single)
    expect(units).toHaveLength(1)
    expect(units[0].code6).toBe("000102")
  })

  it("링크 필드가 배열이면 첫 값 사용", () => {
    const arr = JSON.stringify({
      법령: { 별표: { 별표단위: [{ 별표번호: "0002", 별표가지번호: "00", 별표구분: "별표", 별표제목: "y", 별표서식파일링크: ["/one", "/two"] }] } },
    })
    expect(parseLawAnnexUnits(arr)[0].hwpLink).toBe("/one")
  })

  it("링크 없는 단위·잘못된 JSON·별표 없는 법령은 빈 배열", () => {
    expect(parseLawAnnexUnits(JSON.stringify({ 법령: { 별표: { 별표단위: [{ 별표번호: "0001", 별표가지번호: "00", 별표구분: "별표", 별표제목: "무링크" }] } } }))).toHaveLength(0)
    expect(parseLawAnnexUnits("not-json")).toHaveLength(0)
    expect(parseLawAnnexUnits(JSON.stringify({ 법령: {} }))).toHaveLength(0)
  })
})

describe("pickAnnexUnit — 후보 선택", () => {
  const units = parseLawAnnexUnits(FIXTURE)

  it("licbyl 매칭 항목의 별표번호(code6)로 정본 단위 선택", () => {
    expect(pickAnnexUnit(units, { code6: "000300" })?.hwpLink).toContain("164115145")
  })

  it("licbyl 목록에 없는 별표(별표11)를 selector 후보로 선택", () => {
    const cands = new Set(["11", "001100"])
    expect(pickAnnexUnit(units, { selectorCandidates: cands })?.title).toContain("해사국제상사")
  })

  it("매칭 없으면 undefined", () => {
    expect(pickAnnexUnit(units, { code6: "999900" })).toBeUndefined()
    expect(pickAnnexUnit(units, {})).toBeUndefined()
  })

  it("findMissingUnits — licbyl 목록에 없는 신설 별표만 반환 (번호+구분 일치 시 기등재)", () => {
    const units = parseLawAnnexUnits(FIXTURE) // 000300 별표, 001100 별표
    const licbylList = [{ 별표번호: "000300", 별표종류: "별표" }]
    const missing = findMissingUnits(licbylList, units)
    expect(missing).toHaveLength(1)
    expect(missing[0].code6).toBe("001100")
    // 번호 같아도 구분이 다르면(서식) 누락으로 판단
    expect(findMissingUnits([{ 별표번호: "000300", 별표종류: "서식" }], units)).toHaveLength(2)
  })

  it("같은 번호에 별표/서식 공존 시 kind·knd로 구분", () => {
    const mixed = [
      { code6: "000400", kind: "서식", title: "관리대장", hwpLink: "/form" },
      { code6: "000400", kind: "별표", title: "공지기준", hwpLink: "/table" },
    ]
    expect(pickAnnexUnit(mixed, { code6: "000400" })?.hwpLink).toBe("/table")
    expect(pickAnnexUnit(mixed, { code6: "000400", knd: "2" })?.hwpLink).toBe("/form")
    expect(pickAnnexUnit(mixed, { code6: "000400", kind: "서식" })?.hwpLink).toBe("/form")
  })
})

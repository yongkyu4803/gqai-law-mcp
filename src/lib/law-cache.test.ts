import { describe, it, expect } from "vitest"
import { cacheKey, isCacheable, ttlFor } from "./law-cache.js"

const BASE = "https://www.law.go.kr/DRF/lawSearch.do"

describe("cacheKey", () => {
  it("인증키가 달라도 같은 조회는 같은 키가 된다", () => {
    // 키별로 캐시가 쪼개지면 공용 키 사용자와 자체 키 사용자가 서로의 캐시를
    // 못 쓰게 되어 적중률이 반토막 난다 — 쿼터 보호 효과가 그만큼 준다.
    const a = cacheKey(`${BASE}?OC=alice&target=law&query=민법`)
    const b = cacheKey(`${BASE}?OC=bob&target=law&query=민법`)
    expect(a).toBe(b)
  })

  it("파라미터 순서가 달라도 같은 키가 된다", () => {
    const a = cacheKey(`${BASE}?target=law&query=민법&OC=x`)
    const b = cacheKey(`${BASE}?query=민법&OC=x&target=law`)
    expect(a).toBe(b)
  })

  it("조회 내용이 다르면 키가 갈린다", () => {
    expect(cacheKey(`${BASE}?OC=x&query=민법`)).not.toBe(cacheKey(`${BASE}?OC=x&query=상법`))
  })

  it("키 문자열에 인증키가 남지 않는다", () => {
    // 저장소에 OC를 남기지 않는다는 원칙(계획서 비밀정보 운영 원칙)의 회귀 방어
    const key = cacheKey(`${BASE}?OC=super-secret-oc&query=민법`)
    expect(key).not.toContain("super-secret-oc")
  })
})

describe("isCacheable", () => {
  it("정상 JSON/XML 응답은 캐시한다", () => {
    expect(isCacheable('{"LawSearch":{"totalCnt":"1"}}')).toBe(true)
    expect(isCacheable("<?xml version='1.0'?><LawSearch/>")).toBe(true)
  })

  it("법제처 인증 실패 응답은 캐시하지 않는다", () => {
    // 이걸 캐시하면 OC·도메인 등록을 고친 뒤에도 TTL 내내 실패가 재생되어
    // 장애가 스스로 연장된다. 캐시 계층에서 가장 위험한 오작동이다.
    const authFail = "<Law><resultMsg>사용자 정보 검증에 실패하였습니다. 정확한 서버장비의 IP주소 및 도메인주소를 등록해 주세요.</resultMsg></Law>"
    expect(isCacheable(authFail)).toBe(false)
  })

  it("빈 본문과 HTML 점검 페이지는 캐시하지 않는다", () => {
    expect(isCacheable("")).toBe(false)
    expect(isCacheable("   ")).toBe(false)
    expect(isCacheable("<!DOCTYPE html><html><body>점검중</body></html>")).toBe(false)
    expect(isCacheable("<html><body>error</body></html>")).toBe(false)
  })

  it("상한을 넘는 큰 응답은 캐시하지 않는다", () => {
    // 상한은 2MB. 행정규칙 전문이 1.6MB급이라(금융투자업규정 실측) 그보다
    // 낮게 잡으면 가장 무거운 문서가 매번 법제처를 새로 부르게 된다 —
    // 캐시가 필요한 순서와 정반대가 되므로 여유를 두고 잡았다.
    expect(isCacheable("{" + "x".repeat(1_600_000) + "}")).toBe(true)
    expect(isCacheable("{" + "x".repeat(2_200_000) + "}")).toBe(false)
  })
})

describe("ttlFor", () => {
  it("본문 조회는 검색보다 길게 잡는다", () => {
    // 조문 전문은 개정 전까지 불변, 검색 결과는 신규 제·개정 반영이 필요하다
    expect(ttlFor(`https://www.law.go.kr/DRF/lawService.do?MST=1`)).toBeGreaterThan(
      ttlFor(`https://www.law.go.kr/DRF/lawSearch.do?query=민법`)
    )
  })
})

import { describe, it, expect } from "vitest"
import {
  lawNameCandidates,
  looseMatchLawName,
  extractLawName,
  resolveLawAnaphora,
  parseCitations,
} from "./verify-citations.js"

describe("extractLawName — 인용 직전 문맥에서 법령명 추출", () => {
  // 회귀: 「법령명」 제N조 는 법제처·판결문·실무 문서의 표준 표기인데, 닫는 낫표가
  // LAW_NAME_REGEX의 $ 앵커를 막아 법령명이 전혀 추출되지 않았다. 그 결과 조문 실존
  // 검증에 진입하지 못해 없는 조문·없는 항조차 ✗로 잡히지 않았다(환각 탐지 미가동).
  it("낫표로 감싼 표준 표기에서 법령명을 추출한다", () => {
    expect(extractLawName("「식품 등의 표시·광고에 관한 법률」 ")).toBe("식품 등의 표시·광고에 관한 법률")
    expect(extractLawName("이 사건에는 「형법」")).toBe("형법")
    expect(extractLawName("『민법』")).toBe("민법")
  })

  it("낫표 없는 평문은 종전대로 추출 (#55 동작 유지)", () => {
    expect(extractLawName("절도죄는 형법")).toBe("절도죄는 형법")
    expect(extractLawName("전자상거래 등에서의 소비자보호에 관한 법률")).toBe(
      "전자상거래 등에서의 소비자보호에 관한 법률"
    )
  })

  it("접속사·부사 수식어는 제거", () => {
    expect(extractLawName("또한 상법")).toBe("상법")
  })

  it("법령명이 없으면 undefined", () => {
    expect(extractLawName("계약서에 따라")).toBeUndefined()
    expect(extractLawName("")).toBeUndefined()
  })
})

describe("lawNameCandidates", () => {
  it("법령명 직전 캡처(수식어 없음)는 후보 1개", () => {
    expect(lawNameCandidates("형법")).toEqual(["형법"])
  })

  it("앞 수식어가 붙으면 전체→축약 순으로 후보 생성 (#55)", () => {
    expect(lawNameCandidates("절도죄는 형법")).toEqual(["절도죄는 형법", "형법"])
    expect(lawNameCandidates("이혼시 재산분할은 민법")).toEqual([
      "이혼시 재산분할은 민법",
      "재산분할은 민법",
      "민법",
    ])
  })

  it("다어절 법령명은 전체 후보가 먼저 와서 보존된다", () => {
    const cands = lawNameCandidates("전자상거래 등에서의 소비자보호에 관한 법률")
    expect(cands[0]).toBe("전자상거래 등에서의 소비자보호에 관한 법률")
  })

  it("2자 미만 후보는 제외", () => {
    // 마지막 어절이 1자면 후보에서 빠지고, 유효 후보가 없으면 원문 유지
    expect(lawNameCandidates("가 나")).toEqual(["가 나"])
  })

  // 회귀(#70): 앞 어절을 다 떼면 "시행규칙"·"법 시행규칙" 처럼 접미사만 남는 후보가 생기는데,
  // 이것들은 그 자체로 법령명이 될 수 없고 검색에 넣으면 무관한 법령을 물어온다
  // (관측: "시행규칙" → '119긴급신고의 관리 및 운영에 관한 법률 시행규칙').
  it("접미사뿐인 후보는 만들지 않는다", () => {
    expect(lawNameCandidates("같은 법 시행규칙")).toEqual(["같은 법 시행규칙"])
    expect(lawNameCandidates("노인장기요양보험법 시행규칙")).toEqual(["노인장기요양보험법 시행규칙"])
    expect(lawNameCandidates("전자상거래 등에서의 소비자보호에 관한 법률")).not.toContain("법률")
  })

  it("캡처가 접미사뿐이면 후보 없음 — 모른다고 하는 게 무관 법령보다 낫다", () => {
    expect(lawNameCandidates("시행규칙")).toEqual([])
    expect(lawNameCandidates("법 시행규칙")).toEqual([])
    expect(lawNameCandidates("법률")).toEqual([])
  })
})

describe("resolveLawAnaphora — '같은 법'·'동법' 조응 해소 (#70)", () => {
  it("선행 법령명을 승계하고 접미사를 붙인다", () => {
    expect(resolveLawAnaphora("같은 법 시행규칙", "노인장기요양보험법")).toBe(
      "노인장기요양보험법 시행규칙"
    )
    expect(resolveLawAnaphora("동법 시행령", "관세법")).toBe("관세법 시행령")
    expect(resolveLawAnaphora("같은 법", "형법")).toBe("형법")
    expect(resolveLawAnaphora("같은 법률", "상법")).toBe("상법")
  })

  it("선행 법령명이 시행령·시행규칙이면 모법으로 되돌린 뒤 붙인다", () => {
    expect(resolveLawAnaphora("같은 법 시행규칙", "노인장기요양보험법 시행령")).toBe(
      "노인장기요양보험법 시행규칙"
    )
  })

  it("선행 법령명이 없으면 해소 불가 — 법령명 미상이 정직한 답", () => {
    expect(resolveLawAnaphora("같은 법 시행규칙", undefined)).toBeUndefined()
  })

  it("조응이 아닌 법령명은 그대로 통과 ('노동법'처럼 '동'으로 시작해도 건드리지 않음)", () => {
    expect(resolveLawAnaphora("형법", "민법")).toBe("형법")
    expect(resolveLawAnaphora("노동법", "민법")).toBe("노동법")
    expect(resolveLawAnaphora("협동조합기본법", undefined)).toBe("협동조합기본법")
  })
})

describe("parseCitations — 조응 인용의 법령명 승계 (#70)", () => {
  it("「A법」 제N조 및 같은 법 시행규칙 제M조 를 둘 다 해소한다", () => {
    const cites = parseCitations(
      "「노인장기요양보험법」 제38조제1항 및 같은 법 시행규칙 제30조에 따라 장기요양급여비용을 청구합니다.",
      15
    )
    expect(cites.map((c) => c.lawName)).toEqual([
      "노인장기요양보험법",
      "노인장기요양보험법 시행규칙",
    ])
  })

  it("문단이 바뀌면 승계하지 않는다 — 무관 법령을 근거로 판정하는 게 더 나쁘다", () => {
    const cites = parseCitations("「형법」 제250조\n\n같은 법 시행령 제3조", 15)
    expect(cites[0].lawName).toBe("형법")
    expect(cites[1].lawName).toBeUndefined()
  })

  it("선행 법령명 없이 '같은 법'만 있으면 법령명 미상", () => {
    const cites = parseCitations("같은 법 시행규칙 제30조에 따라 청구한다.", 15)
    expect(cites[0].lawName).toBeUndefined()
  })
})

describe("looseMatchLawName", () => {
  it("공백 무시 완전 일치", () => {
    expect(looseMatchLawName("형법", "형법")).toBe(true)
  })

  it("공식 법령명이 후보로 시작하면 매칭 (약칭)", () => {
    expect(looseMatchLawName("개인정보", "개인정보 보호법")).toBe(true)
  })

  it("법률/법 접미 정규화로 매칭", () => {
    expect(looseMatchLawName("국가공무원법", "국가공무원법")).toBe(true)
  })

  it("수식어가 남은 후보는 매칭 실패 (조문검증 저하 방지 대상)", () => {
    expect(looseMatchLawName("절도죄는 형법", "형법")).toBe(false)
  })

  it("전혀 다른 법령은 매칭 실패", () => {
    expect(looseMatchLawName("형법", "민법")).toBe(false)
  })
})

describe("법령명 추출 — 가운뎃점 변형 (#75 후속)", () => {
  // looseMatch 정규화는 5종을 흡수하는데 추출 정규식이 2종만 통과시켜, U+2027 등으로
  // 표기된 법령명이 '광고에 관한 법률'로 절단 추출돼 조문 검증에 진입조차 못 했다.
  const 표기 = { "U+00B7": "·", "U+318D": "ㆍ", "U+2027": "‧", "U+2022": "•", "U+30FB": "・" }
  for (const [name, ch] of Object.entries(표기)) {
    it(`${name} 표기의 법령명을 온전히 추출한다`, () => {
      const cites = parseCitations(`「식품 등의 표시${ch}광고에 관한 법률」 제8조에 따라`, 15)
      expect(cites[0].lawName).toBe(`식품 등의 표시${ch}광고에 관한 법률`)
    })
  }
})

describe("'같은 법' 조응 — 문단 경계 이후", () => {
  // 경계로 승계가 거부돼도 antecedent를 남겨두면, 같은 단락의 두 번째 조응부터는
  // 검사 구간(직전 인용~현재)에 빈 줄이 없어 이전 문단의 법령명을 물려받았다.
  // 그 결과 '형법 시행령'(비실존)이 만들어져 ✗ 환각으로 오탐된다.
  it("문단이 바뀐 뒤 연속된 조응 모두 승계하지 않는다", () => {
    const cites = parseCitations(
      "「형법」 제250조에 따른다.\n\n같은 법 시행령 제3조와 같은 법 시행령 제4조를 본다.",
      15
    )
    expect(cites[0].lawName).toBe("형법")
    expect(cites[1].lawName).toBeUndefined()
    expect(cites[2].lawName).toBeUndefined()
  })

  it("같은 문단 안에서는 종전대로 승계한다", () => {
    const cites = parseCitations("「형법」 제250조와 같은 법 제251조를 본다.", 15)
    expect(cites[0].lawName).toBe("형법")
    expect(cites[1].lawName).toBe("형법")
  })
})

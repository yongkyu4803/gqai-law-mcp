# GQAI 법령조회 MCP

법제처 국가법령정보 OPEN API 기반 원격 MCP 서버. 사용자가 인증키를 발급받지 않고도
`https://law.gqai.kr/mcp`에 연결해 법령·판례·행정규칙·자치법규를 조회한다.

- **기반**: [chrisryugj/korean-law-mcp](https://github.com/chrisryugj/korean-law-mcp) v4.10.0 포크 (MIT)
- **실행**: Vercel Node.js Function, 서울 리전(icn1), Stateless Streamable HTTP

> 소스 주석과 아래 문서에 나오는 "계획서 N절"은 이 저장소에 포함하지 않은
> 내부 구축 계획서(v1.1)를 가리킨다. 설계 판단의 근거는 각 파일 상단 주석과
> 이 README의 [방어 구조](#방어-구조) 절에 그대로 옮겨 두었으므로,
> 계획서 없이도 코드를 읽는 데 지장이 없다.

---

## 저장소 구조

upstream **소스 파일은 한 줄도 수정하지 않았다.** GQAI 기능은 전부 새 파일로 얹혀 있어
월 1회 upstream 병합 시 `src/`에서 충돌이 나지 않는다.
교체한 것은 프로젝트 설정 파일뿐이다 — `package.json`, `.gitignore`, `.env.example`.

| 경로 | 소유 | 역할 |
|---|---|---|
| `src/` (아래 목록 제외) | upstream | 도구 정의, 법제처 클라이언트, 파서 |
| `src/lib/law-cache.ts` | GQAI | 법제처 응답 캐시 (전역 `fetch` 인터셉트) |
| `src/lib/global-rate-limit.ts` | GQAI | Redis 전역 토큰버킷 + 일일 캡 |
| `src/lib/kv-store.ts` | GQAI | Upstash Redis REST 클라이언트 |
| `src/lib/synthetic.ts` | GQAI | 출구 IP 안정성 감시 |
| `src/server/http-server.ts` | upstream | 로컬·Fly 배포용 (Vercel에서 미사용) |
| `src/server/vercel-app.ts` | GQAI | `listen` 없는 Express 앱 |
| `api/index.ts` | GQAI | Vercel Function 엔트리포인트 |
| `api/synthetic.ts` | GQAI | Cron 감시 엔드포인트 |
| `public/index.html` | GQAI | 공개 안내 페이지 |
| `scripts/` | GQAI | 수용 시험·운영 확인·로컬 기동 |

---

## 방어 구조

공용 서버 키 하나를 불특정 다수가 공유하므로, 쿼터 소진과 비용 폭주를 세 겹으로 막는다.

```
요청 → [Vercel WAF·Spend 한도] → [응답 캐시] → [전역 한도] → 법제처
              비용 방어            1차 방어      2차 방어
```

**캐시가 1차인 이유**: 한도 제한은 쿼터가 소진되는 *속도*만 늦추지만, 캐시는 법제처
호출 *자체*를 없앤다. 법령 조문은 개정 전까지 불변이고 트래픽이 인기 법령에 쏠리므로
실효 방어는 캐시 쪽이다.

**IP별 제한을 총량 보호에 쓰지 않는 이유**: 원격 MCP 클라이언트(claude.ai 커넥터 등)
트래픽은 최종 사용자 IP가 아니라 클라이언트 운영사의 소수 egress IP로 도달한다.
IP는 사용자 식별 수단이 될 수 없어 봇 방어 수준으로만 운용하고, 총량은 전역 한도가 맡는다.

**저장소 장애 시**: 인메모리 한도로 degrade하되 인스턴스 수를 가정해 한도를 나눠 잡는다
(`KV_FALLBACK_DIVISOR`). fail-open은 쿼터 무방비, fail-closed는 전체 중단이라 어느 쪽도
쓰지 않는다. degrade 상태는 `/health`의 `limiter.degradedCount`로 관측한다.

---

## 로컬 개발

```bash
npm install              # 로컬은 전체 설치 (--omit=optional 쓰지 말 것)
npm run build
node scripts/local-server.mjs 8000
```

`scripts/local-server.mjs`는 **Vercel에 배포되는 것과 같은 앱**을 띄운다.
upstream의 `npm start`(http-server.ts)는 Vercel용 경로(캐시·Redis 한도·Host 검증)를
전혀 타지 않으므로 배포 전 검증에는 쓰지 않는다.

### 시험

```bash
npm test                                    # 단위 시험 186건
node scripts/smoke-test.mjs http://127.0.0.1:8000   # 수용 기준 (계획서 7장)
```

`LAW_OC`가 없으면 법제처 실호출 항목은 자동으로 skip된다.

---

## 배포

### 1. Vercel 프로젝트 연결

```bash
vercel link
```

빌드 설정은 `vercel.json`이 전부 담고 있다(리전 icn1, maxDuration, Cron, rewrite).

### 2. 환경변수 등록

[`.env.example`](./.env.example)이 전체 목록과 각 값의 의미를 담고 있다.
Preview와 Production에 각각 등록하며, **값은 Vercel Secret에만 저장한다.**

최소 필수: `LAW_OC`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`,
`CRON_SECRET`, `FALLBACK_DAILY_CAP`

### 3. 배포 후 검증

```bash
node scripts/smoke-test.mjs https://<preview-url>    # 관문 A·B·D
node scripts/synthetic-check.mjs https://<preview-url> --run   # 감시 1회 실행
```

### 4. Vercel 콘솔에서 추가 설정

`vercel.json`으로 표현할 수 없어 콘솔에서 직접 해야 하는 것들:

- **Spend Management**: 지출 한도와 알림 임계값 (429를 반환해도 Function 호출 비용은 발생한다)
- **Firewall/WAF**: 허용 경로·메서드 외 트래픽 차단
- **Log Drain 또는 알림**: 오류율 급증·synthetic 연속 실패 수신 채널

---

## 운영

### 일일 확인 (공개 후 첫 7일)

```bash
node scripts/synthetic-check.mjs https://law.gqai.kr
```

캐시 적중률, 한도 백엔드 상태, synthetic 실패율을 한 화면에 요약한다.
`/health`가 같은 정보를 JSON으로 준다.

### 고정 IP 필요 여부 판단 (관문 A)

Vercel 출구 IP는 동적 풀에서 배정되므로 배포 직후 연속 성공만으로는 안정성을 확정할 수 없다.
`/api/synthetic`이 매시간 캐시를 우회해 법제처를 실호출하고 결과를 누적한다.
**1~2주간 실패율이 임계(기본 2%) 아래로 유지되면 고정 IP 불필요로 확정**하고,
초과하면 대체 인프라(Fly.io/VPS) 또는 Vercel Static IP를 검토한다.

감시가 캐시를 우회하는 것이 핵심이다. 캐시를 타면 법제처가 완전히 끊긴 상태에서도
저장된 응답이 돌아와 계속 "정상"으로 보고된다.

### 장애 대응

1. `/health`와 MCP `initialize`를 분리 확인
2. `/health`의 `synthetic.lastFail`에서 실패 유형 확인
   - `인증 실패` → OC 상태, 법제처 도메인 등록, Referer 확인
   - `HTML 페이지 반환` → 안티봇 또는 법제처 점검
   - `HTTP 5xx` → 법제처 장애
3. 최근 배포를 이전 정상 버전으로 Promote
4. 키 유출 의심 시 법제처에서 OC 변경 후 재배포
5. 출구 문제가 지속되면 `law.gqai.kr` DNS를 대체 인프라로 변경
   (DNS TTL을 평시 300초 이하로 유지해 전환 시간을 줄여둔다)

캐시가 장애를 가리거나 연장한다고 판단되면 `CACHE_DISABLED=1`로 즉시 끌 수 있다.

---

## upstream 병합 (월 1회)

```bash
git fetch upstream
git log --oneline HEAD..upstream/main       # 변경 내역 확인
git merge upstream/main
npm install && npm run build && npm test
node scripts/smoke-test.mjs http://127.0.0.1:8000
```

GQAI 파일은 upstream에 존재하지 않으므로 충돌은 `package.json`,
`.gitignore`, `.env.example` 정도에서만 발생한다.

`src/server/http-server.ts`가 바뀌었다면 `src/server/vercel-app.ts`에
반영할 보안 변경이 있는지 **반드시 diff를 대조한다.** 두 파일은 같은 뿌리에서 갈라졌다.

---

## 알려진 트레이드오프

**이미지 기반 PDF의 OCR을 지원하지 않는다.**

`kordoc`의 선택적 의존성인 `onnxruntime-node`(131MB) + `@huggingface/transformers` +
`sharp`가 Function 번들로 딸려 들어와, 법령 조회 서비스에 ML 런타임 150MB가
얹히는 상태였다. 배포 시 `--omit=optional`로 제외해 **번들을 166.5MB → 10.8MB로 줄였다.**

영향은 이미지 기반 PDF 별표의 텍스트 추출뿐이며, 이 경우 upstream 코드가 이미
다운로드 링크를 안내하는 경로로 degrade한다. 일반 HWPX/HWP5/PDF 텍스트 별표는
정상 동작한다. 계획서 3.2절 경량 프로필의 1순위 제외 대상과 일치한다.

로컬 개발에서는 `npm install`(전체)을 쓴다. `--omit=optional`은 vitest의 네이티브
바인딩까지 제거해 시험이 돌지 않는다. 배포 설치만 `npm ci --omit=optional`이다.

**설치 복원력**: Vercel 첫 빌드는 npm 캐시가 비어 132MB를 전량 내려받고, 그중
`pdfjs-dist` 하나가 40MB다. 레지스트리 연결이 끊기면(ECONNRESET) 기본 재시도로는
복구되지 않아 설치가 통째로 실패하므로, `.npmrc`에서 재시도 횟수·백오프 상한을 늘리고
불필요한 레지스트리 왕복(audit·fund)을 껐다. `npm install` 대신 `npm ci`를 쓰는 것도
같은 이유다 — 락파일대로만 받아 메타데이터 재해석 왕복이 없다.

---

## 라이선스 및 출처

- 코드: MIT ([LICENSE](./LICENSE)), 원저작자 고지는 [NOTICE](./NOTICE) 유지
- 데이터: 법제처 국가법령정보센터 OPEN API — 조회 결과는 참고용이며,
  법적 효력이 필요한 판단은 [국가법령정보센터](https://www.law.go.kr/) 원문을 확인해야 한다.

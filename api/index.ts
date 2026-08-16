/**
 * Vercel Function 엔트리포인트
 *
 * 빌드된 산출물(build/)을 가져다 쓴다. src/를 직접 import하지 않는 이유는
 * upstream 코드가 ESM 관례대로 `./foo.js` 확장자로 서로를 참조하는데, 이를
 * 번들러의 확장자 치환 동작에 맡기면 100개가 넘는 파일 중 하나만 어긋나도
 * 배포 시점에야 깨지기 때문이다. tsc로 먼저 컴파일해 실제 .js를 만든 뒤
 * 참조하면 해석 경로가 하나로 고정된다.
 *
 * 라우팅: vercel.json의 rewrite가 모든 경로를 이 함수로 보내고,
 * 원래 경로(/mcp, /health)는 보존되므로 Express 라우터가 그대로 처리한다.
 */

import app from "../build/server/vercel-app.js"

export default app

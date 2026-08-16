/**
 * [GQAI 추가] upstream 도구 목록에 GQAI 도구를 얹는 등록 계층
 *
 * 왜 이렇게 하는가:
 *   upstream의 registerTools()는 ListTools·CallTool 핸들러를 서버에 직접 등록한다.
 *   MCP SDK는 같은 스키마로 다시 등록하면 앞의 핸들러를 대체하므로, 단순히
 *   "우리 것도 추가 등록"하면 upstream 도구 전체가 사라진다.
 *
 *   tool-registry.ts를 고치면 간단하지만, 그러면 upstream 소스를 수정하게 되어
 *   월 1회 병합에서 충돌이 난다(지금까지 src/ 수정 0을 유지해 왔다). 그래서
 *   등록 시점에 setRequestHandler를 잠시 가로채 upstream 핸들러를 손에 쥐고,
 *   GQAI 도구를 먼저 살펴본 뒤 나머지는 그대로 위임하는 합성 핸들러를 만든다.
 *
 *   결과적으로 upstream 파일은 그대로 두면서 도구만 늘어난다.
 */

import { z } from "zod"
import type { Server } from "@modelcontextprotocol/sdk/server/index.js"
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js"
import type { LawApiClient } from "./api-client.js"
import { registerTools } from "../tool-registry.js"
import { ReadAdminRuleSchema, readAdminRule } from "../tools/gqai-admin-rule.js"

interface GqaiTool {
  name: string
  description: string
  schema: z.ZodType
  handler: (client: LawApiClient, input: any) => Promise<{
    content: Array<{ type: string; text: string }>
    isError?: boolean
  }>
}

const SERVICE_NAME = "Korean-law-mcp"

/** GQAI가 추가한 도구들 */
const GQAI_TOOLS: GqaiTool[] = [
  {
    name: "read_admin_rule",
    description:
      "[행정규칙 부분조회] 긴 행정규칙을 목차·조문범위·별표·부칙으로 나눠 읽는다. " +
      "get_admin_rule은 전문을 5만자에서 자르므로 금융투자업규정처럼 큰 규칙은 " +
      "뒷부분과 별표·부칙에 아예 도달하지 못한다. 먼저 mode='toc'로 목차를 보고 " +
      "필요한 조문을 jo로 지정할 것. 위임행정규칙 조문 확인(4단 비교) 용도.",
    schema: ReadAdminRuleSchema,
    handler: readAdminRule as GqaiTool["handler"],
  },
]

/** upstream의 toMcpInputSchema와 같은 규칙 — apiKey는 광고 스키마에서 숨긴다 */
function toMcpInputSchema(schema: z.ZodType) {
  const raw = z.toJSONSchema(schema, { io: "input" }) as any
  if (raw?.type === "object" && raw?.properties) {
    const props = { ...raw.properties }
    delete props.apiKey
    return {
      type: "object",
      properties: props,
      required: Array.isArray(raw.required) ? raw.required.filter((k: string) => k !== "apiKey") : [],
      additionalProperties: raw.additionalProperties ?? false,
    }
  }
  return raw
}

type Handler = (request: any, extra: any) => Promise<any>

/**
 * upstream 도구 + GQAI 도구를 함께 등록한다.
 * upstream 도구의 동작은 그대로 통과시키고, GQAI 도구 이름일 때만 가로챈다.
 */
export function registerAllTools(server: Server, apiClient: LawApiClient): void {
  // 1) upstream이 등록하려는 핸들러를 실제 등록 대신 붙잡아 둔다
  const captured = new Map<unknown, Handler>()
  const realSet = server.setRequestHandler.bind(server)
  ;(server as any).setRequestHandler = (schema: unknown, handler: Handler) => {
    captured.set(schema, handler)
  }
  registerTools(server, apiClient)
  ;(server as any).setRequestHandler = realSet

  const upstreamList = captured.get(ListToolsRequestSchema)
  const upstreamCall = captured.get(CallToolRequestSchema)

  // upstream 구조가 바뀌어 핸들러를 못 잡았다면 조용히 도구를 잃는 대신 즉시 드러낸다
  if (!upstreamList || !upstreamCall) {
    throw new Error(
      "[gqai-tools] upstream registerTools의 핸들러를 가로채지 못했습니다. " +
      "tool-registry.ts의 등록 방식이 바뀌었는지 확인하세요."
    )
  }

  // 2) 목록: upstream 도구 뒤에 GQAI 도구를 덧붙인다
  realSet(ListToolsRequestSchema, async (request: any, extra: any) => {
    const base = await upstreamList(request, extra)
    return {
      ...base,
      tools: [
        ...(base?.tools ?? []),
        ...GQAI_TOOLS.map((t) => ({
          name: t.name,
          description: `${SERVICE_NAME} — ${t.description}`,
          inputSchema: toMcpInputSchema(t.schema),
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true,
          },
        })),
      ],
    }
  })

  // 3) 실행: GQAI 도구면 우리가 처리, 아니면 upstream에 그대로 위임
  realSet(CallToolRequestSchema, async (request: any, extra: any) => {
    const tool = GQAI_TOOLS.find((t) => t.name === request?.params?.name)
    if (!tool) return upstreamCall(request, extra)

    try {
      const input = tool.schema.parse(request.params.arguments ?? {})
      const result = await tool.handler(apiClient, input)
      return {
        content: result.content.map((c) => ({ type: "text" as const, text: c.text })),
        isError: result.isError,
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      return {
        content: [{ type: "text" as const, text: `[INVALID_PARAMETER] ${tool.name}: ${msg}` }],
        isError: true,
      }
    }
  })
}

/** 헬스체크 표기용 */
export const GQAI_TOOL_COUNT = GQAI_TOOLS.length

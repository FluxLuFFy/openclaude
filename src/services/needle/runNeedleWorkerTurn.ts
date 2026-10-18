import { randomUUID } from 'node:crypto'
import type { ToolUseBlock } from '@anthropic-ai/sdk/resources/index.mjs'
import { createAssistantMessage } from '../../utils/messages/factories.js'
import { normalizeMessagesForAPI } from '../../utils/messages.js'
import { runToolUse } from '../tools/toolExecution.js'
import type { AssistantMessage, Message, RequestStartEvent, StreamEvent, TombstoneMessage, ToolUseSummaryMessage } from '../../types/message.js'
import type { Terminal } from '../../query/transitions.js'
import { zodToJsonSchema } from '../../utils/zodToJsonSchema.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { ToolUseContext, Tools } from '../../Tool.js'
import { buildNeedleToolPayload, NeedleClient } from './needleClient.js'
import { registerCleanup } from '../../utils/cleanupRegistry.js'
import { query, type QueryParams } from '../../query.js'

const needleClients = new WeakMap<ToolUseContext, NeedleClient>()
const activeNeedleClients = new Set<NeedleClient>()
registerCleanup(() => {
  for (const client of activeNeedleClients) client.close()
  activeNeedleClients.clear()
})

function getNeedleClient(context: ToolUseContext): NeedleClient {
  const existing = needleClients.get(context)
  if (existing) return existing
  const client = new NeedleClient()
  needleClients.set(context, client)
  activeNeedleClients.add(client)
  return client
}

export function closeNeedleClient(context: ToolUseContext): void {
  const client = needleClients.get(context)
  if (!client) return
  client.close()
  needleClients.delete(context)
  activeNeedleClients.delete(client)
}

export async function* runNeedleWorkerTurn({
  prompt,
  queryParams,
  tools,
  toolUseContext,
  canUseTool,
  signal,
  client,
  continueQuery = query,
}: {
  prompt: string
  queryParams: QueryParams
  tools: Tools
  toolUseContext: ToolUseContext
  canUseTool: CanUseToolFn
  signal?: AbortSignal
  client?: Pick<NeedleClient, 'complete' | 'close'>
  continueQuery?: typeof query
}): AsyncGenerator<StreamEvent | RequestStartEvent | Message | TombstoneMessage | ToolUseSummaryMessage, Terminal> {
  const needleClient = client ?? getNeedleClient(toolUseContext)
  try {
    let context = toolUseContext
    const executableTools = tools.filter(tool => tool.isEnabled())
    const needleTools = await Promise.all(executableTools.map(async tool => ({
      name: tool.name,
      description: await tool.description({}, {
        isNonInteractiveSession: context.options.isNonInteractiveSession ?? false,
        toolPermissionContext: context.getAppState().toolPermissionContext,
        tools: executableTools,
      }),
      input_schema: tool.inputJSONSchema ?? zodToJsonSchema(tool.inputSchema),
    })))
    let response
    try {
      response = await needleClient.complete({ prompt, tools: buildNeedleToolPayload(needleTools), signal })
    } catch {
      return yield* continueQuery({ ...queryParams, toolUseContext: context })
    }
    if (response.functionCalls.length !== 1) {
      return yield* continueQuery({ ...queryParams, toolUseContext: context })
    }

    const call = response.functionCalls[0]!
    const toolUse = {
      type: 'tool_use' as const,
      id: `toolu_needle_${randomUUID()}`,
      name: call.name,
      input: call.arguments,
      caller: { type: 'direct' as const },
    } satisfies ToolUseBlock
    const assistantMessage = createAssistantMessage({ content: [toolUse] }) as AssistantMessage
    context.setInProgressToolUseIDs(prev => new Set(prev).add(toolUse.id))
    yield assistantMessage

    const resultMessages: Message[] = []
    try {
      for await (const update of runToolUse(toolUse, assistantMessage, canUseTool, context)) {
        if (update.contextModifier) context = update.contextModifier.modifyContext(context)
        yield update.message
        if (update.message.type === 'user') resultMessages.push(update.message)
      }
    } finally {
      context.setInProgressToolUseIDs(prev => {
        const next = new Set(prev)
        next.delete(toolUse.id)
        return next
      })
    }

    const normalizedResults = normalizeMessagesForAPI(resultMessages, executableTools)
      .filter(message => message.type === 'user')
    return yield* continueQuery({
      ...queryParams,
      messages: [...queryParams.messages, assistantMessage, ...normalizedResults],
      toolUseContext: context,
    })
  } finally {
    client?.close()
  }
}

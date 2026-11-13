/**
 * PM Connectors — setup recipes and permission guardrails for the MCP servers
 * a product team may already use. This package deliberately does not talk to
 * third-party APIs itself: credentials and transport belong to Pi's MCP
 * configuration.
 */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import {
  CONNECTOR_RECIPES,
  buildConnectorChecklist,
  connectorCatalog,
  connectorRecipe,
  type ConnectorCategory
} from '../src/connectors.ts'

const POLICY_MARKER = 'PI CONNECTOR POLICY'

const CONNECTOR_POLICY = `[${POLICY_MARKER}]
When a product-management task needs an external system:
- Use an MCP connector that is already configured; never invent a token, endpoint, project id or customer record.
- Default to read-only. Ask for explicit confirmation before creating, updating or posting anything.
- State the source, project/workspace, date range and query/export in the answer.
- Redact personal data (names, emails, phone numbers, order ids) before putting ticket or CRM text into a prompt or report.
- If a connector is missing, give the setup steps from pm_connector and stop; do not scrape a private system through a browser without permission.`

const CONNECTOR_PROMPT_PATTERN =
  /(jira|linear|notion|slack|飞书|lark|钉钉|dingtalk|amplitude|mixpanel|zendesk|salesforce|connector|连接器|同步|导入|集成|mcp|api|工单|ticket)/i

function categoryOf(value: unknown): ConnectorCategory | undefined {
  return value === 'planning' || value === 'docs' || value === 'communication' || value === 'analytics' || value === 'support' || value === 'crm'
    ? value
    : undefined
}

export default function registerPmConnectors(pi: ExtensionAPI) {
  pi.registerTool({
    name: 'pm_connector',
    label: 'PM Connector',
    description:
      'List product-team MCP connector recipes, show the setup and read/write permission checklist for Jira, Linear, Notion, Slack, Feishu, DingTalk, Amplitude, Mixpanel, Zendesk or Salesforce, and keep credentials out of prompts.',
    promptSnippet: 'Show a PM connector recipe and least-privilege setup checklist',
    promptGuidelines: [
      'Use pm_connector before proposing a Jira/Linear/Notion/Slack/Feishu/analytics integration.',
      'Keep external writes off until a human explicitly approves them.'
    ],
    parameters: Type.Object({
      action: Type.String({ enum: ['catalog', 'recipe', 'checklist'], description: 'catalog, recipe or checklist' }),
      id: Type.Optional(Type.String({ description: 'Connector id, e.g. jira, linear, notion' })),
      category: Type.Optional(
        Type.String({ enum: ['planning', 'docs', 'communication', 'analytics', 'support', 'crm'] })
      )
    }),
    async execute(
      _toolCallId,
      params
    ): Promise<{ content: Array<{ type: 'text'; text: string }>; details: Record<string, unknown> }> {
      if (params.action === 'catalog') {
        const recipes = connectorCatalog(categoryOf(params.category))
        const lines = ['## PM 连接器目录', '']
        for (const category of ['planning', 'docs', 'communication', 'analytics', 'support', 'crm'] as const) {
          const group = recipes.filter((recipe) => recipe.category === category)
          if (!group.length) continue
          lines.push(`### ${category}`, '')
          for (const recipe of group) lines.push(`- **${recipe.id}**（${recipe.name}）：${recipe.bestFor}`)
          lines.push('')
        }
        lines.push('提示：先只读连接，写操作需要明确确认。')
        return { content: [{ type: 'text', text: lines.join('\n') }], details: { action: params.action } }
      }
      if (!params.id) throw new Error('id is required for recipe/checklist.')
      const recipe = connectorRecipe(params.id)
      if (!recipe) throw new Error(`Unknown connector "${params.id}". Available: ${CONNECTOR_RECIPES.map((item) => item.id).join(', ')}.`)
      return {
        content: [{ type: 'text', text: buildConnectorChecklist(recipe) }],
        details: { action: params.action, id: recipe.id }
      }
    }
  })

  pi.registerCommand('pm-connect', {
    description: 'Show a PM connector recipe and its least-privilege setup checklist',
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify('The /pm-connect command needs an interactive UI. Ask the agent to use the pm_connector tool instead.', 'warning')
        return
      }
      const choices = CONNECTOR_RECIPES.map((recipe) => `${recipe.name} — ${recipe.bestFor}`)
      const choice = await ctx.ui.select('产品经理连接器', choices)
      if (!choice) return
      const recipe = CONNECTOR_RECIPES[choices.indexOf(choice)]
      if (!recipe) return
      const context = await ctx.ui.input('项目 / 团队上下文', args.trim() || '例如：我们的 Jira 项目')
      if (context === undefined) return
      pi.sendUserMessage(
        `请根据下面的连接器检查清单，帮我评估并配置 ${recipe.name} 的只读 MCP 连接。项目上下文：${context.trim() || '未提供'}。\n\n${buildConnectorChecklist(recipe)}`
      )
    }
  })

  pi.on('before_agent_start', async (event) => {
    if (event.messageType !== 'user') return
    if (!CONNECTOR_PROMPT_PATTERN.test(event.prompt)) return
    if (event.systemPrompt.includes(POLICY_MARKER)) return
    return { systemPrompt: `${event.systemPrompt}\n\n${CONNECTOR_POLICY}` }
  })
}

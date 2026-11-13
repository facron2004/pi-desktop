/**
 * Curated connector recipes for the PM Toolkit suite.
 *
 * These are not API clients. They are setup and permission recipes for MCP
 * servers a team already trusts; actual credentials and transport live in
 * Pi's MCP configuration.
 */

export type ConnectorCategory = 'planning' | 'docs' | 'communication' | 'analytics' | 'support' | 'crm'

export interface ConnectorRecipe {
  id: string
  name: string
  category: ConnectorCategory
  /** Typical MCP server package or endpoint family. Verify the current package before installing. */
  mcpServer: string
  transport: 'stdio' | 'http'
  bestFor: string
  readTools: string[]
  writeTools: string[]
  requiredFields: string[]
  setupSteps: string[]
  privacy: string
}

export const CONNECTOR_RECIPES: readonly ConnectorRecipe[] = [
  {
    id: 'jira',
    name: 'Jira',
    category: 'planning',
    mcpServer: 'atlassian / jira MCP server',
    transport: 'stdio',
    bestFor: 'Sprint backlog, issue status and acceptance criteria in engineering-led teams.',
    readTools: ['search issues (JQL)', 'get issue', 'list projects', 'read comments'],
    writeTools: ['create issue', 'update issue', 'add comment'],
    requiredFields: ['base URL', 'email or API token', 'project key'],
    setupSteps: [
      'Create a read-only API token scoped to the project first.',
      'Configure the MCP server under MCP → Jira with the base URL and token.',
      'Ask the agent to list projects before reading a backlog.',
      'Keep write tools disabled until the team agrees on a create/update policy.'
    ],
    privacy: 'Tokens are credentials: never paste them into chat or a prompt; store them through MCP settings only.'
  },
  {
    id: 'linear',
    name: 'Linear',
    category: 'planning',
    mcpServer: 'linear MCP server',
    transport: 'stdio',
    bestFor: 'Fast-moving product teams whose source of truth is Linear issues and cycles.',
    readTools: ['list teams', 'search issues', 'get issue', 'read cycle'],
    writeTools: ['create issue', 'update issue', 'add comment'],
    requiredFields: ['API key', 'team key'],
    setupSteps: [
      'Create a personal API key with read access first.',
      'Configure the MCP server and select the team.',
      'Verify issue search on a small query before syncing a whole backlog.'
    ],
    privacy: 'Do not export customer names or private issue bodies into prompts unnecessarily; request the minimum fields.'
  },
  {
    id: 'notion',
    name: 'Notion',
    category: 'docs',
    mcpServer: 'notion MCP server',
    transport: 'stdio',
    bestFor: 'PRDs, research notes and decision logs stored as pages or databases.',
    readTools: ['search pages', 'read page', 'query database'],
    writeTools: ['create page', 'append blocks', 'update database item'],
    requiredFields: ['integration token', 'workspace permissions', 'database/page id'],
    setupSteps: [
      'Create an internal integration and share only the relevant page or database with it.',
      'Configure the MCP server with the integration token.',
      'Read the page structure before writing; preserve existing blocks.',
      'Default to draft pages, not edits of published docs.'
    ],
    privacy: 'Shared pages can contain sensitive strategy; scope the integration to the smallest workspace area.'
  },
  {
    id: 'slack',
    name: 'Slack',
    category: 'communication',
    mcpServer: 'slack MCP server',
    transport: 'http',
    bestFor: 'Stakeholder updates, customer-channel summaries and launch coordination.',
    readTools: ['search messages', 'read channel history', 'list channels'],
    writeTools: ['post message', 'reply in thread'],
    requiredFields: ['bot/user token', 'allowed channel list'],
    setupSteps: [
      'Create a bot with read access to selected channels only.',
      'Add the bot to a dedicated product channel before broad use.',
      'Ask before posting; a draft in chat is safer than a direct channel write.'
    ],
    privacy: 'Messages are people’s words; summarise, do not quote private DMs, and never post without confirmation.'
  },
  {
    id: 'feishu',
    name: '飞书 / Lark',
    category: 'communication',
    mcpServer: 'Lark/Feishu MCP server',
    transport: 'http',
    bestFor: 'Docs, bitable backlogs, approval workflows and team updates in Chinese organisations.',
    readTools: ['read doc', 'query bitable', 'read approval'],
    writeTools: ['create doc', 'append bitable record', 'send message'],
    requiredFields: ['app id', 'app secret', 'tenant permissions', 'document/bitable token'],
    setupSteps: [
      'Create a self-built app with least-privilege scopes.',
      'Grant access only to the target folder, base or chat.',
      'Test read-only access before enabling write scopes.',
      'Confirm the bot is not in customer-facing groups by default.'
    ],
    privacy: 'Tenant data may be regulated; keep tokens in MCP settings and log only field names, not values.'
  },
  {
    id: 'dingtalk',
    name: '钉钉 / DingTalk',
    category: 'communication',
    mcpServer: 'DingTalk MCP server / robot webhook',
    transport: 'http',
    bestFor: 'Release announcements and operational alerts for teams already on DingTalk.',
    readTools: ['list groups', 'read messages'],
    writeTools: ['send robot message'],
    requiredFields: ['app key/secret or robot webhook', 'security keyword/sign'],
    setupSteps: [
      'Use a dedicated robot and a test group first.',
      'Store the webhook in MCP settings, not in the prompt.',
      'Send only reviewed announcements; never auto-post on a schedule without an owner.'
    ],
    privacy: 'Webhooks can post to a whole company; treat them as write credentials and rotate if leaked.'
  },
  {
    id: 'amplitude',
    name: 'Amplitude',
    category: 'analytics',
    mcpServer: 'Amplitude MCP server',
    transport: 'http',
    bestFor: 'Event-based product analytics, funnels, retention and cohort definitions.',
    readTools: ['query events', 'run funnel', 'read chart', 'list cohorts'],
    writeTools: [],
    requiredFields: ['API key', 'secret key', 'project'],
    setupSteps: [
      'Create a read-only key for the project.',
      'Configure the MCP server and verify one known event count.',
      'Record the metric definition and date range in every answer.'
    ],
    privacy: 'Analytics data is aggregated; still avoid exporting user-level identifiers into prompts.'
  },
  {
    id: 'mixpanel',
    name: 'Mixpanel',
    category: 'analytics',
    mcpServer: 'Mixpanel MCP server',
    transport: 'http',
    bestFor: 'Product funnels, retention and experiment readouts for a defined project.',
    readTools: ['run query', 'read funnel', 'read retention', 'list events'],
    writeTools: [],
    requiredFields: ['service account', 'project id'],
    setupSteps: [
      'Create a read-only service account.',
      'Verify the project and event names before trusting a query.',
      'Always state the date range, segment and denominator.'
    ],
    privacy: 'Do not request raw user profiles; query aggregate events only.'
  },
  {
    id: 'zendesk',
    name: 'Zendesk',
    category: 'support',
    mcpServer: 'Zendesk MCP server',
    transport: 'http',
    bestFor: 'Support ticket themes, escalation reasons and customer pain clustering.',
    readTools: ['search tickets', 'read ticket', 'list views'],
    writeTools: ['add tag', 'add internal note'],
    requiredFields: ['subdomain', 'API token', 'agent email'],
    setupSteps: [
      'Create a read-only API token first.',
      'Limit the ticket view by date/segment to keep the export small.',
      'Strip customer names and emails before using text in analysis.'
    ],
    privacy: 'Support tickets contain personal data; redact names, emails, order ids and phone numbers.'
  },
  {
    id: 'salesforce',
    name: 'Salesforce',
    category: 'crm',
    mcpServer: 'Salesforce MCP server',
    transport: 'http',
    bestFor: 'Win/loss context, account segments and sales objections for B2B products.',
    readTools: ['query accounts', 'query opportunities', 'read activity'],
    writeTools: ['create task', 'update opportunity'],
    requiredFields: ['instance URL', 'OAuth client', 'read-only permission set'],
    setupSteps: [
      'Use a dedicated read-only integration user.',
      'Limit SOQL fields to what the analysis needs.',
      'Keep write tools off until a manager approves the workflow.'
    ],
    privacy: 'CRM data is commercially sensitive; do not surface account names in external reports without approval.'
  }
]

export function connectorCatalog(category?: ConnectorCategory): ConnectorRecipe[] {
  return CONNECTOR_RECIPES.filter((recipe) => !category || recipe.category === category)
}

export function connectorRecipe(id: string): ConnectorRecipe | undefined {
  return CONNECTOR_RECIPES.find((recipe) => recipe.id === id)
}

export function buildConnectorChecklist(recipe: ConnectorRecipe): string {
  return [
    `# ${recipe.name} 连接器检查清单`,
    '',
    `- 类别：${recipe.category}`,
    `- MCP server：${recipe.mcpServer}（${recipe.transport}）`,
    `- 最适合：${recipe.bestFor}`,
    '',
    '## 读能力',
    ...recipe.readTools.map((tool) => `- [ ] ${tool}`),
    '',
    '## 写能力（默认关闭）',
    ...(recipe.writeTools.length ? recipe.writeTools.map((tool) => `- [ ] ${tool}`) : ['- 只读连接器，不开放写操作']),
    '',
    '## 配置前置',
    ...recipe.requiredFields.map((field) => `- [ ] ${field}`),
    '',
    '## 设置步骤',
    ...recipe.setupSteps.map((step, index) => `${index + 1}. ${step}`),
    '',
    '## 隐私与权限',
    `- ${recipe.privacy}`,
    '- 先只读、后写入；每次写入都要有人确认。',
    '- 任何密钥只放在 MCP 配置里，不进入提示词、日志或文档。'
  ].join('\n')
}

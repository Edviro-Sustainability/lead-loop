import { Hono } from 'hono'
import { StreamableHTTPTransport } from '@hono/mcp'
import type { AppBindings, AppEnv, FollowUpDraftMessage } from './lib/types'
import { createServiceClient } from './lib/supabase'
import { debug } from './lib/debug'
import { corsMiddleware } from './middleware/cors'
import { jwtAuth, addonAuth, mcpAuth } from './middleware/auth'
import { buildMcpServer } from './mcp/server'
import { runs } from './routes/runs'
import { examples } from './routes/examples'
import { addon } from './routes/addon'
import { processFollowUpDraft } from './jobs/follow-up-draft'
import { getDueFollowUps } from './services/runs'

const app = new Hono<AppEnv>()

// Global middleware
app.use('*', corsMiddleware())

// Health check
app.get('/health', (c) => c.json({ status: 'ok', service: 'leadloop-worker' }))

// Dashboard API routes (JWT auth)
const api = new Hono<AppEnv>()
api.use('*', jwtAuth)
api.route('/runs', runs)
api.route('/examples', examples)
app.route('/api', api)

// Gmail add-on routes (API key auth)
const addonRoutes = new Hono<AppEnv>()
addonRoutes.use('*', addonAuth)
addonRoutes.route('/', addon)
app.route('/addon', addonRoutes)

// MCP endpoint (API key auth) — stateless Streamable HTTP, one server per request
const mcpRoutes = new Hono<AppEnv>()
mcpRoutes.use('*', mcpAuth)
mcpRoutes.all('/', async (c) => {
  const server = buildMcpServer({
    supabase: c.get('supabase'),
    env: c.env,
    userId: c.get('userId'),
  })
  const transport = new StreamableHTTPTransport()
  await server.connect(transport)
  const response = await transport.handleRequest(c)
  return response ?? c.body(null, 204)
})
app.route('/mcp', mcpRoutes)

// ─── Worker exports ─────────────────────────────────────────────────────────

export default {
  fetch: app.fetch,

  /**
   * Queue consumer: creates follow-up drafts for due sequence steps.
   */
  async queue(
    batch: MessageBatch<FollowUpDraftMessage>,
    env: AppBindings,
    _ctx: ExecutionContext
  ): Promise<void> {
    const supabase = createServiceClient(env)

    for (const message of batch.messages) {
      try {
        await processFollowUpDraft(supabase, env, message.body)
        message.ack()
      } catch (err) {
        // The reason goes in as text: Workers Logs has kept only the stack
        // frames of a logged Error object, dropping its message.
        const reason = err instanceof Error ? err.message : String(err)
        console.error(
          `Queue job failed (attempt ${message.attempts}) for follow-up ${message.body.scheduledFollowUpId}: ${reason}`,
          err
        )
        // Linear backoff between attempts so a transient Gmail/Google
        // outage isn't hammered with back-to-back retries.
        message.retry({ delaySeconds: 30 * message.attempts })
      }
    }
  },

  /**
   * Cron trigger: every 10 min, enqueue due follow-ups for draft creation.
   */
  async scheduled(
    _event: ScheduledEvent,
    env: AppBindings,
    _ctx: ExecutionContext
  ): Promise<void> {
    const supabase = createServiceClient(env)
    const dueFollowUps = await getDueFollowUps(supabase)

    for (const fu of dueFollowUps) {
      await env.FOLLOW_UP_DRAFT_QUEUE.send({
        scheduledFollowUpId: fu.id,
        userId: fu.user_id,
      })
    }

    debug(env, `Enqueued ${dueFollowUps.length} follow-ups for draft creation`)
  },
}

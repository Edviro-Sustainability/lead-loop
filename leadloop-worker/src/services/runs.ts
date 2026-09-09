import type { SupabaseClient } from '@supabase/supabase-js'
import { findLatestSentThread, sendDraft } from './gmail'
import { getAccessToken } from './gmail-credentials'
import { syncThreadFromGmail } from '../jobs/thread-sync'
import { extractVariables } from '../lib/render'
import type { FollowUpDraftMessage } from '../lib/types'

/**
 * Run lifecycle: enrollment (startSequence), scheduling, stopping, and
 * saving winning runs as examples. Shared by the dashboard API, the
 * Gmail add-on, and the MCP tools — which use different Supabase
 * clients (RLS vs service-role), so every query here is explicitly
 * scoped to userId.
 */

interface GoogleEnv {
  GOOGLE_CLIENT_ID: string
  GOOGLE_CLIENT_SECRET: string
}

/** "Name <a@b.com>" -> "a@b.com" (Gmail To/From headers carry display names). */
export function bareEmail(address: string): string {
  return address.match(/<([^>]+)>/)?.[1] ?? address.trim()
}

/**
 * Follow-up lifecycle:
 *   pending -> drafting (leased) -> draft_created -> sending (leased) -> sent
 * with terminal side-exits: superseded (a manual outgoing message replaced
 * the draft), draft_missing (Gmail 404 with no send evidence — blocks the
 * cadence), dismissed (reply/stop/completion). Leases make claims atomic;
 * an expired lease means the claiming Worker died and the row is claimable
 * again.
 */
export const OUTSTANDING_DRAFT_STATUSES = ['draft_created', 'sending', 'draft_missing'] as const

const LEASE_MINUTES = 10

export function leaseEnd(from = new Date()): string {
  return new Date(from.getTime() + LEASE_MINUTES * 60_000).toISOString()
}

/**
 * Newest outgoing message time strictly after `afterIso` (null = any).
 * Timestamps come from both PostgREST (`+00:00`) and toISOString (`Z`),
 * so compare as dates, never as strings.
 */
export function newestOutgoingAfter(
  messages: Array<{ direction: string; sent_at: string | null }>,
  afterIso: string | null
): string | null {
  const after = afterIso ? new Date(afterIso).getTime() : -Infinity
  let newest: { t: number; iso: string } | null = null
  for (const m of messages) {
    if (m.direction !== 'sent' || !m.sent_at) continue
    const t = new Date(m.sent_at).getTime()
    if (Number.isNaN(t)) continue
    if (!newest || t > newest.t) newest = { t, iso: m.sent_at }
  }
  return newest && newest.t > after ? newest.iso : null
}

/** Due time for a step whose wait is anchored on the actual send time. */
export function nextDueFrom(sendTimeIso: string, delayDays: number): string {
  const due = new Date(sendTimeIso)
  due.setDate(due.getDate() + delayDays)
  return due.toISOString()
}

/** PostgREST types the to-one `sequences(steps)` join loosely, hence the cast. */
export function stepsOf(run: { sequences?: unknown }): SequenceStep[] {
  const seq = run.sequences as { steps?: SequenceStep[] } | null | undefined
  return seq?.steps ?? []
}

interface RunWithSteps {
  id: string
  sequence_step: number
  sequences?: unknown
}

/**
 * Mark a tracked draft row resolved — `sent` when the send is confirmed,
 * `superseded` when a manual outgoing message replaced it — and re-anchor
 * the run's already-scheduled next step on the actual send time (the
 * plan's invariant: waits start from the real send, not draft creation).
 * Returns the corrected due time, or null when no next step is scheduled.
 */
export async function resolveDraftRow(
  supabase: SupabaseClient,
  userId: string,
  run: RunWithSteps,
  rowId: string,
  outcome: 'sent' | 'superseded',
  actualSendTimeIso: string
): Promise<string | null> {
  const { error } = await supabase
    .from('scheduled_follow_ups')
    .update({ status: outcome, lease_expires_at: null, acted_at: new Date().toISOString() })
    .eq('id', rowId)
    .eq('user_id', userId)
  if (error) throw new Error(`Failed to mark draft ${outcome}: ${error.message}`)

  const step = stepsOf(run)[run.sequence_step - 1]
  if (!step) return null

  const due = nextDueFrom(actualSendTimeIso, step.delay_days)
  const { error: schedError } = await supabase
    .from('scheduled_follow_ups')
    .update({ scheduled_for: due })
    .eq('thread_id', run.id)
    .eq('user_id', userId)
    .in('status', ['pending', 'drafting'])
  if (schedError) throw new Error(`Failed to reschedule next step: ${schedError.message}`)
  return due
}

/**
 * Find all scheduled follow-ups that are due now. Called by the cron.
 * Includes `drafting` rows whose lease expired (a Worker died mid-draft)
 * so they are re-swept instead of stranded. Rows whose user has no Gmail
 * credentials on file are left alone: nothing can be drafted for them
 * until the user signs back in, and re-queueing them every tick only
 * makes noise. They stay pending and are picked up once reconnected.
 */
export async function getDueFollowUps(
  supabase: SupabaseClient
): Promise<Array<{ id: string; thread_id: string; user_id: string }>> {
  const now = new Date().toISOString()

  const { data, error } = await supabase
    .from('scheduled_follow_ups')
    .select('id, thread_id, user_id, profiles!inner(id)')
    .or(`status.eq.pending,and(status.eq.drafting,lease_expires_at.lt.${now})`)
    .lte('scheduled_for', now)
    .not('profiles.gmail_refresh_token', 'is', null)
    .limit(50)

  if (error) {
    console.error('getDueFollowUps error:', error.message)
    return []
  }

  return (data ?? []).map(({ id, thread_id, user_id }) => ({ id, thread_id, user_id }))
}

/**
 * Insert the pending follow-up for a run's next step, `delayDays` after
 * `from` (the previous email). Returns the scheduled time.
 */
export async function scheduleStep(
  supabase: SupabaseClient,
  threadId: string,
  userId: string,
  from: Date,
  delayDays: number
): Promise<string> {
  const scheduledFor = new Date(from)
  scheduledFor.setDate(scheduledFor.getDate() + delayDays)
  const iso = scheduledFor.toISOString()

  const { error } = await supabase.from('scheduled_follow_ups').insert({
    thread_id: threadId,
    user_id: userId,
    scheduled_for: iso,
  })
  if (error) throw new Error(`Failed to schedule follow-up: ${error.message}`)

  return iso
}

/** One follow-up email in a sequence's `steps` JSONB array. */
export interface SequenceStep {
  body: string
  delay_days: number
}

export interface StartSequenceOpts {
  sequenceId: string
  /** Gmail thread id, when the caller knows it (the add-on does). */
  gmailThreadId?: string
  /** Otherwise: resolve the newest sent thread to this address. */
  recipientEmail?: string
  /** Values for the {{variables}} used across the sequence's steps. */
  variables?: Record<string, string>
}

/**
 * Enroll a sent Gmail thread in a sequence — the single entry point
 * behind the MCP `start_sequence` tool, the add-on card, and the
 * dashboard form. Resolves the thread, validates that the provided
 * variables cover every {{placeholder}} in the sequence's steps
 * (so a draft can never go out half-rendered), creates the run, and
 * schedules step 1 relative to when the last email was sent.
 */
export async function startSequence(
  supabase: SupabaseClient,
  env: GoogleEnv,
  userId: string,
  opts: StartSequenceOpts
) {
  if (!opts.gmailThreadId && !opts.recipientEmail) {
    throw new Error('Provide gmail_thread_id or recipient_email')
  }

  const [{ data: sequence }, { data: profile }] = await Promise.all([
    supabase
      .from('sequences')
      .select('id, name, steps')
      .eq('id', opts.sequenceId)
      .eq('user_id', userId)
      .maybeSingle(),
    supabase
      .from('profiles')
      .select('gmail_refresh_token, gmail_email')
      .eq('id', userId)
      .single(),
  ])

  if (!sequence) throw new Error('Sequence not found')
  const steps = (sequence.steps ?? []) as SequenceStep[]
  if (!steps.length) {
    throw new Error(`Sequence "${sequence.name}" has no steps — add steps to it first`)
  }

  // `email` is derived from the thread itself; everything else must be provided.
  // Checked before credentials so callers always learn what the sequence needs.
  const required = [...new Set(steps.flatMap((s) => extractVariables(s.body)))]
  const provided = opts.variables ?? {}
  const missing = required.filter((v) => v !== 'email' && !(v in provided))
  if (missing.length) {
    throw new Error(
      `Missing variables: ${missing.join(', ')}. ` +
        `Sequence "${sequence.name}" needs: ${required.join(', ')}`
    )
  }

  if (!profile?.gmail_refresh_token) {
    throw new Error('No Gmail credentials on file — sign in on the dashboard first')
  }

  const accessToken = await getAccessToken(supabase, env, userId, profile.gmail_refresh_token)

  let gmailThreadId = opts.gmailThreadId
  if (!gmailThreadId) {
    const found = await findLatestSentThread({ accessToken }, opts.recipientEmail!)
    if (!found) throw new Error(`No sent thread found to ${opts.recipientEmail}`)
    gmailThreadId = found
  }

  // One cadence per thread, ever.
  const { data: existing } = await supabase
    .from('watched_threads')
    .select('id')
    .eq('user_id', userId)
    .eq('gmail_thread_id', gmailThreadId)
    .maybeSingle()
  if (existing) {
    const { data: pending } = await supabase
      .from('scheduled_follow_ups')
      .select('scheduled_for')
      .eq('thread_id', existing.id)
      .eq('status', 'pending')
      .limit(1)
    if (pending?.[0]) {
      throw new Error(
        `Thread already has a follow-up scheduled for ${pending[0].scheduled_for} — stop that run first`
      )
    }
  }

  const { data: run, error: runError } = await supabase
    .from('watched_threads')
    .upsert(
      {
        user_id: userId,
        gmail_thread_id: gmailThreadId,
        status: 'active',
        sequence_id: opts.sequenceId,
        sequence_step: 1,
        variables: provided,
      },
      { onConflict: 'user_id,gmail_thread_id' }
    )
    .select()
    .single()
  if (runError) throw new Error(runError.message)

  await syncThreadFromGmail(supabase, env, {
    threadId: run.id,
    gmailThreadId,
    userId,
    refreshToken: profile.gmail_refresh_token,
    userEmail: profile.gmail_email ?? '',
  })

  const { data: messages } = await supabase
    .from('thread_messages')
    .select('direction, to_email, subject, sent_at')
    .eq('thread_id', run.id)
    .order('sent_at', { ascending: true })
  const sent = (messages ?? []).filter((m) => m.direction === 'sent')
  if (!sent.length) {
    throw new Error(
      'No sent message in this thread — send the personalized first email before starting a sequence'
    )
  }

  const lastSent = sent[sent.length - 1]
  const updates = {
    subject: run.subject ?? messages?.[0]?.subject ?? null,
    variables: {
      email: opts.recipientEmail ?? bareEmail(lastSent.to_email ?? ''),
      ...provided,
    },
  }
  await supabase.from('watched_threads').update(updates).eq('id', run.id)

  const nextDraftAt = await scheduleStep(
    supabase,
    run.id,
    userId,
    new Date(lastSent.sent_at ?? Date.now()),
    steps[0].delay_days
  )

  return {
    run: { ...run, ...updates },
    sequence_name: sequence.name,
    total_steps: steps.length,
    next_draft_at: nextDraftAt,
  }
}

/**
 * Stop a run: no more drafts, and nothing left sendable. Dismisses every
 * outstanding follow-up state (pending, mid-draft, created drafts) without
 * deleting the Gmail drafts themselves — LeadLoop just makes them ineligible.
 */
export async function stopRun(supabase: SupabaseClient, userId: string, threadId: string) {
  const { data: thread, error } = await supabase
    .from('watched_threads')
    .update({ status: 'stopped' })
    .eq('id', threadId)
    .eq('user_id', userId)
    .select()
    .single()
  if (error || !thread) throw new Error('Run not found')

  const { error: dismissError } = await supabase
    .from('scheduled_follow_ups')
    .update({ status: 'dismissed', lease_expires_at: null, acted_at: new Date().toISOString() })
    .eq('thread_id', threadId)
    .eq('user_id', userId)
    .in('status', ['pending', 'drafting', ...OUTSTANDING_DRAFT_STATUSES])
  if (dismissError) throw new Error(`Run stopped but cleanup failed: ${dismissError.message}`)

  return thread
}

export interface DraftNowResult {
  queued: string[]
  skipped: Array<{ run_id: string; reason: string }>
}

/**
 * Queue the selected runs' pending follow-ups for immediate drafting via
 * the existing queue consumer (all its gates stay in force). Cadence
 * timestamps are never rewritten — the consumer drafts on demand, and the
 * schedule re-anchors on the real send when it happens. Empty selection is
 * an error, never "all"; results are itemized so "queued" is not "drafted".
 */
export async function draftNow(
  supabase: SupabaseClient,
  queue: Queue<FollowUpDraftMessage>,
  userId: string,
  runIds: string[]
): Promise<DraftNowResult> {
  const ids = [...new Set(runIds)]
  if (ids.length === 0) throw new Error('run_ids must not be empty')
  if (ids.length > 50) throw new Error('At most 50 runs per draft-now call')

  const [runsRes, rowsRes, profileRes] = await Promise.all([
    supabase.from('watched_threads').select('id, status').eq('user_id', userId).in('id', ids),
    supabase
      .from('scheduled_follow_ups')
      .select('id, thread_id, status')
      .eq('user_id', userId)
      .in('thread_id', ids)
      .in('status', ['pending', 'drafting', ...OUTSTANDING_DRAFT_STATUSES]),
    supabase.from('profiles').select('gmail_refresh_token').eq('id', userId).single(),
  ])
  if (runsRes.error) throw new Error(runsRes.error.message)
  if (rowsRes.error) throw new Error(rowsRes.error.message)
  // The consumer would only no-op without credentials; say so up front
  // instead of reporting "queued" for drafts that can never appear.
  if (!profileRes.data?.gmail_refresh_token) {
    throw new Error('No Gmail credentials on file — sign in on the dashboard first')
  }

  const queued: string[] = []
  const skipped: DraftNowResult['skipped'] = []
  const messages: Array<{ body: FollowUpDraftMessage }> = []

  for (const id of ids) {
    const run = runsRes.data?.find((r) => r.id === id)
    const rows = rowsRes.data?.filter((r) => r.thread_id === id) ?? []
    const pendingRow = rows.find((r) => r.status === 'pending')

    if (!run) skipped.push({ run_id: id, reason: 'run not found' })
    else if (run.status !== 'active') skipped.push({ run_id: id, reason: `run is ${run.status}` })
    else if (rows.some((r) => (OUTSTANDING_DRAFT_STATUSES as readonly string[]).includes(r.status)))
      skipped.push({ run_id: id, reason: 'has an unsent LeadLoop draft — send it first' })
    else if (rows.some((r) => r.status === 'drafting'))
      skipped.push({ run_id: id, reason: 'already drafting' })
    else if (!pendingRow) skipped.push({ run_id: id, reason: 'no pending follow-up' })
    else {
      queued.push(id)
      messages.push({ body: { scheduledFollowUpId: pendingRow.id, userId } })
    }
  }

  if (messages.length > 0) await queue.sendBatch(messages)
  return { queued, skipped }
}

export type SendOutcome =
  | 'sent'
  | 'already_sent'
  | 'skipped_reply'
  | 'superseded'
  | 'draft_missing'
  | 'no_draft'
  | 'not_found'
  | 'failed'

export interface SendDraftsResult {
  results: Array<{
    run_id: string
    outcome: SendOutcome
    detail?: string
    next_draft_at?: string | null
  }>
}

/**
 * Send the selected runs' LeadLoop-created Gmail drafts — and only those:
 * Gmail is addressed by the exact stored draft id, never listed. Requires
 * explicit run ids (max 20; callers chunk larger selections). Each run is
 * synced first and skipped if a reply or newer outgoing message appeared
 * after draft creation. Partial failure never hides successful sends.
 */
export async function sendLeadLoopDrafts(
  supabase: SupabaseClient,
  env: GoogleEnv,
  userId: string,
  runIds: string[]
): Promise<SendDraftsResult> {
  const ids = [...new Set(runIds)]
  if (ids.length === 0) throw new Error('run_ids must not be empty')
  if (ids.length > 20) throw new Error('At most 20 runs per send call')

  const [runsRes, profileRes] = await Promise.all([
    supabase
      .from('watched_threads')
      .select('id, gmail_thread_id, status, sequence_step, sequences(steps)')
      .eq('user_id', userId)
      .in('id', ids),
    supabase.from('profiles').select('gmail_refresh_token, gmail_email').eq('id', userId).single(),
  ])
  if (runsRes.error) throw new Error(runsRes.error.message)
  const profile = profileRes.data
  if (!profile?.gmail_refresh_token) {
    throw new Error('No Gmail credentials on file — sign in on the dashboard first')
  }

  const tokens = {
    accessToken: await getAccessToken(supabase, env, userId, profile.gmail_refresh_token),
  }

  const results: SendDraftsResult['results'] = []
  for (const id of ids) {
    const run = runsRes.data?.find((r) => r.id === id)
    if (!run) {
      results.push({ run_id: id, outcome: 'not_found' })
      continue
    }
    try {
      results.push(await sendRunDraft(supabase, env, tokens, userId, run, profile))
    } catch (err) {
      results.push({
        run_id: id,
        outcome: 'failed',
        detail: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return { results }
}

/** Send one run's current LeadLoop draft. Throwing = `failed` for that run only. */
async function sendRunDraft(
  supabase: SupabaseClient,
  env: GoogleEnv,
  tokens: { accessToken: string },
  userId: string,
  run: RunWithSteps & { gmail_thread_id: string },
  profile: { gmail_refresh_token: string; gmail_email: string | null }
): Promise<SendDraftsResult['results'][number]> {
  const nowIso = new Date().toISOString()

  // Outstanding LeadLoop drafts, newest first. Only rows with a stored
  // draft id are sendable; older ones are stale history to reconcile.
  const { data: rows, error: rowsError } = await supabase
    .from('scheduled_follow_ups')
    .select('id, status, acted_at, draft_gmail_id, lease_expires_at')
    .eq('thread_id', run.id)
    .eq('user_id', userId)
    .in('status', [...OUTSTANDING_DRAFT_STATUSES])
    .not('draft_gmail_id', 'is', null)
    .order('acted_at', { ascending: false })
  if (rowsError) throw new Error(rowsError.message)

  const [current, ...stale] = rows ?? []
  if (!current) return { run_id: run.id, outcome: 'no_draft' }

  // Atomic claim: a fresh draft, a blocked draft_missing retry, or a
  // crashed send whose lease expired (the retry that reconciles it).
  const { data: claimed, error: claimError } = await supabase
    .from('scheduled_follow_ups')
    .update({ status: 'sending', lease_expires_at: leaseEnd() })
    .eq('id', current.id)
    .eq('user_id', userId)
    .or(
      `status.eq.draft_created,status.eq.draft_missing,and(status.eq.sending,lease_expires_at.lt.${nowIso})`
    )
    .select('id')
    .maybeSingle()
  if (claimError) throw new Error(claimError.message)
  if (!claimed) {
    const { data: fresh } = await supabase
      .from('scheduled_follow_ups')
      .select('status')
      .eq('id', current.id)
      .maybeSingle()
    if (fresh?.status === 'sent') return { run_id: run.id, outcome: 'already_sent' }
    return { run_id: run.id, outcome: 'failed', detail: 'draft is busy — try again shortly' }
  }

  const releaseTo = async (status: string) => {
    await supabase
      .from('scheduled_follow_ups')
      .update({ status, lease_expires_at: null })
      .eq('id', current.id)
      .eq('user_id', userId)
      .eq('status', 'sending')
  }

  try {
    await syncThreadFromGmail(supabase, env, {
      threadId: run.id,
      gmailThreadId: run.gmail_thread_id,
      userId,
      refreshToken: profile.gmail_refresh_token,
      userEmail: profile.gmail_email ?? '',
    })
    const { data: messages, error: msgError } = await supabase
      .from('thread_messages')
      .select('direction, sent_at')
      .eq('thread_id', run.id)
    if (msgError) throw new Error(msgError.message)
    const msgs = messages ?? []

    // A reply ends the run — same rule as the draft consumer.
    if (msgs.some((m) => m.direction === 'received')) {
      const { error: replyError } = await supabase
        .from('watched_threads')
        .update({ status: 'replied' })
        .eq('id', run.id)
        .eq('user_id', userId)
      if (replyError) throw new Error(replyError.message)
      const { error: dismissError } = await supabase
        .from('scheduled_follow_ups')
        .update({ status: 'dismissed', lease_expires_at: null, acted_at: new Date().toISOString() })
        .eq('thread_id', run.id)
        .eq('user_id', userId)
        .in('status', ['pending', 'drafting', ...OUTSTANDING_DRAFT_STATUSES])
      if (dismissError) throw new Error(dismissError.message)
      return { run_id: run.id, outcome: 'skipped_reply' }
    }

    // Reconcile stale historical rows against real outgoing mail.
    for (const row of stale) {
      const sentAfter = newestOutgoingAfter(msgs, row.acted_at)
      if (sentAfter) await resolveDraftRow(supabase, userId, run, row.id, 'superseded', sentAfter)
    }

    // A newer outgoing message means this draft already went out manually
    // (or was replaced by a hand-written follow-up). Never double-send.
    const manualSendAt = newestOutgoingAfter(msgs, current.acted_at)
    if (manualSendAt) {
      const wasOurSend = current.status === 'sending'
      const next = await resolveDraftRow(
        supabase,
        userId,
        run,
        current.id,
        wasOurSend ? 'sent' : 'superseded',
        manualSendAt
      )
      return {
        run_id: run.id,
        outcome: wasOurSend ? 'already_sent' : 'superseded',
        next_draft_at: next,
      }
    }

    const sentMessage = await sendDraft(tokens, current.draft_gmail_id as string)
    if (sentMessage) {
      const next = await resolveDraftRow(
        supabase,
        userId,
        run,
        current.id,
        'sent',
        new Date().toISOString()
      )
      return { run_id: run.id, outcome: 'sent', next_draft_at: next }
    }

    // Gmail 404 with no send evidence: the draft vanished (deleted by
    // hand?). Not success — block the cadence and surface it.
    await releaseTo('draft_missing')
    return {
      run_id: run.id,
      outcome: 'draft_missing',
      detail: 'Gmail no longer has this draft and no newer outgoing message explains it',
    }
  } catch (err) {
    await releaseTo(current.status === 'draft_missing' ? 'draft_missing' : 'draft_created')
    throw err
  }
}

/**
 * Save a run's real conversation as one outreach example row for GTM
 * analysis: the full thread as text, linked to the sequence that won.
 * Self-contained copy — survives the thread being deleted later.
 */
export async function saveRunAsExample(
  supabase: SupabaseClient,
  userId: string,
  threadId: string,
  opts: { context?: string; outcome?: string; tags?: string[] } = {}
) {
  const [{ data: thread }, { data: messages }] = await Promise.all([
    supabase
      .from('watched_threads')
      .select('subject, sequence_id')
      .eq('id', threadId)
      .eq('user_id', userId)
      .maybeSingle(),
    supabase
      .from('thread_messages')
      .select('direction, body_text, snippet, sent_at')
      .eq('thread_id', threadId)
      .order('sent_at', { ascending: true }),
  ])
  if (!thread) throw new Error('Run not found')

  const withBodies = (messages ?? [])
    .map((m) => ({ ...m, text: (m.body_text ?? m.snippet ?? '').trim() }))
    .filter((m) => m.text)
  if (!withBodies.length) throw new Error('No messages with content in this thread')

  const body = withBodies
    .map(
      (m) =>
        `[${m.direction === 'sent' ? 'SENT' : 'RECEIVED'} ${m.sent_at?.slice(0, 10) ?? ''}]\n${m.text}`
    )
    .join('\n\n')

  const { data, error } = await supabase
    .from('outreach_examples')
    .insert({
      user_id: userId,
      context: opts.context ?? `Thread "${thread.subject ?? 'Untitled'}"`,
      subject: thread.subject,
      body,
      outcome: opts.outcome ?? 'replied',
      tags: opts.tags ?? [],
      sequence_id: thread.sequence_id,
    })
    .select()
    .single()
  if (error) throw new Error(error.message)
  return data
}

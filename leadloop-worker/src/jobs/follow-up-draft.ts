import type { SupabaseClient } from '@supabase/supabase-js'
import type { FollowUpDraftMessage } from '../lib/types'
import { GoogleTokenError, createDraft } from '../services/gmail'
import { getAccessToken } from '../services/gmail-credentials'
import {
  scheduleStep,
  bareEmail,
  leaseEnd,
  stepsOf,
  newestOutgoingAfter,
  resolveDraftRow,
  OUTSTANDING_DRAFT_STATUSES,
} from '../services/runs'
import { renderTemplate } from '../lib/render'
import { syncThreadFromGmail } from './thread-sync'

interface DraftEnv {
  GOOGLE_CLIENT_ID: string
  GOOGLE_CLIENT_SECRET: string
}

/**
 * Create the next follow-up draft for a run. No AI: the body is the
 * current step of the sequence with the run's stored {{variables}}
 * filled in. Called by the follow-up-draft queue consumer (fed by the
 * cron sweep and by explicit Draft-now bumps); throwing lets the queue
 * retry (e.g. transient Gmail failures). Failures that a retry cannot
 * fix — Google rejecting our credentials — return instead, leaving the
 * row pending for whenever a human has repaired the credentials.
 */
export async function processFollowUpDraft(
  supabase: SupabaseClient,
  env: DraftEnv,
  msg: FollowUpDraftMessage
): Promise<void> {
  const nowIso = new Date().toISOString()

  // Atomic claim (pending -> drafting). Also reclaims a drafting row whose
  // lease expired — a Worker died mid-draft. Losing the claim means the row
  // is already handled or actively owned, so cron/bump double-enqueues and
  // queue redeliveries collapse into no-ops here.
  const { data: claimedRow, error: claimError } = await supabase
    .from('scheduled_follow_ups')
    .update({ status: 'drafting', lease_expires_at: leaseEnd() })
    .eq('id', msg.scheduledFollowUpId)
    .eq('user_id', msg.userId)
    .or(`status.eq.pending,and(status.eq.drafting,lease_expires_at.lt.${nowIso})`)
    .select('id, thread_id')
    .maybeSingle()
  if (claimError) throw new Error(`Follow-up claim failed: ${claimError.message}`)
  if (!claimedRow) return

  const threadId = claimedRow.thread_id

  // Transition our claimed row; the status guard makes this (and the
  // release in the catch) a no-op once the row has moved on.
  const patchRow = async (patch: Record<string, unknown>) => {
    const { error } = await supabase
      .from('scheduled_follow_ups')
      .update({ lease_expires_at: null, ...patch })
      .eq('id', msg.scheduledFollowUpId)
      .eq('status', 'drafting')
    if (error) throw new Error(`Follow-up state update failed: ${error.message}`)
  }
  const dismiss = () => patchRow({ status: 'dismissed', acted_at: new Date().toISOString() })

  try {
    const [{ data: thread }, { data: profile }] = await Promise.all([
      supabase
        .from('watched_threads')
        .select(
          'gmail_thread_id, subject, status, sequence_id, sequence_step, variables, sequences(steps)'
        )
        .eq('id', threadId)
        .maybeSingle(),
      supabase
        .from('profiles')
        .select('gmail_refresh_token, gmail_email')
        .eq('id', msg.userId)
        .single(),
    ])

    if (!thread) {
      // Orphaned schedule row (run deleted); close it out rather than retry forever.
      console.error(`Thread ${threadId} not found`)
      await dismiss()
      return
    }
    if (!profile?.gmail_refresh_token) {
      console.error(`No Gmail credentials for user ${msg.userId}`)
      await patchRow({ status: 'pending' }) // retry once credentials return
      return
    }

    // A stopped/replied/completed run never drafts.
    if (thread.status !== 'active' || !thread.sequence_id) {
      await dismiss()
      return
    }

    await syncThreadFromGmail(supabase, env, {
      threadId,
      gmailThreadId: thread.gmail_thread_id,
      userId: msg.userId,
      refreshToken: profile.gmail_refresh_token,
      userEmail: profile.gmail_email ?? '',
    })

    const { data: messages, error: msgError } = await supabase
      .from('thread_messages')
      .select('direction, to_email, sent_at')
      .eq('thread_id', threadId)
      .order('sent_at', { ascending: true })
    if (msgError) throw new Error(`Failed to load thread messages: ${msgError.message}`)
    const msgs = messages ?? []

    // A reply ends the run.
    if (msgs.some((m) => m.direction === 'received')) {
      const { error: replyError } = await supabase
        .from('watched_threads')
        .update({ status: 'replied' })
        .eq('id', threadId)
      if (replyError) throw new Error(`Failed to mark run replied: ${replyError.message}`)
      await dismiss()
      return
    }

    const run = { id: threadId, sequence_step: thread.sequence_step, sequences: thread.sequences }

    // Reconcile outstanding drafts from earlier steps. A newer outgoing
    // message resolves them (sent manually -> superseded, or a crashed
    // send that actually went out -> sent) and re-anchors this step's due
    // time on that real send. Unresolved ones block: never stack a new
    // draft behind an unsent or missing one.
    const { data: outstanding, error: outError } = await supabase
      .from('scheduled_follow_ups')
      .select('id, status, acted_at, lease_expires_at')
      .eq('thread_id', threadId)
      .eq('user_id', msg.userId)
      .in('status', [...OUTSTANDING_DRAFT_STATUSES])
    if (outError) throw new Error(`Failed to load outstanding drafts: ${outError.message}`)

    let correctedDue: string | null = null
    let blocked = false
    for (const row of outstanding ?? []) {
      const leaseActive =
        row.status === 'sending' &&
        row.lease_expires_at !== null &&
        new Date(row.lease_expires_at) > new Date()
      if (leaseActive) {
        blocked = true // a send is in flight right now
        continue
      }
      const sentAfter = newestOutgoingAfter(msgs, row.acted_at)
      if (sentAfter) {
        correctedDue = await resolveDraftRow(
          supabase,
          msg.userId,
          run,
          row.id,
          row.status === 'sending' ? 'sent' : 'superseded',
          sentAfter
        )
      } else {
        blocked = true
      }
    }

    if (blocked) {
      const tomorrow = new Date()
      tomorrow.setDate(tomorrow.getDate() + 1)
      await patchRow({ status: 'pending', scheduled_for: tomorrow.toISOString() })
      return
    }
    if (correctedDue && new Date(correctedDue) > new Date()) {
      // The manual send re-anchored this step into the future; run when due.
      // (Draft-now bumps only queue runs with no outstanding drafts, so a
      // bump never lands here — it drafts immediately below.)
      await patchRow({ status: 'pending' }) // scheduled_for already corrected
      return
    }

    const lastSent = [...msgs].reverse().find((m) => m.direction === 'sent')
    if (!lastSent?.to_email) {
      throw new Error(`Cannot determine follow-up recipient for thread ${threadId}`)
    }

    // Current step. None = past the end (stale schedule): close out.
    const steps = stepsOf(thread)
    const step = steps[thread.sequence_step - 1]

    if (!step) {
      const { error: completeError } = await supabase
        .from('watched_threads')
        .update({ status: 'completed' })
        .eq('id', threadId)
      if (completeError) throw new Error(`Failed to complete run: ${completeError.message}`)
      await dismiss()
      return
    }

    const variables = {
      email: bareEmail(lastSent.to_email),
      ...((thread.variables ?? {}) as Record<string, string>),
    }
    const body = renderTemplate(step.body, variables)
    const subject = `Re: ${thread.subject ?? ''}`

    const accessToken = await getAccessToken(
      supabase,
      env,
      msg.userId,
      profile.gmail_refresh_token
    )

    const draft = await createDraft(
      { accessToken },
      lastSent.to_email,
      subject,
      body,
      thread.gmail_thread_id
    )

    // From here the Gmail draft exists. patchRow throwing after this point
    // releases nothing (status guard), so a retry cannot double-draft;
    // delivery is at-least-once only in the instant between these two calls.
    await patchRow({
      status: 'draft_created',
      draft_gmail_id: draft.id,
      generated_body: body,
      acted_at: new Date().toISOString(),
    })

    // Advance; schedule the next step or complete the run. The next wait is
    // anchored on draft creation for now and re-anchored on the actual send
    // by resolveDraftRow when the send is observed.
    const nextStep = thread.sequence_step + 1
    const next = steps[nextStep - 1]

    if (next) {
      const { error: stepError } = await supabase
        .from('watched_threads')
        .update({ sequence_step: nextStep })
        .eq('id', threadId)
      if (stepError) {
        throw new Error(
          `Draft ${draft.id} created but failed to advance sequence step: ${stepError.message}`
        )
      }
      await scheduleStep(supabase, threadId, msg.userId, new Date(), next.delay_days)
    } else {
      const { error: completeError } = await supabase
        .from('watched_threads')
        .update({ sequence_step: nextStep, status: 'completed' })
        .eq('id', threadId)
      if (completeError) {
        throw new Error(`Draft ${draft.id} created but failed to complete run: ${completeError.message}`)
      }
    }
  } catch (err) {
    // Release our claim so the retry/next cron can take it; the status
    // guard makes this a no-op if the row already transitioned. If this
    // release itself fails, the lease expiry is the fallback.
    await supabase
      .from('scheduled_follow_ups')
      .update({ status: 'pending', lease_expires_at: null })
      .eq('id', msg.scheduledFollowUpId)
      .eq('status', 'drafting')

    // Google refused our credentials (dead refresh token, misconfigured
    // client). No retry can change that answer, and with the cron
    // re-sweeping every due row each tick, retrying turns one dead token
    // into a permanent failure storm. The row stays pending; getAccessToken
    // has already disconnected the profile if the grant itself is dead.
    if (err instanceof GoogleTokenError && !err.retryable) {
      console.error(
        `Follow-up ${msg.scheduledFollowUpId} paused for user ${msg.userId}: ${err.message}`
      )
      return
    }
    throw err
  }
}

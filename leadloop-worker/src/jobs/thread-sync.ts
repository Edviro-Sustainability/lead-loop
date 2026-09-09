import type { SupabaseClient } from '@supabase/supabase-js'
import { getThread, extractBody, getHeader } from '../services/gmail'
import { getAccessToken } from '../services/gmail-credentials'

interface SyncEnv {
  GOOGLE_CLIENT_ID: string
  GOOGLE_CLIENT_SECRET: string
}

/**
 * Sync a watched thread's messages from Gmail into the database.
 * Called on-demand before operations that need fresh thread data
 * (suggest-reply, follow-up draft creation) and on initial watch.
 */
export async function syncThreadFromGmail(
  supabase: SupabaseClient,
  env: SyncEnv,
  opts: {
    threadId: string
    gmailThreadId: string
    userId: string
    refreshToken: string
    userEmail: string
  }
): Promise<void> {
  const accessToken = await getAccessToken(supabase, env, opts.userId, opts.refreshToken)

  const gmailThread = await getThread({ accessToken }, opts.gmailThreadId)

  const normalizedEmail = opts.userEmail.toLowerCase()

  // threads.get includes unsent DRAFT messages. They are not correspondence:
  // storing them as "sent" made every fresh draft look like a newer outgoing
  // message (the old draft-stacking bug, and a false supersede for sends).
  const realMessages = gmailThread.messages.filter((m) => !m.labelIds?.includes('DRAFT'))

  const rows = realMessages.map((gmailMsg) => {
    const from = getHeader(gmailMsg, 'From')
    const to = getHeader(gmailMsg, 'To')
    const subject = getHeader(gmailMsg, 'Subject')
    const bodyText = extractBody(gmailMsg)
    const sentAt = new Date(parseInt(gmailMsg.internalDate)).toISOString()
    // Gmail's own SENT label is authoritative (covers send-as aliases);
    // the From-address comparison is only a fallback for old messages.
    const direction =
      gmailMsg.labelIds?.includes('SENT') ||
      (normalizedEmail.length > 0 && from.toLowerCase().includes(normalizedEmail))
        ? 'sent'
        : 'received'

    return {
      thread_id: opts.threadId,
      gmail_message_id: gmailMsg.id,
      direction,
      from_email: from,
      to_email: to,
      subject,
      body_text: bodyText,
      snippet: gmailMsg.snippet,
      sent_at: sentAt,
    }
  })

  // Callers make send/skip decisions off these rows; a silently failed
  // sync would let them act on stale data, so storage failures throw.
  const { error: upsertError } = await supabase
    .from('thread_messages')
    .upsert(rows, { onConflict: 'gmail_message_id' })
  if (upsertError) {
    throw new Error(`Thread sync failed to store messages: ${upsertError.message}`)
  }

  const lastMessage = realMessages[realMessages.length - 1]
  const { error: updateError } = await supabase
    .from('watched_threads')
    .update({
      last_synced_at: new Date().toISOString(),
      last_gmail_history_id: gmailThread.historyId,
      last_activity_at: lastMessage
        ? new Date(parseInt(lastMessage.internalDate)).toISOString()
        : undefined,
    })
    .eq('id', opts.threadId)
  if (updateError) {
    throw new Error(`Thread sync failed to update run: ${updateError.message}`)
  }
}

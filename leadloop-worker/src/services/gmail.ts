import { Buffer } from 'node:buffer'
import { convert } from 'html-to-text'

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1'

interface GmailTokens {
  accessToken: string
}

interface GmailThread {
  id: string
  historyId: string
  messages: GmailMessage[]
}

interface GmailPart {
  mimeType?: string
  body?: { data?: string }
  parts?: GmailPart[]
}

interface GmailMessage {
  id: string
  threadId: string
  internalDate: string
  snippet: string
  labelIds?: string[]
  payload: GmailPart & {
    headers: Array<{ name: string; value: string }>
  }
}

/**
 * Google's token endpoint refused to mint an access token. `code` is the
 * OAuth error Google returned (`invalid_grant`, `invalid_client`, ...).
 *
 * Callers must not treat every failure alike: only server-side trouble
 * is worth a retry. `invalid_grant` means the refresh token itself is
 * dead — revoked, invalidated by a password change, or expired (OAuth
 * apps still in "Testing" publishing status expire refresh tokens after
 * 7 days) — and only a fresh sign-in can replace it.
 */
export class GoogleTokenError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, description: string) {
    // Keep it on one line: log pipelines index the first line of a message.
    super(`Token refresh failed (${status} ${code}): ${description.replace(/\s+/g, ' ').trim()}`)
    this.name = 'GoogleTokenError'
    this.status = status
    this.code = code
  }

  /** Google's side is having trouble; the same request may succeed shortly. */
  get retryable(): boolean {
    return this.status >= 500 || this.status === 429
  }

  /** The stored refresh token is dead; the user has to sign in again. */
  get needsReauth(): boolean {
    return this.code === 'invalid_grant'
  }
}

/**
 * Refresh a Google OAuth access token using a stored refresh token.
 * Throws `GoogleTokenError` when Google rejects the request.
 */
export async function refreshAccessToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string
): Promise<{ access_token: string; expires_in: number }> {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  })

  if (!response.ok) {
    const text = await response.text()
    let code = `http_${response.status}`
    let description = text.slice(0, 300)
    try {
      const body = JSON.parse(text) as { error?: string; error_description?: string }
      if (typeof body.error === 'string') code = body.error
      if (typeof body.error_description === 'string') description = body.error_description
    } catch {
      // Not JSON (e.g. an HTML 5xx page); the raw excerpt is the best we have.
    }
    throw new GoogleTokenError(response.status, code, description)
  }

  return response.json()
}

/**
 * Fetch a single Gmail thread with full message content.
 */
export async function getThread(
  tokens: GmailTokens,
  threadId: string
): Promise<GmailThread> {
  const res = await fetch(
    `${GMAIL_API}/users/me/threads/${threadId}?format=full`,
    {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
    }
  )

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Gmail getThread failed (${res.status}): ${err}`)
  }

  return res.json()
}

/**
 * Find the user's most recent sent thread to the given address.
 * Lets enrollment resolve "I just emailed sara@acme.com" into a
 * Gmail thread id without the caller ever knowing one.
 */
export async function findLatestSentThread(
  tokens: GmailTokens,
  toEmail: string
): Promise<string | null> {
  const q = encodeURIComponent(`in:sent to:${toEmail}`)
  const res = await fetch(`${GMAIL_API}/users/me/threads?q=${q}&maxResults=1`, {
    headers: { Authorization: `Bearer ${tokens.accessToken}` },
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Gmail thread search failed (${res.status}): ${err}`)
  }

  const data = (await res.json()) as { threads?: Array<{ id: string }> }
  return data.threads?.[0]?.id ?? null
}

/**
 * Create a draft in the user's Gmail.
 */
export async function createDraft(
  tokens: GmailTokens,
  to: string,
  subject: string,
  body: string,
  threadId?: string
): Promise<{ id: string; message: { id: string; threadId: string } }> {
  const raw = buildRawEmail(to, subject, body)
  const payload: Record<string, unknown> = {
    message: { raw, threadId },
  }

  const res = await fetch(`${GMAIL_API}/users/me/drafts`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tokens.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Gmail createDraft failed (${res.status}): ${err}`)
  }

  return res.json()
}

/**
 * Send an existing draft by its immutable draft id (drafts.send), so
 * only the exact draft LeadLoop created can ever go out. Returns the
 * sent message, or null when Gmail no longer has the draft — the
 * caller decides whether that means "sent manually" or "missing".
 */
export async function sendDraft(
  tokens: GmailTokens,
  draftId: string
): Promise<{ id: string; threadId: string } | null> {
  const res = await fetch(`${GMAIL_API}/users/me/drafts/send`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tokens.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ id: draftId }),
  })

  if (res.status === 404) return null
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Gmail sendDraft failed (${res.status}): ${err}`)
  }

  return res.json()
}

/**
 * Extract a readable plain-text body from a Gmail message payload.
 * Prefers text/plain, falls back to text/html converted to text.
 * The snippet fallback only fires for messages with no text part at
 * all (e.g. attachment-only) -- a data condition, not an error.
 */
export function extractBody(message: GmailMessage): string {
  const plain = findPart(message.payload, 'text/plain')
  if (plain) return stripQuotedReply(base64Decode(plain))

  const html = findPart(message.payload, 'text/html')
  if (html) return stripQuotedReply(htmlToText(base64Decode(html)))

  // Snippets are HTML-entity-escaped; htmlToText decodes them.
  return htmlToText(message.snippet ?? '')
}

/** Depth-first search of a MIME tree for the first part with inline data of the given type. */
function findPart(part: GmailPart, mimeType: string): string | undefined {
  if (part.mimeType === mimeType && part.body?.data) return part.body.data
  for (const child of part.parts ?? []) {
    const data = findPart(child, mimeType)
    if (data) return data
  }
  return undefined
}

function htmlToText(html: string): string {
  return convert(html, {
    wordwrap: false,
    selectors: [
      { selector: 'img', format: 'skip' },
      { selector: 'a', options: { ignoreHref: true } },
    ],
  }).trim()
}

// ponytail: regex markers cover Gmail/Apple Mail/Outlook quote headers;
// swap in the email-reply-parser package if other clients/locales bite.
const QUOTE_MARKERS = [
  /^On [\s\S]{0,300}? wrote:\s*$/m, // Gmail/Apple Mail attribution, may wrap across lines
  /^-{2,}\s*Original Message\s*-{2,}/im, // Outlook
  /^_{8,}\s*$/m, // Outlook divider
  /^(?:>[^\n]*(?:\n|$))+/m, // block of >-quoted lines
]

/**
 * Cut quoted reply history off a message body. Every message in the
 * thread is stored as its own row, so the quoted chain is redundant.
 * Keeps the original text when the whole body is quoted (e.g. forwards)
 * so a message is never silently discarded.
 */
function stripQuotedReply(text: string): string {
  let cut = text.length
  for (const marker of QUOTE_MARKERS) {
    const index = text.search(marker)
    if (index !== -1 && index < cut) cut = index
  }
  const stripped = text.slice(0, cut).trimEnd()
  return stripped || text.trim()
}

/**
 * Extract a header value from a Gmail message.
 */
export function getHeader(message: GmailMessage, name: string): string {
  return (
    message.payload.headers.find(
      (h) => h.name.toLowerCase() === name.toLowerCase()
    )?.value ?? ''
  )
}

function base64Decode(data: string): string {
  // atob would decode to latin-1 and mangle multi-byte UTF-8.
  return Buffer.from(data, 'base64url').toString('utf8')
}

/**
 * Render plain step text as minimal Gmail-style HTML. Plain-text parts
 * get hard-wrapped at ~78 cols on send (ragged mid-sentence breaks for
 * the recipient); HTML keeps paragraphs intact and links clickable.
 */
function textToHtml(text: string): string {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const linked = escaped.replace(/https?:\/\/[^\s<]+/g, (u) => `<a href="${u}">${u}</a>`)
  return `<div dir="ltr">${linked.replace(/\n/g, '<br>')}</div>`
}

export function buildRawEmail(to: string, subject: string, body: string): string {
  // Non-ASCII subjects need RFC 2047 encoding (raw UTF-8 is invalid in headers).
  const subj = /^[\x20-\x7e]*$/.test(subject)
    ? subject
    : `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`
  // ponytail: html-only part; add multipart/alternative if deliverability filters complain.
  const email = [
    `To: ${to}`,
    `Subject: ${subj}`,
    'Content-Type: text/html; charset=utf-8',
    '',
    textToHtml(body),
  ].join('\r\n')

  // btoa throws on non-Latin1; Buffer encodes UTF-8 (mirror of base64Decode).
  return Buffer.from(email, 'utf8').toString('base64url')
}

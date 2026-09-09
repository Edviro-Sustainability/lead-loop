import type { SupabaseClient } from '@supabase/supabase-js'
import { GoogleTokenError, refreshAccessToken } from './gmail'

interface GoogleEnv {
  GOOGLE_CLIENT_ID: string
  GOOGLE_CLIENT_SECRET: string
}

/**
 * Exchange a profile's stored refresh token for a Gmail access token.
 *
 * The one place Google's verdict on the stored token is acted on: when it
 * says the grant is dead (`invalid_grant`), the profile is disconnected
 * before the error propagates. Left in place, a dead token looks healthy
 * to every reader and gets retried forever; nulling it makes every caller
 * — cron sweep, queue consumer, MCP tools, dashboard — see "no
 * credentials" and stop, and lets Settings show the user why.
 */
export async function getAccessToken(
  supabase: SupabaseClient,
  env: GoogleEnv,
  userId: string,
  refreshToken: string
): Promise<string> {
  try {
    const { access_token } = await refreshAccessToken(
      env.GOOGLE_CLIENT_ID,
      env.GOOGLE_CLIENT_SECRET,
      refreshToken
    )
    return access_token
  } catch (err) {
    if (err instanceof GoogleTokenError && err.needsReauth) {
      await disconnectGmail(supabase, userId, err.message)
    }
    throw err
  }
}

/**
 * Drop the profile's Gmail credentials and record why. Cleared again by
 * the dashboard's auth callback when the user signs back in. Failing to
 * record the disconnect is logged, not thrown: the caller's original
 * Google error is the one worth surfacing.
 */
export async function disconnectGmail(
  supabase: SupabaseClient,
  userId: string,
  reason: string
): Promise<void> {
  const { error } = await supabase
    .from('profiles')
    .update({
      gmail_refresh_token: null,
      gmail_token_expires_at: null,
      gmail_auth_error: reason,
      gmail_auth_error_at: new Date().toISOString(),
    })
    .eq('id', userId)
  if (error) {
    console.error(`Failed to mark Gmail disconnected for user ${userId}: ${error.message}`)
  }
}

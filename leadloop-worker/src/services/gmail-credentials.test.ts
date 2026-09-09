import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { GoogleTokenError } from './gmail'
import { getAccessToken } from './gmail-credentials'

/**
 * The decision under test: which Google verdicts disconnect the profile.
 * Only a dead grant does — a misconfigured client or a Google outage must
 * leave the user's (still valid) token alone.
 */

const env = { GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'secret' }

interface ProfileUpdate {
  table: string
  patch: Record<string, unknown>
  filter: [string, unknown]
}

/** Minimal stand-in for `supabase.from(t).update(p).eq(c, v)`. */
function fakeSupabase(updates: ProfileUpdate[]) {
  return {
    from: (table: string) => ({
      update: (patch: Record<string, unknown>) => ({
        eq: async (column: string, value: unknown) => {
          updates.push({ table, patch, filter: [column, value] })
          return { error: null }
        },
      }),
    }),
  } as unknown as SupabaseClient
}

function stubGoogle(status: number, body: unknown) {
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify(body), { status }))
}

describe('getAccessToken', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('returns the access token and touches nothing on success', async () => {
    const updates: ProfileUpdate[] = []
    stubGoogle(200, { access_token: 'at-1', expires_in: 3599 })

    expect(await getAccessToken(fakeSupabase(updates), env, 'user-1', 'rt-1')).toBe('at-1')
    expect(updates).toEqual([])
  })

  it('disconnects the profile, with the reason, when Google says the grant is dead', async () => {
    const updates: ProfileUpdate[] = []
    stubGoogle(400, {
      error: 'invalid_grant',
      error_description: 'Token has been expired or revoked.',
    })

    await expect(getAccessToken(fakeSupabase(updates), env, 'user-1', 'rt-1')).rejects.toBeInstanceOf(
      GoogleTokenError
    )

    expect(updates).toHaveLength(1)
    const [{ table, patch, filter }] = updates
    expect(table).toBe('profiles')
    expect(filter).toEqual(['id', 'user-1'])
    expect(patch.gmail_refresh_token).toBeNull()
    expect(patch.gmail_token_expires_at).toBeNull()
    expect(patch.gmail_auth_error).toBe(
      'Token refresh failed (400 invalid_grant): Token has been expired or revoked.'
    )
    expect(typeof patch.gmail_auth_error_at).toBe('string')
  })

  it('keeps the token when the failure is ours (bad client credentials)', async () => {
    const updates: ProfileUpdate[] = []
    stubGoogle(401, { error: 'invalid_client', error_description: 'Unauthorized' })

    await expect(getAccessToken(fakeSupabase(updates), env, 'user-1', 'rt-1')).rejects.toThrow(
      'Token refresh failed (401 invalid_client): Unauthorized'
    )
    expect(updates).toEqual([])
  })

  it('keeps the token when Google itself is failing', async () => {
    const updates: ProfileUpdate[] = []
    stubGoogle(503, { error: 'internal_failure' })

    const err = await getAccessToken(fakeSupabase(updates), env, 'user-1', 'rt-1').catch((e) => e)
    expect(err).toBeInstanceOf(GoogleTokenError)
    expect((err as GoogleTokenError).retryable).toBe(true)
    expect(updates).toEqual([])
  })
})

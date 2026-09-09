-- Why a profile's Gmail is disconnected. The Worker sets both and nulls
-- gmail_refresh_token when Google rejects the stored refresh token with
-- invalid_grant (revoked, password change, or the 7-day expiry of OAuth
-- apps left in "Testing" publishing status). The dashboard shows the
-- reason and clears it on the next successful sign-in.
ALTER TABLE public.profiles
  ADD COLUMN gmail_auth_error TEXT,
  ADD COLUMN gmail_auth_error_at TIMESTAMPTZ;

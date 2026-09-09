import { ReconnectGmailButton } from "@/components/reconnect-gmail-button";

interface GmailDisconnectedBannerProps {
  /** Google's rejection, as recorded by the Worker (null if never connected). */
  reason: string | null;
  disconnectedAt: string | null;
}

/**
 * Shown on every dashboard page while the profile has no usable Gmail
 * refresh token. Follow-up drafting is paused in that state, and nothing
 * else in the UI would otherwise reveal it.
 */
export function GmailDisconnectedBanner({
  reason,
  disconnectedAt,
}: GmailDisconnectedBannerProps) {
  const when = disconnectedAt
    ? new Date(disconnectedAt).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : null;

  return (
    <div
      role="alert"
      className="flex items-center justify-between gap-4 border-b border-amber-200 bg-amber-50 px-6 py-2.5 text-amber-900"
    >
      <div className="min-w-0 text-sm">
        <span className="font-medium">Gmail is disconnected</span>
        <span> — follow-up drafting is paused until you sign in again.</span>
        {reason && (
          <p className="mt-0.5 truncate text-xs text-amber-800" title={reason}>
            {when ? `${when}: ` : ""}
            {reason}
          </p>
        )}
      </div>
      <ReconnectGmailButton />
    </div>
  );
}

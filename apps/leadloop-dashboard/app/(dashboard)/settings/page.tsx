import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { ReconnectGmailButton } from "@/components/reconnect-gmail-button";

export default async function SettingsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: profile } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user!.id)
    .single();

  const hasGmailToken = !!profile?.gmail_refresh_token;

  // Stats
  const { count: sequenceCount } = await supabase
    .from("sequences")
    .select("*", { count: "exact", head: true });
  const { count: runCount } = await supabase
    .from("watched_threads")
    .select("*", { count: "exact", head: true })
    .eq("status", "active");
  const { count: exampleCount } = await supabase
    .from("outreach_examples")
    .select("*", { count: "exact", head: true });

  return (
    <>
      <PageHeader title="Settings" />
      <div className="max-w-2xl space-y-8 p-6">
        <section className="space-y-4">
          <h2 className="text-sm font-semibold">Account</h2>
          <div className="rounded-lg border border-border p-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Email</span>
              <span className="text-sm font-medium">{user?.email}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Name</span>
              <span className="text-sm font-medium">
                {profile?.display_name || "—"}
              </span>
            </div>
          </div>
        </section>

        <section className="space-y-4">
          <h2 className="text-sm font-semibold">Gmail Connection</h2>
          <div className="rounded-lg border border-border p-4 space-y-3">
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="text-sm font-medium">
                  {hasGmailToken ? "Connected" : "Disconnected"}
                </p>
                <p className="text-xs text-muted-foreground">
                  {hasGmailToken
                    ? `Gmail access for ${profile?.gmail_email}`
                    : "Follow-up drafting is paused. Sign in with Google again to reconnect."}
                </p>
              </div>
              <div
                className={`h-2.5 w-2.5 shrink-0 rounded-full ${
                  hasGmailToken ? "bg-green-500" : "bg-amber-500"
                }`}
              />
            </div>
            {!hasGmailToken && (
              <>
                {profile?.gmail_auth_error && (
                  <div className="rounded-md bg-amber-50 p-3 text-xs text-amber-900">
                    <p className="font-medium">
                      Google rejected the stored token
                      {profile.gmail_auth_error_at
                        ? ` on ${new Date(profile.gmail_auth_error_at).toLocaleString()}`
                        : ""}
                      :
                    </p>
                    <p className="mt-1 break-words font-mono">
                      {profile.gmail_auth_error}
                    </p>
                    <p className="mt-2 text-amber-800">
                      If this says <code>invalid_grant</code> and happens every 7
                      days, the Google Cloud OAuth consent screen is still in
                      &quot;Testing&quot; — publish it (or make it Internal) so
                      refresh tokens stop expiring.
                    </p>
                  </div>
                )}
                <ReconnectGmailButton />
              </>
            )}
          </div>
        </section>

        <section className="space-y-4">
          <h2 className="text-sm font-semibold">Gmail Add-on</h2>
          <div className="rounded-lg border border-border p-4 space-y-3">
            <p className="text-sm text-muted-foreground">
              Install the LeadLoop Gmail add-on to start or stop sequence runs
              directly from Gmail.
            </p>
            <div className="rounded-md bg-muted p-3">
              <p className="mb-1 text-xs font-medium">Setup steps:</p>
              <ol className="list-inside list-decimal space-y-1 text-xs text-muted-foreground">
                <li>
                  Open the Apps Script project and deploy as a Gmail add-on
                </li>
                <li>
                  Set the Worker URL in Script Properties (key:{" "}
                  <code className="rounded bg-background px-1">WORKER_URL</code>
                  )
                </li>
                <li>
                  Open the add-on in Gmail and enter the Worker&apos;s{" "}
                  <code className="rounded bg-background px-1">ADDON_API_KEY</code>{" "}
                  secret when prompted (secrets can&apos;t be read back — rotate
                  with <code className="rounded bg-background px-1">npx wrangler secret put ADDON_API_KEY</code>{" "}
                  if lost)
                </li>
              </ol>
            </div>
          </div>
        </section>

        <section className="space-y-4">
          <h2 className="text-sm font-semibold">AI Agents (MCP)</h2>
          <div className="rounded-lg border border-border p-4 space-y-3">
            <p className="text-sm text-muted-foreground">
              Your agents write and send the personalized first email, then
              call <code className="rounded bg-muted px-1">start_sequence</code>{" "}
              with the lead&apos;s variables — LeadLoop drafts every follow-up
              from there. Add this to{" "}
              <code className="rounded bg-muted px-1">.cursor/mcp.json</code>{" "}
              (or your agent&apos;s MCP config):
            </p>
            <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs leading-relaxed">
              {JSON.stringify(
                {
                  mcpServers: {
                    leadloop: {
                      url: `${process.env.NEXT_PUBLIC_WORKER_URL}/mcp`,
                      headers: {
                        Authorization: "Bearer YOUR_MCP_API_KEY",
                        "X-User-Email": profile?.gmail_email ?? user?.email,
                      },
                    },
                  },
                },
                null,
                2
              )}
            </pre>
            <p className="text-xs text-muted-foreground">
              The key is the Worker&apos;s <code className="rounded bg-background px-1">MCP_API_KEY</code>{" "}
              secret (<code className="rounded bg-background px-1">npx wrangler secret put MCP_API_KEY</code>).
              Verify by asking the agent to run{" "}
              <code className="rounded bg-background px-1">list_sequences</code>.
            </p>
          </div>
        </section>

        <section className="space-y-4">
          <h2 className="text-sm font-semibold">Usage</h2>
          <div className="grid grid-cols-3 gap-3">
            {[
              { label: "Sequences", count: sequenceCount ?? 0 },
              { label: "Active Runs", count: runCount ?? 0 },
              { label: "Examples", count: exampleCount ?? 0 },
            ].map((stat) => (
              <div
                key={stat.label}
                className="rounded-lg border border-border p-3 text-center"
              >
                <p className="text-2xl font-bold">{stat.count}</p>
                <p className="text-xs text-muted-foreground">{stat.label}</p>
              </div>
            ))}
          </div>
        </section>
      </div>
    </>
  );
}

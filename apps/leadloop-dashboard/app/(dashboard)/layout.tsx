import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Sidebar } from "@/components/sidebar";
import { UserNav } from "@/components/user-nav";
import { GmailDisconnectedBanner } from "@/components/gmail-disconnected-banner";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select(
      "display_name, gmail_email, gmail_refresh_token, gmail_auth_error, gmail_auth_error_at"
    )
    .eq("id", user.id)
    .single();

  // Server-side only: the token never reaches the client, just this boolean.
  const gmailConnected = !!profile?.gmail_refresh_token;

  return (
    <div className="flex h-full">
      <Sidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <header className="flex h-14 items-center justify-end border-b border-border px-6">
          <UserNav
            email={user.email ?? ""}
            displayName={profile?.display_name ?? null}
          />
        </header>
        {!gmailConnected && (
          <GmailDisconnectedBanner
            reason={profile?.gmail_auth_error ?? null}
            disconnectedAt={profile?.gmail_auth_error_at ?? null}
          />
        )}
        <main className="flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}

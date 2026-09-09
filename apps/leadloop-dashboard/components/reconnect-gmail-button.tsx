"use client";

import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Re-run the Google sign-in. The login page requests consent again, so
 * Google issues a fresh refresh token, which the auth callback stores.
 */
export function ReconnectGmailButton({ className }: { className?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function handleReconnect() {
    setBusy(true);
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <button
      onClick={handleReconnect}
      disabled={busy}
      className={
        className ??
        "rounded-md bg-amber-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-amber-700 disabled:opacity-50"
      }
    >
      {busy ? "Redirecting..." : "Reconnect Gmail"}
    </button>
  );
}

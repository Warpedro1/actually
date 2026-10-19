import { AdminShell } from "@/components/staff/Shells";
import { requireMfa } from "@/lib/server/staff";

// Lê REQUIRE_MFA em runtime.
export const dynamic = "force-dynamic";

export default function AdminPage() {
  return <AdminShell requireMfa={requireMfa()} />;
}

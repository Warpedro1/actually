import { EditorShell } from "@/components/staff/Shells";
import { requireMfa } from "@/lib/server/staff";

// Lê REQUIRE_MFA em runtime.
export const dynamic = "force-dynamic";

export default function EditorPage() {
  return <EditorShell requireMfa={requireMfa()} />;
}

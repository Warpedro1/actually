import type { Metadata } from "next";
import { MachinesDemo } from "@/components/staff/MachinesDemo";

export const metadata: Metadata = { title: "Máquinas (demonstração)" };

/** Painel de máquinas com fixtures — para conferir o layout sem Supabase. */
export default function AdminDemoPage() {
  return <MachinesDemo />;
}

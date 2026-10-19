import type { Metadata } from "next";
import { SecurityApp } from "@/components/staff/SecurityApp";
import { requireMfa } from "@/lib/server/staff";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Segurança" };

export default function SegurancaPage() {
  return <SecurityApp requireMfa={requireMfa()} />;
}

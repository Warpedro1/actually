import type { Metadata } from "next";
import { DemoDebate } from "@/components/live/DemoDebate";

export const metadata: Metadata = {
  title: "Demonstração",
  robots: { index: false, follow: false },
};

/** Modo demonstração: fixtures locais + simulador, sem Supabase. */
export default function DemoPage() {
  return <DemoDebate />;
}

import type { ReactNode } from "react";
import { DisclaimerGate } from "@/components/DisclaimerGate";

/** Toda página /ao-vivo passa pelo aviso jurídico. */
export default function LiveLayout({ children }: { children: ReactNode }) {
  return <DisclaimerGate>{children}</DisclaimerGate>;
}

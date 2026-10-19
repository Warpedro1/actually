"use client";

import { MfaManager } from "./Mfa";
import { StaffGate } from "./StaffGate";

export function SecurityApp({ requireMfa }: { requireMfa: boolean }) {
  return (
    <StaffGate requireMfa={requireMfa} allowWithoutEditor>
      {({ client }) => <MfaManager client={client} requireMfa={requireMfa} />}
    </StaffGate>
  );
}

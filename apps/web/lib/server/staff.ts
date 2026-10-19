import "server-only";

/** REQUIRE_MFA=1 → /editor e /admin exigem sessão aal2 (TOTP verificado). Lido em runtime. */
export function requireMfa(): boolean {
  return process.env.REQUIRE_MFA === "1";
}

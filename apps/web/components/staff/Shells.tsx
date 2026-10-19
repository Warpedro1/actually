"use client";

import { AdminApp } from "./AdminApp";
import { EditorApp } from "./EditorApp";
import { StaffGate } from "./StaffGate";

// Componentes cliente que ligam a porta de acesso a cada área (o render-prop
// não atravessa a fronteira servidor→cliente, então fica aqui).

export function EditorShell({ requireMfa }: { requireMfa: boolean }) {
  return <StaffGate requireMfa={requireMfa}>{(ctx) => <EditorApp client={ctx.client} user={ctx.user} />}</StaffGate>;
}

export function AdminShell({ requireMfa }: { requireMfa: boolean }) {
  return <StaffGate requireMfa={requireMfa}>{(ctx) => <AdminApp client={ctx.client} />}</StaffGate>;
}

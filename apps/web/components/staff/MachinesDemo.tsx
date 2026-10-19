"use client";

import type { CaptureMachine, MachineDesired } from "@actually/db";
import { useEffect, useState } from "react";
import { demoAdminData } from "@/lib/demo/fixtures";
import { MachinesPanel } from "./MachinesPanel";
import { useNow } from "./useStaffData";

/** /admin/demo: painel de máquinas com dados fictícios; comandos só mudam o estado local. */
export function MachinesDemo() {
  const now = useNow(1000);
  // Fixtures ancoradas no carregamento (só no navegador: idades dependem do relógio
  // e divergiriam entre SSR e hidratação); o relógio corre e as idades crescem.
  const [data, setData] = useState<ReturnType<typeof demoAdminData> | null>(null);
  useEffect(() => setData(demoAdminData(Date.now())), []);

  async function onSaveDesired(machineId: string, desired: MachineDesired) {
    setData((d) => d && ({
      ...d,
      machines: d.machines.map((m): CaptureMachine =>
        m.id === machineId ? { ...m, desired, desired_updated_at: new Date().toISOString() } : m,
      ),
    }));
    return null;
  }

  async function onSetActive(agentId: string) {
    setData((d) => d && { ...d, agents: d.agents.map((a) => ({ ...a, active: a.id === agentId })) });
    return null;
  }

  if (!data) return <p className="mx-auto max-w-6xl px-4 py-4 text-sm text-muted">Carregando…</p>;

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-4">
      <div className="rounded-lg border border-dashed border-border bg-surface px-3 py-2 text-xs text-muted">
        <strong className="uppercase tracking-wide text-fg">Demonstração</strong> — máquinas e estados fictícios; os
        botões só alteram esta tela.
      </div>
      <MachinesPanel
        machines={data.machines}
        agents={data.agents}
        debates={[data.debate]}
        defaultDebateSlug={data.debate.slug}
        failoverAfterS={10}
        now={now}
        realtime="demo"
        onSaveDesired={onSaveDesired}
        onSetActive={onSetActive}
      />
    </div>
  );
}

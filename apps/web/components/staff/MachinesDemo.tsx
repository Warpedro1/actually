"use client";

import type { CaptureMachine, MachineDesired } from "@actually/db";
import { useEffect, useState } from "react";
import { demoAdminData } from "@/lib/demo/fixtures";
import { AdminTabs, useAdminTab } from "./AdminTabs";
import { ApiUsageDemo } from "./ApiUsageDemo";
import { KbDemo } from "./KbDemo";
import { MachinesPanel } from "./MachinesPanel";
import { useNow } from "./useStaffData";

const TABS = [
  { id: "ao-vivo", label: "Ao vivo" },
  { id: "base", label: "Base de conhecimento" },
  { id: "uso", label: "Uso das APIs" },
] as const;
type TabId = (typeof TABS)[number]["id"];
const TAB_IDS: readonly TabId[] = TABS.map((t) => t.id);

/** /admin/demo: abas do /admin com dados fictícios; comandos só mudam o estado local. */
export function MachinesDemo() {
  const now = useNow(1000);
  const [tab, setTab] = useAdminTab(TAB_IDS, "actually:admin-demo-tab");
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

  async function onRemoveAgent(agentId: string) {
    setData((d) => d && { ...d, agents: d.agents.filter((a) => a.id !== agentId) });
    return null;
  }

  if (!data) return <p className="mx-auto max-w-6xl px-4 py-4 text-sm text-muted">Carregando…</p>;

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-4">
      <div className="rounded-lg border border-dashed border-border bg-surface px-3 py-2 text-xs text-muted">
        <strong className="uppercase tracking-wide text-fg">Demonstração</strong> — máquinas, base, uso das APIs e estados fictícios; os
        botões só alteram esta tela.
      </div>
      <AdminTabs tabs={TABS} active={tab} onSelect={setTab} label="Seções do admin">
        {tab === "ao-vivo" ? (
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
            onRemoveAgent={onRemoveAgent}
          />
        ) : tab === "base" ? (
          <KbDemo />
        ) : (
          <ApiUsageDemo />
        )}
      </AdminTabs>
    </div>
  );
}

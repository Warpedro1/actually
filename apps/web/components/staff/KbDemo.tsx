"use client";

import { useEffect, useState } from "react";
import { demoKbStatus } from "@/lib/demo/fixtures";
import type { KbStatus } from "@/lib/staff/kb";
import { KbPanelView } from "./KbPanel";
import { useNow } from "./useStaffData";

/** /admin/demo: painel da base com dados fictícios; os botões não pedem nada ao servidor. */
export function KbDemo() {
  const now = useNow(5000);
  const [status, setStatus] = useState<KbStatus | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  useEffect(() => setStatus(demoKbStatus(Date.now())), []);
  return (
    <KbPanelView
      status={status}
      error={null}
      ok={ok}
      busy={false}
      now={now}
      onRefresh={() => setStatus(demoKbStatus(Date.now()))}
      onStart={(r) => setOk(`Demonstração: pediria "${r.preset}" (nada foi enviado).`)}
      onCancel={() => setOk("Demonstração: cancelaria a tarefa (nada foi enviado).")}
    />
  );
}

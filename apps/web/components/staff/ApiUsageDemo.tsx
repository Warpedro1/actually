"use client";

import { useEffect, useState } from "react";
import { demoUsageReport } from "@/lib/demo/fixtures";
import type { UsageReport } from "@/lib/staff/usage";
import { ApiUsagePanelView } from "./ApiUsagePanel";
import { useNow } from "./useStaffData";

/** /admin/demo: painel de uso com números fictícios; Atualizar não consulta nenhum provedor. */
export function ApiUsageDemo() {
  const now = useNow(5000);
  const [report, setReport] = useState<UsageReport | null>(null);
  useEffect(() => setReport(demoUsageReport(Date.now())), []);
  return <ApiUsagePanelView report={report} error={null} busy={false} now={now} onRefresh={() => setReport(demoUsageReport(Date.now()))} />;
}

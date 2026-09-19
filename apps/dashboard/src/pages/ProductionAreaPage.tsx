import { useParams } from "react-router-dom";
import { ProductionPage } from "./ProductionPage";

/**
 * Production area (Run 11 §66): exact current ProductionPageInput
 * identity/version/digest, current candidates and candidate state. Existing
 * Run 9 production actions remain; no deployment actions exist here.
 */
export function ProductionAreaPage() {
  const { projectId } = useParams<{ projectId: string }>();
  if (!projectId) return null;
  return <ProductionPage projectId={projectId} />;
}

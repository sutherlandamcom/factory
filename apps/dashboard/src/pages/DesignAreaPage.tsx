import { useParams } from "react-router-dom";
import { DesignPage } from "./DesignPage";

/**
 * Design area (Run 11 §65): DesignProvider runs, Stitch evidence, accepted
 * design authority, staleness and approval. The distinct evidence concepts
 * (providerConsumed, source-byte consumption) are preserved exactly as the
 * Run 6/7 backend reports them.
 */
export function DesignAreaPage() {
  const { projectId } = useParams<{ projectId: string }>();
  if (!projectId) return null;
  return <DesignPage projectId={projectId} />;
}

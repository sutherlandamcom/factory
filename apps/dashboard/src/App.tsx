import { useEffect } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { ProjectsPage } from "./pages/ProjectsPage";
import { ProjectWorkspaceLayout } from "./layouts/ProjectWorkspaceLayout";
import { OverviewPage } from "./pages/OverviewPage";
import { IntakePage } from "./pages/IntakePage";
import { ResearchPage } from "./pages/ResearchPage";
import { ContentAreaPage } from "./pages/ContentAreaPage";
import { AssetsAreaPage } from "./pages/AssetsAreaPage";
import { DesignAreaPage } from "./pages/DesignAreaPage";
import { ProductionAreaPage } from "./pages/ProductionAreaPage";
import { QaPage } from "./pages/QaPage";
import { VersionsPage } from "./pages/VersionsPage";
import { CostsPage } from "./pages/CostsPage";
import { DeploymentPage } from "./pages/DeploymentPage";

/**
 * Run 11 URL-addressable operator information architecture (§47).
 * Every area is a deep-linkable route; router state is navigation only,
 * never business authority (§103).
 */
export default function App() {
  const location = useLocation();

  // Restore the last visited project on cold start (deep-link UX without
  // making the URL or cache an authority).
  useEffect(() => {
    if (location.pathname === "/") {
      const last = localStorage.getItem("factory:lastProjectId");
      if (last) {
        // Handled by ProjectsPage via the same key; nothing to do here.
      }
    }
  }, [location.pathname]);

  return (
    <Routes>
      <Route path="/" element={<ProjectsPage />} />
      <Route path="/projects" element={<ProjectsPage />} />
      <Route path="/projects/:projectId" element={<ProjectWorkspaceLayout />}>
        <Route index element={<Navigate to="overview" replace />} />
        <Route path="overview" element={<OverviewPage />} />
        <Route path="intake" element={<IntakePage />} />
        <Route path="research" element={<ResearchPage />} />
        <Route path="content" element={<ContentAreaPage />} />
        <Route path="assets" element={<AssetsAreaPage />} />
        <Route path="design" element={<DesignAreaPage />} />
        <Route path="production" element={<ProductionAreaPage />} />
        <Route path="qa" element={<QaPage />} />
        <Route path="versions" element={<VersionsPage />} />
        <Route path="costs" element={<CostsPage />} />
        <Route path="deployment" element={<DeploymentPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

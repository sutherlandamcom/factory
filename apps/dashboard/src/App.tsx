import { useState, useEffect, useCallback } from "react";
import { api } from "./api/client";
import type { ProjectSummary } from "./api/types";
import { usePolling } from "./hooks/usePolling";
import { ProjectsPage } from "./pages/ProjectsPage";
import { ProjectDetailPage } from "./pages/ProjectDetailPage";

export default function App() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [view, setView] = useState<"projects" | "detail">("projects");

  const loadProjects = useCallback(async () => {
    try {
      const data = await api.listProjects();
      setProjects(data.projects);
    } catch {
      // API may not be up yet; keep previous state
    }
  }, []);

  usePolling(loadProjects, 5000);
  useEffect(() => { loadProjects(); }, [loadProjects]);

  if (view === "detail" && activeId) {
    return <ProjectDetailPage projectId={activeId} onBack={() => setView("projects")} />;
  }

  return (
    <ProjectsPage
      projects={projects}
      onOpenProject={(p) => { setActiveId(p.id); setView("detail"); }}
    />
  );
}

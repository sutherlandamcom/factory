import { useState } from "react";
import { api, OperatorApiError } from "../api/client";
import type { ProjectSummary } from "../api/types";
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "../query/keys";
import { useNavigate } from "react-router-dom";

/**
 * Projects list (Run 11 root route). TanStack Query owns the server state;
 * the 5-second manual polling loop is gone.
 */
export function ProjectsPage() {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);

  const projectsQuery = useQuery({
    queryKey: queryKeys.projects,
    queryFn: () => api.listProjects(),
    // The list may briefly fail while the operator server starts; keep the
    // previous data instead of blanking the page.
    retry: 2,
  });

  const projects = projectsQuery.data?.projects ?? [];

  const openProject = (project: ProjectSummary) => {
    localStorage.setItem("factory:lastProjectId", project.id);
    navigate(`/projects/${encodeURIComponent(project.id)}/overview`);
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newKey.trim() || !newName.trim()) return;
    try {
      setCreating(true);
      const created = await api.createProject({ key: newKey.trim(), name: newName.trim() });
      setShowNew(false);
      setNewKey("");
      setNewName("");
      openProject(created);
    } catch (err) {
      setError(err instanceof OperatorApiError ? err.message : "Failed to create project");
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="mx-auto max-w-5xl p-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Projects</h1>
        <button
          onClick={() => setShowNew(true)}
          className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
        >
          New Project
        </button>
      </div>

      {error && <div className="mb-4 rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</div>}

      {showNew && (
        <form onSubmit={handleCreate} className="mb-6 rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor="project-key" className="mb-1 block text-sm font-medium text-gray-700">Key</label>
              <input
                id="project-key"
                value={newKey}
                onChange={(e) => setNewKey(e.target.value)}
                placeholder="e.g. summit-roofing"
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
              />
            </div>
            <div>
              <label htmlFor="project-name" className="mb-1 block text-sm font-medium text-gray-700">Name</label>
              <input
                id="project-name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g. Summit Roofing"
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
              />
            </div>
          </div>
          <div className="mt-4 flex gap-2">
            <button
              type="submit"
              disabled={creating || !newKey.trim() || !newName.trim()}
              className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {creating ? "Creating…" : "Create"}
            </button>
            <button
              type="button"
              onClick={() => setShowNew(false)}
              className="rounded-md border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {projectsQuery.isLoading && <p className="text-gray-500">Loading…</p>}
      {projectsQuery.isError && (
        <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">
          Could not load projects. The operator service may be starting — retrying automatically.
        </div>
      )}

      <div className="space-y-3">
        {projects.map((p) => (
          <button
            key={p.id}
            onClick={() => openProject(p)}
            className="block w-full rounded-lg border border-gray-200 bg-white p-4 text-left shadow-sm hover:border-indigo-300 hover:bg-indigo-50"
          >
            <div className="flex items-center justify-between">
              <div>
                <div className="font-semibold text-gray-900">{p.name}</div>
                <div className="text-sm text-gray-500">{p.key}</div>
              </div>
              <div className="text-xs text-gray-400">{new Date(p.createdAt).toLocaleString()}</div>
            </div>
          </button>
        ))}
        {!projectsQuery.isLoading && projects.length === 0 && !projectsQuery.isError && (
          <p className="text-gray-500">No projects yet. Create one to start the operator workflow.</p>
        )}
      </div>
    </div>
  );
}

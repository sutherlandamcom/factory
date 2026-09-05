import { useState } from "react";
import { api } from "../api/client";
import type { ProjectSummary } from "../api/types";

interface ProjectsPageProps {
  projects: ProjectSummary[];
  onOpenProject: (project: ProjectSummary) => void;
}

export function ProjectsPage({ projects, onOpenProject }: ProjectsPageProps) {
  const [error, setError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newKey.trim() || !newName.trim()) return;
    try {
      setCreating(true);
      const created = await api.createProject({ key: newKey.trim(), name: newName.trim() });
      setShowNew(false);
      setNewKey("");
      setNewName("");
      onOpenProject(created);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create project");
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
              <label htmlFor="project-name" className="mb-1 block text-sm font-medium text-gray-700">Display Name</label>
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
              className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {projects.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 bg-white p-12 text-center text-gray-500">
          No projects yet. Create your first project to get started.
        </div>
      ) : (
        <div className="space-y-3">
          {projects.map((p) => (
            <button
              key={p.id}
              onClick={() => onOpenProject(p)}
              className="w-full rounded-lg border border-gray-200 bg-white p-4 text-left shadow-sm transition hover:border-indigo-300 hover:shadow"
            >
              <div className="font-medium text-gray-900">{p.name}</div>
              <div className="text-sm text-gray-500">{p.key}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

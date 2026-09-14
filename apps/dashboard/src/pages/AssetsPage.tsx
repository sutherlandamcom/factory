import { useState, useEffect, useCallback, useRef } from "react";
import { assetsApi, OperatorApiError, type AssetsWorkspace, type AssetVersionView, type AssetAssignmentView } from "../api/client";
import { usePolling } from "../hooks/usePolling";

/**
 * Asset Library (Macro Run 5) — thin operator surface over the governed
 * asset application service. All governance (approval, rights gating,
 * assignment, replacement) is enforced server-side; this view only reflects
 * authoritative state and collects explicit operator actions.
 */

const ASSET_ERROR_COPY: Record<string, string> = {
  asset_upload_invalid: "Upload rejected: the file is not a supported, decodable image (JPEG/PNG/WebP) or exceeds limits.",
  asset_not_found: "Asset not found in this project.",
  asset_version_not_found: "Asset version not found in this project.",
  asset_assignment_not_found: "Assignment not found in this project.",
  asset_approval_failed: "Approval rejected: the digest you confirmed does not match the stored version.",
  asset_version_immutable: "Approved/rejected versions are immutable; upload a new version instead.",
  asset_rights_blocked: "Blocked: only APPROVED versions with resolved rights (not unknown) can be assigned.",
  asset_assignment_conflict: "Slot conflict: use explicit replacement to move an existing assignment.",
  asset_storage_failed: "Asset storage failed server-side; nothing was accepted.",
  validation_error: "Invalid input; check the form fields.",
};

function assetErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof OperatorApiError) {
    return ASSET_ERROR_COPY[error.code] ?? error.message ?? fallback;
  }
  return error instanceof Error ? error.message : fallback;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function shortDigest(digest: string): string {
  return digest.length > 12 ? `${digest.slice(0, 12)}…` : digest;
}

function ApprovalBadge({ state }: { state: string }) {
  const style =
    state === "approved"
      ? "bg-green-100 text-green-800 border-green-300"
      : state === "rejected"
        ? "bg-red-100 text-red-800 border-red-300"
        : "bg-amber-100 text-amber-800 border-amber-300";
  return <span className={`inline-block rounded border px-2 py-0.5 text-xs font-medium ${style}`}>{state}</span>;
}

function RightsBadge({ status }: { status: string }) {
  const unresolved = status === "unknown";
  const style = unresolved
    ? "bg-red-100 text-red-800 border-red-300"
    : "bg-blue-100 text-blue-800 border-blue-300";
  return (
    <span className={`inline-block rounded border px-2 py-0.5 text-xs font-medium ${style}`}>
      rights: {status}
      {unresolved ? " (unresolved)" : ""}
    </span>
  );
}

export function AssetsPage({ projectId }: { projectId: string }) {
  const [ws, setWs] = useState<AssetsWorkspace | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadForm, setUploadForm] = useState({ title: "", altIntent: "", rightsStatus: "operator_owned", rightsNote: "" });
  const [assignForm, setAssignForm] = useState<{ versionId: string; pageSlug: string; role: string } | null>(null);
  const [replaceForm, setReplaceForm] = useState<{ assignmentId: string; toVersionId: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadWorkspace = useCallback(async () => {
    try {
      setWs(await assetsApi.workspace(projectId));
    } catch (e) {
      setError(assetErrorMessage(e, "Asset workspace failed to load."));
    }
  }, [projectId]);

  useEffect(() => {
    loadWorkspace();
  }, [loadWorkspace]);
  usePolling(loadWorkspace, 10000);

  const run = async (action: () => Promise<string | void>, fallback: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const message = await action();
      if (typeof message === "string") setNotice(message);
      await loadWorkspace();
    } catch (e) {
      setError(assetErrorMessage(e, fallback));
    } finally {
      setBusy(false);
    }
  };

  const handleUpload = () => {
    const file = fileInputRef.current?.files?.[0];
    if (!file) {
      setError("Choose an image file first.");
      return;
    }
    void run(async () => {
      setUploading(true);
      try {
        const dataBase64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => {
            const result = String(reader.result ?? "");
            const commaIndex = result.indexOf(",");
            resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
          };
          reader.onerror = () => reject(new Error("Could not read the selected file."));
          reader.readAsDataURL(file);
        });
        const result = await assetsApi.upload(projectId, {
          dataBase64,
          filename: file.name,
          kind: "photo",
          title: uploadForm.title.trim() || file.name,
          rightsStatus: uploadForm.rightsStatus,
          rightsNote: uploadForm.rightsNote.trim() || undefined,
          altIntent: uploadForm.altIntent.trim() || undefined,
        });
        if (fileInputRef.current) fileInputRef.current.value = "";
        return `Uploaded v${result.version} (${result.mediaType}, ${formatBytes(result.byteSize)}, ${result.width}x${result.height}); digest ${shortDigest(result.binaryDigest)}`;
      } finally {
        setUploading(false);
      }
    }, "Upload failed.");
  };

  const approve = (version: AssetVersionView) =>
    run(async () => {
      await assetsApi.approve(projectId, version.id, version.binaryDigest);
      return `Version v${version.version} approved and immutable (digest ${shortDigest(version.binaryDigest)}).`;
    }, "Approval failed.");

  const reject = (version: AssetVersionView) =>
    run(async () => {
      await assetsApi.reject(projectId, version.id, version.binaryDigest);
      return `Version v${version.version} rejected.`;
    }, "Rejection failed.");

  const saveMetadata = (version: AssetVersionView) =>
    run(async () => {
      await assetsApi.updateMetadata(projectId, version.id, {
        rightsStatus: uploadForm.rightsStatus,
        rightsNote: uploadForm.rightsNote.trim() || undefined,
        altIntent: uploadForm.altIntent.trim() || undefined,
        expectedBinaryDigest: version.binaryDigest,
      });
      return `Metadata saved for v${version.version} (pre-approval only).`;
    }, "Metadata update failed.");

  const assign = () => {
    if (!assignForm) return;
    const version = findVersion(assignForm.versionId);
    if (!version) return;
    void run(async () => {
      const acceptedPage = ws?.acceptedPages.find(p => p.slug === assignForm.pageSlug);
      if (!acceptedPage || !version.governanceDigest) throw new Error("Select a current accepted page and approved asset.");
      await assetsApi.assign(projectId, {
        acceptedPageContentId: acceptedPage.id,
        acceptedPageContentVersion: acceptedPage.version,
        acceptedPageContentDigest: acceptedPage.contentDigest,
        expectedGovernanceDigest: version.governanceDigest,
        assetId: version.assetId,
        versionId: version.id,
        pageSlug: assignForm.pageSlug.trim(),
        role: assignForm.role,
        expectedBinaryDigest: version.binaryDigest,
      });
      setAssignForm(null);
      return `Assigned v${version.version} to ${assignForm.pageSlug}/${assignForm.role}.`;
    }, "Assignment failed.");
  };

  const replace = () => {
    if (!replaceForm) return;
    const version = findVersion(replaceForm.toVersionId);
    if (!version) return;
    void run(async () => {
      const assignment = ws?.assignments.find(a => a.id === replaceForm.assignmentId);
      const page = ws?.acceptedPages.find(p => p.slug === assignment?.pageSlug);
      if (!page) throw new Error("Replacement requires a current accepted page.");
      await assetsApi.replace(projectId, replaceForm.assignmentId, {
        pageAuthority: page,
        toVersionId: version.id,
        expectedBinaryDigest: version.binaryDigest,
      });
      setReplaceForm(null);
      return `Assignment explicitly moved to v${version.version}.`;
    }, "Replacement failed.");
  };

  const findVersion = (versionId: string): AssetVersionView | null => {
    for (const asset of ws?.assets ?? []) {
      const found = asset.versions.find((v) => v.id === versionId);
      if (found) return found;
    }
    return null;
  };

  const assets = ws?.assets ?? [];
  const assignments = ws?.assignments ?? [];

  return (
    <div>
      <h2 className="text-lg font-bold mb-3">Asset Library</h2>
      {error && <div className="mb-3 rounded-md bg-red-50 border border-red-300 p-3 text-sm text-red-800">{error}</div>}
      {notice && <div className="mb-3 rounded-md bg-green-50 border border-green-300 p-3 text-sm text-green-800">{notice}</div>}

      {/* Imagery strategy */}
      <div className="mb-4 flex items-center gap-2 text-sm">
        <span className="text-gray-600">Imagery strategy:</span>
        <select
          value={ws?.imageryStrategy ?? "none"}
          onChange={(e) => void run(async () => { await assetsApi.setImageryStrategy(projectId, e.target.value); }, "Could not save strategy.")}
          disabled={busy}
          className="rounded border border-gray-300 px-2 py-1 text-sm"
          aria-label="Imagery strategy"
        >
          <option value="none">none</option>
          <option value="operator">operator</option>
        </select>
        <span className="text-xs text-gray-400">(generated/mixed activate in later runs)</span>
      </div>

      {/* Upload */}
      <div className="mb-6 rounded-lg border border-gray-200 p-4">
        <div className="text-sm font-semibold mb-2">Upload photograph</div>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-xs text-gray-600 mb-1" htmlFor="asset-file">Image file (JPEG/PNG/WebP)</label>
            <input id="asset-file" ref={fileInputRef} type="file" accept="image/jpeg,image/png,image/webp" className="text-sm" />
          </div>
          <div>
            <label className="block text-xs text-gray-600 mb-1" htmlFor="asset-title">Title</label>
            <input
              id="asset-title"
              value={uploadForm.title}
              onChange={(e) => setUploadForm((f) => ({ ...f, title: e.target.value }))}
              placeholder="Chamonix homepage hero photograph"
              className="rounded border border-gray-300 px-2 py-1 text-sm w-64"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-600 mb-1" htmlFor="asset-rights">Rights</label>
            <select
              id="asset-rights"
              value={uploadForm.rightsStatus}
              onChange={(e) => setUploadForm((f) => ({ ...f, rightsStatus: e.target.value }))}
              className="rounded border border-gray-300 px-2 py-1 text-sm"
            >
              <option value="operator_owned">operator_owned</option>
              <option value="licensed">licensed</option>
              <option value="public_domain">public_domain</option>
              <option value="unknown">unknown</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-600 mb-1" htmlFor="asset-rights-note">Rights note</label>
            <input
              id="asset-rights-note"
              value={uploadForm.rightsNote}
              onChange={(e) => setUploadForm((f) => ({ ...f, rightsNote: e.target.value }))}
              placeholder="e.g. taken by operator, 2026-08"
              className="rounded border border-gray-300 px-2 py-1 text-sm w-56"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-600 mb-1" htmlFor="asset-alt">Alt intent</label>
            <input
              id="asset-alt"
              value={uploadForm.altIntent}
              onChange={(e) => setUploadForm((f) => ({ ...f, altIntent: e.target.value }))}
              placeholder="Describe the intended image meaning"
              className="rounded border border-gray-300 px-2 py-1 text-sm w-64"
            />
          </div>
          <button
            onClick={handleUpload}
            disabled={busy || uploading}
            className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {uploading ? "Uploading…" : "Upload"}
          </button>
        </div>
        <div className="mt-2 text-xs text-gray-500">
          The server inspects the actual bytes; unsupported, spoofed, corrupt or oversized files are rejected.
        </div>
      </div>

      {/* Assets */}
      {assets.length === 0 && <div className="text-sm text-gray-500 mb-6">No assets uploaded yet.</div>}
      {assets.map((asset) => (
        <div key={asset.id} className="mb-6 rounded-lg border border-gray-200 p-4">
          <div className="flex items-center gap-2 mb-3">
            <div className="font-semibold">{asset.title}</div>
            <span className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-700">{asset.kind}</span>
          </div>
          {asset.versions.map((version) => {
            const webDerivative = asset.latestVersion === version ? undefined : undefined;
            void webDerivative;
            return (
              <div key={version.id} className="mb-4 rounded border border-gray-100 p-3">
                <div className="flex flex-wrap items-center gap-2 mb-2">
                  <span className="font-medium text-sm">v{version.version}</span>
                  <ApprovalBadge state={version.approvalState} />
                  <RightsBadge status={version.rightsStatus} />
                  <span className="text-xs text-gray-500">
                    {version.mediaType} · {formatBytes(version.byteSize)} · {version.width}x{version.height}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-4 mb-2">
                  <img
                    src={assetsApi.originalUrl(projectId, version.id)}
                    alt={version.altIntent || `Asset v${version.version} preview`}
                    className="h-24 w-auto rounded border border-gray-200 bg-gray-50"
                  />
                  <div className="text-xs text-gray-600 font-mono">
                    <div>digest: {shortDigest(version.binaryDigest)}</div>
                    <div>governance: {version.governanceDigest ? shortDigest(version.governanceDigest) : "—"}</div>
                    <div>
                      provenance: {version.provenance.category} · {version.provenance.originalFilename} ·{" "}
                      {new Date(version.provenance.uploadedAt).toLocaleString()}
                    </div>
                    {version.altIntent && <div>alt intent: {version.altIntent}</div>}
                    {version.rightsNote && <div>rights note: {version.rightsNote}</div>}
                  </div>
                </div>
                {version.approvalState === "pending" && (
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() => void approve(version)}
                      disabled={busy}
                      className="rounded-md bg-green-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-800 disabled:opacity-50"
                    >
                      Approve exact digest
                    </button>
                    <button
                      onClick={() => void reject(version)}
                      disabled={busy}
                      className="rounded-md bg-red-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-800 disabled:opacity-50"
                    >
                      Reject
                    </button>
                    <button
                      onClick={() => void saveMetadata(version)}
                      disabled={busy}
                      className="rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                    >
                      Save rights/alt to this version
                    </button>
                  </div>
                )}
                {version.approvalState === "approved" && version.rightsStatus !== "unknown" && (
                  <div className="flex flex-wrap items-end gap-2">
                    <div>
                      <label className="block text-xs text-gray-600 mb-1">Page slug</label>
                      <select
                        aria-label="Accepted page"
                        value={assignForm?.versionId === version.id ? assignForm.pageSlug : ""}
                        onChange={(e) => setAssignForm({ versionId: version.id, pageSlug: e.target.value, role: assignForm?.role ?? "hero" })}
                        className="rounded border border-gray-300 px-2 py-1 text-sm w-40"
                      >
                        <option value="">Select accepted page</option>
                        {ws?.acceptedPages.map(p => <option key={p.id} value={p.slug}>{p.slug} · v{p.version}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs text-gray-600 mb-1">Slot/role</label>
                      <select
                        aria-label="Slot/role"
                        value={assignForm?.versionId === version.id ? assignForm.role : "hero"}
                        onChange={(e) => setAssignForm({ versionId: version.id, pageSlug: assignForm?.versionId === version.id ? assignForm.pageSlug : "", role: e.target.value })}
                        className="rounded border border-gray-300 px-2 py-1 text-sm"
                      >
                        <option value="hero">hero</option>
                        <option value="background">background</option>
                        <option value="inline">inline</option>
                        <option value="chart">chart</option>
                        <option value="illustration">illustration</option>
                        <option value="logo">logo</option>
                        <option value="supporting">supporting</option>
                      </select>
                    </div>
                    <button
                      onClick={assign}
                      disabled={busy}
                      className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
                    >
                      Assign to page slot
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ))}

      {/* Assignments */}
      <h3 className="text-md font-bold mb-2">Page assignments</h3>
      {assignments.length === 0 && <div className="text-sm text-gray-500 mb-4">No page assignments yet.</div>}
      {assignments.map((assignment: AssetAssignmentView) => (
        <div
          key={assignment.id}
          className={`mb-3 rounded-lg border p-3 text-sm ${assignment.replacementAvailable ? "border-amber-300 bg-amber-50" : "border-gray-200 bg-white"}`}
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">
              {assignment.pageSlug} / {assignment.role}
              <span className="ml-2 text-xs">{assignment.acceptedPageContentVersion ? `Content v${assignment.acceptedPageContentVersion}` : "Legacy assignment: page acceptance required"}</span>
            </span>
            <span className="text-gray-600">
              ← {assignment.assetTitle} v{assignment.versionNumber} (digest {shortDigest(assignment.binaryDigest)})
            </span>
            {assignment.replacementAvailable && (
              <span className="rounded border border-amber-400 bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
                replacement available: v{assignment.latestApprovedVersionNumber} — assignment UNCHANGED until you replace explicitly
              </span>
            )}
          </div>
          {assignment.replacementAvailable && assignment.latestApprovedVersionId && (
            <div className="mt-2 flex items-center gap-2">
              <button
                onClick={() => setReplaceForm({ assignmentId: assignment.id, toVersionId: assignment.latestApprovedVersionId! })}
                disabled={busy}
                className="rounded-md border border-amber-500 bg-white px-3 py-1.5 text-xs font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-50"
              >
                Replace explicitly with v{assignment.latestApprovedVersionNumber}
              </button>
              {replaceForm?.assignmentId === assignment.id && (
                <button
                  onClick={replace}
                  disabled={busy}
                  className="rounded-md bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-50"
                >
                  Confirm replace
                </button>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

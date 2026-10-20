import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import { deploymentApi, workflowApi } from "../api/client";
import { queryKeys } from "../query/keys";
import { StatusBadge } from "../components/StatusBadge";

export function DeploymentPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const queryClient = useQueryClient();

  const [sessionToken, setSessionToken] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);

  const workflowQuery = useQuery({
    queryKey: queryKeys.workflow(projectId ?? ""),
    queryFn: () => workflowApi.getWorkflow(projectId!),
    enabled: Boolean(projectId),
  });

  const deploymentQuery = useQuery({
    queryKey: queryKeys.deployment(projectId ?? ""),
    queryFn: () => deploymentApi.getView(projectId!),
    enabled: Boolean(projectId),
  });

  const invalidate = () => {
    if (projectId) {
      queryClient.invalidateQueries({ queryKey: queryKeys.deployment(projectId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.workflow(projectId) });
    }
  };

  const previewMutation = useMutation({
    mutationFn: (candidateId: string) => deploymentApi.preparePreview(projectId!, candidateId),
    onSuccess: () => {
      setActionError(null);
      setActionSuccess("Candidate preview successfully created and verified with remote QA.");
      invalidate();
    },
    onError: (err: any) => {
      setActionSuccess(null);
      setActionError(err.message ?? "Failed to prepare preview.");
    },
  });

  const approveMutation = useMutation({
    mutationFn: (input: { candidateId: string; previewVersionId: string; sessionToken: string }) =>
      deploymentApi.approveRelease(projectId!, input),
    onSuccess: () => {
      setActionError(null);
      setActionSuccess("Release approval successfully verified and cryptographically sealed.");
      invalidate();
    },
    onError: (err: any) => {
      setActionSuccess(null);
      setActionError(err.message ?? "Failed to approve release.");
    },
  });

  const publishMutation = useMutation({
    mutationFn: (input: {
      candidateId: string;
      previewVersionId: string;
      approvalId: string;
      sessionToken: string;
    }) => deploymentApi.publishRelease(projectId!, input),
    onSuccess: () => {
      setActionError(null);
      setActionSuccess("Candidate promoted to Cloudflare production and verified with production QA!");
      invalidate();
    },
    onError: (err: any) => {
      setActionSuccess(null);
      setActionError(err.message ?? "Failed to publish release.");
    },
  });

  const rollbackMutation = useMutation({
    mutationFn: (input: { sessionToken: string; targetVersionId?: string }) =>
      deploymentApi.rollbackRelease(projectId!, input),
    onSuccess: () => {
      setActionError(null);
      setActionSuccess("Explicit rollback executed and production verified.");
      invalidate();
    },
    onError: (err: any) => {
      setActionSuccess(null);
      setActionError(err.message ?? "Failed to rollback.");
    },
  });

  if (!projectId) {
    return <p className="text-gray-500">Project ID required.</p>;
  }

  const isLoading = workflowQuery.isLoading || deploymentQuery.isLoading;
  if (isLoading) {
    return <p className="text-gray-500">Loading governed deployment state…</p>;
  }

  const dep = deploymentQuery.data;

  if (!dep) {
    return <p className="text-gray-500">Unable to load deployment data.</p>;
  }

  const currentCandidate = dep.candidate;
  const activePreview = dep.activePreview;
  const activeApproval = dep.activeApproval;
  const latestKnownGood = dep.currentProduction?.knownGoodVersionId;
  const activeProductionVersion = dep.currentProduction?.activeVersionId;

  const canPreparePreview = Boolean(
    currentCandidate &&
      currentCandidate.state === "qa_passed" &&
      dep.latestQa?.publicationEligible &&
      !previewMutation.isPending,
  );

  const canApprove = Boolean(
    activePreview &&
      activePreview.previewVerified &&
      currentCandidate &&
      sessionToken.trim().length > 0 &&
      !activeApproval &&
      !approveMutation.isPending,
  );

  const canPublish = Boolean(
    activePreview &&
      activeApproval &&
      !activeApproval.revoked &&
      currentCandidate &&
      sessionToken.trim().length > 0 &&
      dep.blockers.length === 0 &&
      !publishMutation.isPending,
  );

  const canRollback = Boolean(
    sessionToken.trim().length > 0 &&
      (latestKnownGood || activeProductionVersion) &&
      !rollbackMutation.isPending,
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold text-gray-900">Governed Production Delivery</h2>
          <StatusBadge status={dep.readinessState} />
        </div>
        <div className="text-xs text-gray-500">
          Target: <span className="font-mono text-gray-700">{dep.targetWorkerName || "Unset"}</span> ·{" "}
          <span className="font-mono text-gray-700">{dep.targetProductionUrl || "Unset"}</span>
        </div>
      </div>

      {actionSuccess && (
        <div className="rounded-md border border-green-200 bg-green-50 p-4 text-sm text-green-800">
          {actionSuccess}
        </div>
      )}

      {actionError && (
        <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          {actionError}
        </div>
      )}

      {dep.blockers.length > 0 && (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-4">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-amber-800">
            Blockers ({dep.blockers.length})
          </h4>
          <ul className="mt-2 list-inside list-disc text-sm text-amber-700">
            {dep.blockers.map((b, i) => (
              <li key={i}>{b.message} ({b.code})</li>
            ))}
          </ul>
        </div>
      )}

      {/* Operator Session Credentials */}
      <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
          Operator IdP Session Token
        </h3>
        <p className="mt-1 text-xs text-gray-500">
          Required for Human Release Approval, Governed Publish, and Explicit Rollback. Must carry genuine IdP signature with project permissions.
        </p>
        <input
          type="password"
          className="mt-2 w-full rounded border border-gray-300 px-3 py-2 font-mono text-xs text-gray-800 focus:border-blue-500 focus:outline-none"
          placeholder="ext-idp-v1..."
          value={sessionToken}
          onChange={(e) => setSessionToken(e.target.value)}
        />
      </div>

      {/* 4-Stage Lifecycle Cards */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {/* Stage 1: Candidate */}
        <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">
              1. Candidate Build & QA
            </span>
            {currentCandidate && (
              <span
                className={`rounded px-2 py-0.5 text-xs font-medium ${
                  currentCandidate.state === "qa_passed"
                    ? "bg-green-100 text-green-800"
                    : "bg-gray-100 text-gray-800"
                }`}
              >
                {currentCandidate.state}
              </span>
            )}
          </div>
          {currentCandidate ? (
            <div className="space-y-1 font-mono text-xs">
              <div>Candidate: {currentCandidate.id}</div>
              <div>Digest: {currentCandidate.artifactDigest ? currentCandidate.artifactDigest.slice(0, 24) + "…" : "None"}</div>
              <div>Routes: {currentCandidate.routes.length} routes bound</div>
              {dep.latestQa && (
                <div>
                  QA Run: {dep.latestQa.overall} (
                  {dep.latestQa.publicationEligible ? "Publication eligible" : "Ineligible"})
                </div>
              )}
            </div>
          ) : (
            <p className="text-xs text-gray-500">No production candidate found.</p>
          )}
          <button
            disabled={!canPreparePreview}
            onClick={() => currentCandidate && previewMutation.mutate(currentCandidate.id)}
            className={`w-full rounded px-3 py-2 text-xs font-medium text-white transition ${
              canPreparePreview
                ? "bg-blue-600 hover:bg-blue-700"
                : "cursor-not-allowed bg-gray-300"
            }`}
          >
            {previewMutation.isPending ? "Preparing Preview…" : "Prepare Candidate Preview"}
          </button>
        </div>

        {/* Stage 2: Preview */}
        <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">
              2. Isolated Preview
            </span>
            {activePreview && (
              <span className="rounded bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800">
                Verified
              </span>
            )}
          </div>
          {activePreview ? (
            <div className="space-y-1 font-mono text-xs">
              <div>Version: {activePreview.versionId}</div>
              <div>
                URL:{" "}
                <a
                  href={activePreview.previewUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-blue-600 hover:underline"
                >
                  {activePreview.previewUrl}
                </a>
              </div>
              <div>Deployment: {activePreview.deploymentId}</div>
            </div>
          ) : (
            <p className="text-xs text-gray-500">No active verified preview uploaded.</p>
          )}
          <button
            disabled={!canApprove}
            onClick={() =>
              currentCandidate &&
              activePreview &&
              approveMutation.mutate({
                candidateId: currentCandidate.id,
                previewVersionId: activePreview.versionId,
                sessionToken,
              })
            }
            className={`w-full rounded px-3 py-2 text-xs font-medium text-white transition ${
              canApprove
                ? "bg-indigo-600 hover:bg-indigo-700"
                : "cursor-not-allowed bg-gray-300"
            }`}
          >
            {approveMutation.isPending ? "Approving…" : "Approve Release for Production"}
          </button>
        </div>

        {/* Stage 3: Approval Authority */}
        <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">
              3. Release Approval
            </span>
            {activeApproval && (
              <span className="rounded bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-800">
                {activeApproval.sealStatus}
              </span>
            )}
          </div>
          {activeApproval ? (
            <div className="space-y-1 font-mono text-xs">
              <div>Approver: {activeApproval.actorName} ({activeApproval.actorId})</div>
              <div>Role: {activeApproval.actorRole}</div>
              <div>Version Bound: {activeApproval.previewVersionId}</div>
              <div>
                HMAC Seal: {activeApproval.verificationSeal?.slice(0, 24)}… ({activeApproval.sealKeyId})
              </div>
            </div>
          ) : (
            <p className="text-xs text-gray-500">Awaiting human release approval.</p>
          )}
          <button
            disabled={!canPublish}
            onClick={() =>
              currentCandidate &&
              activePreview &&
              activeApproval &&
              publishMutation.mutate({
                candidateId: currentCandidate.id,
                previewVersionId: activePreview.versionId,
                approvalId: activeApproval.id,
                sessionToken,
              })
            }
            className={`w-full rounded px-3 py-2 text-xs font-medium text-white transition ${
              canPublish
                ? "bg-green-600 hover:bg-green-700"
                : "cursor-not-allowed bg-gray-300"
            }`}
          >
            {publishMutation.isPending ? "Publishing to Production…" : "Publish Approved Release"}
          </button>
        </div>

        {/* Stage 4: Production & Rollback */}
        <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">
              4. Production State & Recovery
            </span>
            {activeProductionVersion && (
              <span className="rounded bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800">
                Live
              </span>
            )}
          </div>
          <div className="space-y-1 font-mono text-xs">
            <div>Active Version: {activeProductionVersion ?? "None"}</div>
            <div>Latest Known-Good: {latestKnownGood ?? "None"}</div>
          </div>
          <button
            disabled={!canRollback}
            onClick={() => rollbackMutation.mutate({ sessionToken })}
            className={`w-full rounded px-3 py-2 text-xs font-medium text-white transition ${
              canRollback
                ? "bg-red-600 hover:bg-red-700"
                : "cursor-not-allowed bg-gray-300"
            }`}
          >
            {rollbackMutation.isPending ? "Rolling back…" : "Explicit Rollback to Known-Good"}
          </button>
        </div>
      </div>

      {/* Deployment History Table */}
      <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
        <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-500">
          Deployment Audit History ({dep.history.length})
        </h3>
        {dep.history.length === 0 ? (
          <p className="text-xs text-gray-500">No deployment records.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 text-left font-mono text-xs">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-3 py-2 font-medium text-gray-500">ID</th>
                  <th className="px-3 py-2 font-medium text-gray-500">Status</th>
                  <th className="px-3 py-2 font-medium text-gray-500">Version</th>
                  <th className="px-3 py-2 font-medium text-gray-500">Preview</th>
                  <th className="px-3 py-2 font-medium text-gray-500">Production</th>
                  <th className="px-3 py-2 font-medium text-gray-500">Rolled Back</th>
                  <th className="px-3 py-2 font-medium text-gray-500">Created At</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 bg-white">
                {dep.history.map((h) => (
                  <tr key={h.id}>
                    <td className="whitespace-nowrap px-3 py-2 text-gray-900">{h.id}</td>
                    <td className="whitespace-nowrap px-3 py-2">
                      <span className="rounded bg-gray-100 px-2 py-0.5 font-sans text-xs">
                        {h.status}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-gray-700">{h.versionId ?? "—"}</td>
                    <td className="whitespace-nowrap px-3 py-2">
                      {h.previewVerified ? (
                        <span className="text-green-600">Verified</span>
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">
                      {h.productionVerified ? (
                        <span className="text-green-600">Verified</span>
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">
                      {h.rolledBack ? (
                        <span className="text-red-600">Yes</span>
                      ) : (
                        <span className="text-gray-400">No</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-gray-500">
                      {new Date(h.createdAt).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

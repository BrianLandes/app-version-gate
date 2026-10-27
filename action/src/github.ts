// GitHub: is a Play upload in flight, and when was the pending build staged?

import type { Http } from "./http.js";

export interface WorkflowRun {
  run_number: number;
  status: string;
  updated_at: string;
}

export interface GitHubContext {
  token: string;
  repository: string;
  apiUrl: string;
}

/**
 * The upload workflow's most recent runs, newest first.
 *
 * Throws on a missing token / repository or any API error; the caller then
 * declines to touch Play at all.
 */
export async function listWorkflowRuns(http: Http, github: GitHubContext, workflowFile: string): Promise<WorkflowRun[]> {
  if (!github.token || !github.repository) {
    throw new Error("github-token / GITHUB_REPOSITORY not set");
  }
  const api = github.apiUrl.replace(/\/+$/, "");
  const response = (await http({
    method: "GET",
    url: `${api}/repos/${github.repository}/actions/workflows/${encodeURIComponent(workflowFile)}/runs?per_page=100`,
    headers: {
      Authorization: `Bearer ${github.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "app-version-gate",
    },
  })) as { workflow_runs?: WorkflowRun[] } | null;
  return Array.isArray(response?.workflow_runs) ? response.workflow_runs : [];
}

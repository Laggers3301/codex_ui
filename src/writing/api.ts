import { getApiUserId } from "../api";
import type { DocumentJob, OpenedDocument, TreeResponse } from "./types";

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("x-codex-web-user-id", getApiUserId());
  if (init?.body !== undefined && !(init.body instanceof FormData) && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(url, { ...init, headers, credentials: "same-origin" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = body.message ? `${body.error ?? "Request failed"}: ${body.message}` : body.error;
    throw new Error(message ?? `Request failed (${response.status})`);
  }
  return body as T;
}

const projectUrl = (id: string) => `/api/projects/${encodeURIComponent(id)}/documents`;
const pathQuery = (path: string) => `?path=${encodeURIComponent(path)}`;

export async function readTree(projectId: string, path: string, offset?: number): Promise<TreeResponse> {
  const params = new URLSearchParams({ path });
  if (offset !== undefined) params.set("offset", String(offset));
  return (await request<{ data: TreeResponse }>(`${projectUrl(projectId)}/tree?${params}`)).data;
}
export async function openDocument(projectId: string, path: string): Promise<OpenedDocument> {
  return (await request<{ data: OpenedDocument }>(`${projectUrl(projectId)}/open${pathQuery(path)}`)).data;
}
export async function readDocumentBlob(projectId: string, path: string, rawUrl?: string): Promise<Blob> {
  const headers = new Headers({ "x-codex-web-user-id": getApiUserId() });
  const response = await fetch(rawUrl ?? `${projectUrl(projectId)}/raw${pathQuery(path)}`, { headers, credentials: "same-origin" });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.message ?? body.error ?? `Could not read document (${response.status})`);
  }
  return response.blob();
}
export async function saveDocument(projectId: string, input: { path: string; baseVersion: string | null; content?: string; base64?: string; create?: boolean }): Promise<OpenedDocument> {
  return (await request<{ data: OpenedDocument }>(`${projectUrl(projectId)}/save`, { method: "PUT", body: JSON.stringify(input) })).data;
}
export async function compileDocument(projectId: string, input: { path: string; version: string; engine: "pdflatex" | "xelatex" | "lualatex" }): Promise<DocumentJob> {
  return (await request<{ data: DocumentJob }>(`${projectUrl(projectId)}/compile`, { method: "POST", body: JSON.stringify(input) })).data;
}
export async function readJob(projectId: string, jobId: string): Promise<DocumentJob> {
  return (await request<{ data: DocumentJob }>(`${projectUrl(projectId)}/jobs/${encodeURIComponent(jobId)}`)).data;
}
export async function readJobArtifact(projectId: string, jobId: string): Promise<Blob> {
  return readDocumentBlob(projectId, "", `${projectUrl(projectId)}/jobs/${encodeURIComponent(jobId)}/artifact`);
}
export async function cancelJob(projectId: string, jobId: string): Promise<void> {
  await request(`${projectUrl(projectId)}/jobs/${encodeURIComponent(jobId)}/cancel`, { method: "POST", body: "{}" });
}
export async function synctex(projectId: string, input: { jobId: string; page: number; x: number; y: number }): Promise<{ path: string; line: number; column?: number; version: string }> {
  return (await request<{ data: { path: string; line: number; column?: number; version: string } }>(`${projectUrl(projectId)}/synctex`, { method: "POST", body: JSON.stringify(input) })).data;
}
export async function convertDocument(projectId: string, input: { path: string; version: string; to: "docx" | "tex" | "pdf"; targetPath?: string }): Promise<DocumentJob> {
  return (await request<{ data: DocumentJob }>(`${projectUrl(projectId)}/convert`, { method: "POST", body: JSON.stringify(input) })).data;
}

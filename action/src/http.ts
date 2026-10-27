// A minimal HTTP seam. Everything that talks to Supabase, GitHub, Google Play
// or App Store Connect goes through an `Http` function, so the tests can swap
// in a fake that records every call and the decision logic never touches the
// network directly.

export interface HttpRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
}

/** Resolves with the parsed JSON body (or null for an empty body). Throws
 * `HttpError` for any non-2xx response, and lets network errors propagate. */
export type Http = (request: HttpRequest) => Promise<unknown>;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly body: string,
  ) {
    super(`HTTP ${status}: ${extractMessage(body)}`);
    this.name = "HttpError";
  }
}

const TIMEOUT_MS = 30_000;

export const fetchHttp: Http = async (request) => {
  const init: RequestInit = {
    method: request.method,
    headers: request.headers ?? {},
    signal: AbortSignal.timeout(TIMEOUT_MS),
  };
  if (request.body !== undefined) init.body = request.body;
  const response = await fetch(request.url, init);
  const text = await response.text();
  if (!response.ok) throw new HttpError(response.status, request.url, text);
  return text ? (JSON.parse(text) as unknown) : null;
};

/** The human-readable message of an API error body: Google's
 * `{"error":{"message":...}}`, PostgREST's / GitHub's `{"message":...}`, or
 * the raw body. */
export function extractMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      const nested = record["error"];
      if (nested && typeof nested === "object") {
        const message = (nested as Record<string, unknown>)["message"];
        if (typeof message === "string") return message;
      }
      if (typeof record["message"] === "string") return record["message"];
    }
  } catch {
    // not JSON; fall through to the raw body
  }
  return body.trim() || "(empty response body)";
}

/** One line describing any thrown value, including fetch's nested `cause`
 * ("fetch failed: getaddrinfo ENOTFOUND ..."), never a stack trace. */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: unknown }).cause;
    if (cause instanceof Error && cause.message && !error.message.includes(cause.message)) {
      return `${error.message}: ${cause.message}`;
    }
    return error.message || error.name;
  }
  return String(error);
}

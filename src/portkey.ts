// ---------------------------------------------------------------------------
// Portkey provider — Steps 2–4: LLM calls via Portkey gateway
// Reference: docs/backend-context.md §5.1
// ---------------------------------------------------------------------------

export interface PortkeyResult {
  text: string;
  rawResponse: object;
}

// Retry policy for transient Portkey gateway errors (5xx + 429).
// These almost always succeed on a second or third try — Portkey's
// gateway sits in front of provider-specific routes and occasionally
// returns a Cloudflare 503 HTML page when an upstream is briefly
// unavailable. The retry budget is intentionally tight; permanent
// errors (4xx auth, 400 validation) propagate immediately.
const RETRY_MAX_ATTEMPTS = 4;            // 1 initial + 3 retries
const RETRY_BASE_DELAY_MS = 1_000;       // 1s, 2s, 4s
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * When Portkey routes through a Cloudflare-fronted upstream that's
 * unavailable, the response body is a multi-KB HTML error page (IE
 * conditional comments and all). Surfacing the raw HTML in error
 * messages buries the actual cause. Detect HTML, return a clean
 * one-line summary, otherwise truncate the body sensibly.
 */
function summariseUpstreamBody(body: string, status: number): string {
  const trimmed = body.trim();
  if (/^<!DOCTYPE\s+html|^<html/i.test(trimmed)) {
    // Try to pull the <title> for context if present, else use status.
    const title = /<title[^>]*>([^<]+)<\/title>/i.exec(trimmed)?.[1]?.trim();
    if (title) return `${title} (HTTP ${status} from upstream gateway — likely transient)`;
    return `upstream gateway returned an HTML error page (HTTP ${status} — likely transient)`;
  }
  return trimmed.slice(0, 300);
}

/**
 * Run an async operation that returns a Response, retrying on
 * transient HTTP statuses (5xx + 429) and network errors with
 * exponential backoff. Non-retryable errors (4xx other than 429,
 * auth, validation, AbortError from caller's timeout) propagate
 * immediately so they don't waste the retry budget.
 *
 * The factory closure pattern (() => fetch(...)) means each retry
 * gets a fresh Response — we can't re-read the previous body.
 */
async function fetchWithRetry(
  opName: string,
  factory: () => Promise<Response>,
): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt++) {
    try {
      const resp = await factory();
      // Auth + 4xx (other than 429) must NOT retry — they're terminal.
      if (resp.ok || (resp.status >= 400 && resp.status < 500 && resp.status !== 429)) {
        return resp;
      }
      if (!RETRYABLE_STATUS.has(resp.status)) return resp;
      // Retryable — read body for diagnostics, then back off.
      const body = await resp.text().catch(() => "");
      lastErr = new Error(
        `${opName}: ${resp.status} ${resp.statusText} (attempt ${attempt}/${RETRY_MAX_ATTEMPTS}) — ${summariseUpstreamBody(body, resp.status)}`,
      );
      process.stderr.write(`${(lastErr as Error).message}\n`);
    } catch (err) {
      // Network errors (DNS, connection reset, timeout from caller's
      // AbortController) all surface here. AbortError = explicit
      // user-driven cancel — never retry.
      if ((err as Error).name === "AbortError") throw err;
      lastErr = err;
      process.stderr.write(
        `${opName}: network error attempt ${attempt}/${RETRY_MAX_ATTEMPTS} — ${(err as Error).message}\n`,
      );
    }
    if (attempt < RETRY_MAX_ATTEMPTS) {
      const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
      await sleep(delay);
    }
  }
  throw lastErr ?? new Error(`${opName}: exhausted retries`);
}

export interface PortkeyMetadata {
  project_id?: string;
  step_name: string;
  flow_type: "old" | "new";
  client_id: string;
}

/**
 * Extract the assistant text from Portkey's response, tolerating all of
 * the provider-native shapes we've actually seen come back from the
 * gateway. We set `x-portkey-strict-open-ai-compliance: false`, which
 * means responses can arrive in any of:
 *
 *   OpenAI chat format  → choices[0].message.content: string
 *   Anthropic native    → content: [{ type: "text", text: "..." }]
 *   Anthropic legacy    → completion: "..."
 *   Google-style        → candidates[0].content.parts[0].text
 *   Error-on-success    → stop_reason: "content_filter" with no text
 *
 * Previously only the OpenAI path was read — a 200 OK from Anthropic in
 * native format produced an empty `text` with no error, which is
 * exactly the silent-empty extract_graphic_token failure.
 */
function extractTextFromPortkeyResponse(raw: unknown): string {
  if (!raw || typeof raw !== "object") return "";
  const json = raw as Record<string, unknown>;

  // 1. OpenAI chat completions
  const openAI = (json.choices as Array<Record<string, unknown>> | undefined)
    ?.[0]?.message as { content?: unknown } | undefined;
  if (openAI && typeof openAI.content === "string" && openAI.content.length > 0) {
    return openAI.content;
  }
  // 1b. OpenAI also sometimes returns content as an array of typed parts
  if (openAI && Array.isArray(openAI.content)) {
    const joined = (openAI.content as Array<Record<string, unknown>>)
      .map((p) => (typeof p.text === "string" ? (p.text as string) : ""))
      .filter(Boolean)
      .join("");
    if (joined) return joined;
  }

  // 2. Anthropic native messages format
  if (Array.isArray(json.content)) {
    const joined = (json.content as Array<Record<string, unknown>>)
      .map((b) => (b?.type === "text" && typeof b.text === "string" ? (b.text as string) : ""))
      .filter(Boolean)
      .join("");
    if (joined) return joined;
  }
  // 2b. Some Anthropic adapters flatten `content` to a string
  if (typeof json.content === "string" && json.content.length > 0) {
    return json.content;
  }

  // 3. Anthropic legacy completion API
  if (typeof json.completion === "string" && json.completion.length > 0) {
    return json.completion;
  }

  // 4. Google-style (Gemini-via-Portkey) candidates[].content.parts[].text
  const cand = (json.candidates as Array<Record<string, unknown>> | undefined)?.[0];
  if (cand && typeof cand === "object") {
    const content = (cand.content as { parts?: Array<Record<string, unknown>> } | undefined);
    if (content && Array.isArray(content.parts)) {
      const joined = content.parts
        .map((p) => (typeof p.text === "string" ? (p.text as string) : ""))
        .filter(Boolean)
        .join("");
      if (joined) return joined;
    }
  }

  return "";
}

/**
 * If text is empty, build a diagnostic error message from finish_reason /
 * stop_reason so the UI shows something actionable instead of a silent
 * completed-but-empty cell. Returns null when there's nothing useful.
 */
function diagnoseEmptyResponse(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const json = raw as Record<string, unknown>;

  const openAIFinish = (json.choices as Array<Record<string, unknown>> | undefined)
    ?.[0]?.finish_reason;
  const anthropicStop = json.stop_reason;
  const anthropicType = json.type;

  const reason =
    (typeof openAIFinish === "string" ? openAIFinish : null) ??
    (typeof anthropicStop === "string" ? anthropicStop : null);

  if (anthropicType === "error") {
    const err = json.error as Record<string, unknown> | undefined;
    return `Anthropic error${err?.type ? ` (${String(err.type)})` : ""}${
      err?.message ? `: ${String(err.message)}` : ""
    }`;
  }

  if (reason === "content_filter" || reason === "safety") {
    return `LLM refused to answer (finish_reason="${reason}"). System prompt or input likely triggered safety filter.`;
  }
  if (reason === "length" || reason === "max_tokens") {
    return `LLM output truncated at max_tokens (finish_reason="${reason}"). Raise max_tokens or shorten input.`;
  }
  if (reason && reason !== "stop" && reason !== "end_turn") {
    return `LLM returned no text (finish_reason="${reason}").`;
  }
  return null;
}

export async function callPortkey(params: {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  maxTokens?: number;
  metadata: PortkeyMetadata;
}): Promise<PortkeyResult> {
  const apiKey    = process.env.PORTKEY_API_KEY;
  const configId  = process.env.PORTKEY_CONFIG_ID ?? "pc-portke-0dd3de";

  if (!apiKey) {
    throw new Error(
      "PORTKEY_API_KEY is not set. Local: add to .env.local and restart `npm run dev`. Vercel: add in Project Settings → Environment Variables, then redeploy."
    );
  }

  const { model, systemPrompt, userPrompt, maxTokens = 4096, metadata } = params;

  // Client-side timeout is generous (5 min) — matches stormbreaker's
  // aiohttp.ClientTimeout(total=600). On Vercel Hobby the function is
  // hard-killed at 60s regardless; on Pro we have up to 300s. Locally
  // there's no cap, which is where heavy prompts (e.g. 20KB
  // EXTRACT_GRAPHIC_TOKEN_SYSTEM_PROMPT + 100KB cleaned HTML) need it.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 300_000);

  let response: Response;
  try {
    response = await fetchWithRetry("Portkey chat/completions", () =>
      fetch("https://api.portkey.ai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization":                    `Bearer ${apiKey}`,
          "X-Portkey-Config":                 configId,
          "x-portkey-strict-open-ai-compliance": "false",
          "X-Portkey-Metadata":               JSON.stringify(metadata),
          "Content-Type":                     "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user",   content: userPrompt },
          ],
          max_tokens: maxTokens,
        }),
        signal: controller.signal,
      }),
    );
  } finally {
    clearTimeout(timeout);
  }

  if (response.status === 401 || response.status === 403) {
    throw new Error(
      `Portkey auth error (${response.status}). Check PORTKEY_API_KEY and PORTKEY_CONFIG_ID.`
    );
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Portkey error ${response.status}: ${summariseUpstreamBody(body, response.status)}`);
  }

  const json = (await response.json()) as Record<string, unknown> & {
    error?: { message?: string };
  };

  if (json.error) {
    throw new Error(`Portkey LLM error: ${json.error.message ?? JSON.stringify(json.error)}`);
  }

  const text = extractTextFromPortkeyResponse(json);
  if (!text) {
    const diag = diagnoseEmptyResponse(json);
    // Log the full response shape so the dev console shows what the
    // gateway actually returned — crucial when Portkey swaps a Claude
    // adapter and our OpenAI-shaped reader misses.
    console.warn(
      `[Portkey][${metadata.step_name}] empty-text response`,
      { model, diag, rawKeys: Object.keys(json) },
    );
    throw new Error(
      diag ??
        `Portkey returned no assistant text. Response shape: ${JSON.stringify(
          Object.keys(json),
        )}. Check Portkey Logs for this request.`,
    );
  }
  return { text, rawResponse: json };
}

// ---------------------------------------------------------------------------
// Portkey stored-prompt completion — mirrors stormbreaker's
// services/portkey/prompt_completions.py:invoke_prompt_completion.
//
// Calls POST /v1/prompts/{prompt_id}/completions with the Portkey SDK's
// stored prompt. The prompt body + model are managed in the Portkey
// dashboard — we only send variables. Identical to how stormbreaker
// production invokes IMAGE_PLACEHOLDER / SERVICE_PAGE_CONTENT_GEN /
// CATEGORY_PAGE_CONTENT_GEN etc.
// ---------------------------------------------------------------------------
export async function callPortkeyStoredPrompt(params: {
  promptId: string;
  variables: Record<string, unknown>;
  metadata: PortkeyMetadata;
}): Promise<PortkeyResult> {
  const apiKey   = process.env.PORTKEY_API_KEY;
  const configId = process.env.PORTKEY_CONFIG_ID ?? "pc-portke-0dd3de";

  if (!apiKey) {
    throw new Error(
      "PORTKEY_API_KEY is not set. Local: add to .env.local and restart `npm run dev`. Vercel: add in Project Settings → Environment Variables, then redeploy."
    );
  }

  const { promptId, variables, metadata } = params;

  // See the note in callPortkey above; same 5-minute client timeout here.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 300_000);

  let response: Response;
  try {
    response = await fetchWithRetry(`Portkey stored-prompt ${promptId}`, () =>
      fetch(
        `https://api.portkey.ai/v1/prompts/${encodeURIComponent(promptId)}/completions`,
        {
          method: "POST",
          headers: {
            "Authorization":                       `Bearer ${apiKey}`,
            "X-Portkey-Config":                    configId,
            "x-portkey-strict-open-ai-compliance": "false",
            "X-Portkey-Metadata":                  JSON.stringify(metadata),
            "Content-Type":                        "application/json",
          },
          body: JSON.stringify({ variables }),
          signal: controller.signal,
        },
      ),
    );
  } finally {
    clearTimeout(timeout);
  }

  if (response.status === 401 || response.status === 403) {
    throw new Error(
      `Portkey auth error (${response.status}) on stored prompt ${promptId}. Check PORTKEY_API_KEY / PORTKEY_CONFIG_ID and that the prompt ID is visible to your account.`
    );
  }
  if (response.status === 404) {
    throw new Error(
      `Portkey stored prompt not found: ${promptId}. Check utils/constants.py in stormbreaker — dev vs prod IDs differ.`
    );
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Portkey stored-prompt error ${response.status}: ${summariseUpstreamBody(body, response.status)}`);
  }

  const json = (await response.json()) as Record<string, unknown> & {
    error?: { message?: string };
  };

  if (json.error) {
    throw new Error(`Portkey stored-prompt error: ${json.error.message ?? JSON.stringify(json.error)}`);
  }

  const text = extractTextFromPortkeyResponse(json);
  if (!text) {
    const diag = diagnoseEmptyResponse(json);
    console.warn(
      `[Portkey stored][${metadata.step_name}] empty-text response`,
      { promptId, diag, rawKeys: Object.keys(json) },
    );
    throw new Error(
      diag ??
        `Portkey stored prompt ${promptId} returned no assistant text. Response shape: ${JSON.stringify(
          Object.keys(json),
        )}.`,
    );
  }
  return { text, rawResponse: json };
}

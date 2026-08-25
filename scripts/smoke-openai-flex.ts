// Empirical test: does OpenAI accept service_tier="flex" on the Images
// API? Docs say no; user says try it. Run the actual API call and
// report exactly what happens, including for gpt-image-1 as a fallback.
import OpenAI from "openai";

async function attempt(label: string, body: any) {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
  const t_sent = Date.now();
  const ts_sent = new Date(t_sent).toISOString();
  try {
    const resp = await (client as any).images.generate(body);
    const elapsed = Date.now() - t_sent;
    const anyResp: any = resp;
    const firstImg = anyResp?.data?.[0] ?? {};
    const bytes = firstImg.b64_json ? Buffer.from(firstImg.b64_json, "base64").length : 0;
    console.log(JSON.stringify({
      label, outcome: "success", ts_sent, elapsed_ms: elapsed,
      bytes,
      has_url: !!firstImg.url,
      revised_prompt_present: !!firstImg.revised_prompt,
      served_tier: anyResp?.service_tier ?? null,
      usage: anyResp?.usage ?? null,
      created: anyResp?.created,
      response_keys: Object.keys(anyResp ?? {}),
      request_body: body,
    }, null, 2));
  } catch (err: any) {
    const elapsed = Date.now() - t_sent;
    console.log(JSON.stringify({
      label, outcome: "error", ts_sent, elapsed_ms: elapsed,
      status: err?.status ?? null,
      code: err?.code ?? null,
      type: err?.type ?? null,
      message: err?.message ?? String(err),
      param: err?.param ?? null,
      request_body: body,
    }, null, 2));
  }
  console.log("---");
}

async function main() {
  if (!process.env.OPENAI_API_KEY) { console.error("OPENAI_API_KEY not set"); process.exit(1); }

  // 1. Baseline standard: does the SDK path work at all?
  await attempt("gpt-image-2 no-tier baseline", {
    model: "gpt-image-2",
    prompt: "A red apple on a white plate, photorealistic",
    size: "1024x1024",
  });

  // 2. THE test: explicit service_tier=flex
  await attempt("gpt-image-2 service_tier=flex", {
    model: "gpt-image-2",
    prompt: "A red apple on a white plate, photorealistic",
    size: "1024x1024",
    service_tier: "flex",
  });

  // 3. Priority + auto for comparison
  await attempt("gpt-image-2 service_tier=priority", {
    model: "gpt-image-2",
    prompt: "A red apple on a white plate, photorealistic",
    size: "1024x1024",
    service_tier: "priority",
  });

  await attempt("gpt-image-2 service_tier=auto", {
    model: "gpt-image-2",
    prompt: "A red apple on a white plate, photorealistic",
    size: "1024x1024",
    service_tier: "auto",
  });

  // 4. gpt-image-1 with flex as a sanity check on the older model too
  await attempt("gpt-image-1 service_tier=flex", {
    model: "gpt-image-1",
    prompt: "A red apple on a white plate, photorealistic",
    size: "1024x1024",
    service_tier: "flex",
  });
}
main().catch(e => { console.error(e); process.exit(1); });

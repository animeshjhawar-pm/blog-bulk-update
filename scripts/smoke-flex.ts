import { GoogleGenAI } from "@google/genai";
import { promises as fs } from "node:fs";
import * as path from "node:path";

const OUT_DIR = "/tmp/flex-smoke";

async function attempt(label: string, prompt: string, ai: GoogleGenAI) {
  const t_sent = Date.now();
  const t_sent_iso = new Date(t_sent).toISOString();
  try {
    const resp = await Promise.race([
      ai.models.generateContent({
        model: "gemini-3-pro-image",
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        config: {
          // @ts-expect-error - service_tier / responseModalities may not be in v0 types yet
          serviceTier: "flex",
          responseModalities: ["IMAGE"],
        },
      }),
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error("TIMEOUT_300s")), 300_000),
      ),
    ]);
    const elapsed = Date.now() - t_sent;
    const anyResp: any = resp;
    const parts = anyResp?.candidates?.[0]?.content?.parts ?? [];
    const imgPart = parts.find((p: any) => p.inlineData);
    const bytes = imgPart?.inlineData?.data
      ? Buffer.from(imgPart.inlineData.data, "base64").length
      : 0;
    const mime = imgPart?.inlineData?.mimeType ?? "-";
    console.log(
      JSON.stringify({
        label,
        outcome: "success",
        t_sent: t_sent_iso,
        elapsed_ms: elapsed,
        bytes,
        mime,
        text_parts: parts.filter((p: any) => p.text).map((p: any) => p.text?.slice(0, 80)),
      }),
    );
    if (bytes > 0 && imgPart) {
      const ext = mime.includes("png") ? "png" : mime.includes("jpeg") ? "jpg" : "bin";
      const outPath = path.join(OUT_DIR, `${label}.${ext}`);
      await fs.writeFile(outPath, Buffer.from(imgPart.inlineData.data, "base64"));
      console.log(`  wrote ${outPath}`);
    }
  } catch (err: any) {
    const elapsed = Date.now() - t_sent;
    console.log(
      JSON.stringify({
        label,
        outcome: "error",
        t_sent: t_sent_iso,
        elapsed_ms: elapsed,
        error_message: err?.message ?? String(err),
        status: err?.status ?? err?.code ?? null,
      }),
    );
  }
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    console.error("GEMINI_API_KEY not set");
    process.exit(1);
  }
  const ai = new GoogleGenAI({ apiKey: key });

  await attempt(
    "cold-run",
    "A red apple on a white ceramic plate, natural soft window light, minimal composition, photorealistic, 16:9",
    ai,
  );
  await attempt(
    "warm-repeat",
    "A red apple on a white ceramic plate, natural soft window light, minimal composition, photorealistic, 16:9",
    ai,
  );
  await attempt(
    "variant",
    "A wooden desk with an open notebook, a fountain pen, and a cup of black coffee, top-down view, soft morning light, 4:3 aspect ratio",
    ai,
  );
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});

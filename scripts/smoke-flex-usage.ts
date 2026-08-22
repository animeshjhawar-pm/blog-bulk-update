// Inspect what Gemini's Flex response ACTUALLY carries about billing.
// If usageMetadata (or any pricing field) is present, we can log the
// authoritative cost per call instead of our unit-rate estimate.
import { GoogleGenAI } from "@google/genai";

async function main() {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
  const resp = await ai.models.generateContent({
    model: "gemini-3-pro-image",
    contents: [{ role: "user", parts: [{ text: "A red apple on a white plate, photorealistic, 16:9" }] }],
    config: {
      // @ts-expect-error tier + modalities
      serviceTier: "flex",
      responseModalities: ["IMAGE"],
    },
  });
  const anyResp: any = resp;
  console.log("Top-level keys:", Object.keys(anyResp));
  console.log("usageMetadata:", JSON.stringify(anyResp.usageMetadata, null, 2));
  console.log("promptFeedback:", JSON.stringify(anyResp.promptFeedback, null, 2));
  console.log("modelVersion:", anyResp.modelVersion);
  console.log("responseId:", anyResp.responseId);
  console.log("createTime:", anyResp.createTime);
  console.log("candidates[0] keys:", anyResp.candidates?.[0] ? Object.keys(anyResp.candidates[0]) : "none");
  console.log("candidates[0].finishReason:", anyResp.candidates?.[0]?.finishReason);
  // Trim the huge inlineData bytes for readability, keep everything else.
  const trimmed = JSON.parse(JSON.stringify(anyResp, (k, v) => (k === "data" && typeof v === "string" && v.length > 200) ? `<base64 ${v.length}B>` : v));
  console.log("\nFULL RESPONSE (bytes trimmed):");
  console.log(JSON.stringify(trimmed, null, 2));
}
main().catch(e => { console.error(e); process.exit(1); });

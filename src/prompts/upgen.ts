/**
 * Single source for the Upload-&-Generate default service/category
 * prompt.
 *
 * Used by two call sites that must stay byte-identical or the
 * Review-Prompts modal will preview something different from what
 * Replicate actually receives at runtime:
 *
 *   - src/web.ts → served via GET /api/prompts?flow=upgen so the
 *     modal pre-fills the textarea with the same text we'll send.
 *   - src/uploadGenerate.ts → consumed at generation time when the
 *     operator has not edited the prompt in the modal.
 *
 * The prompt body itself is a "preserve-subject / change-background"
 * directive, designed for service/category cards where the operator
 * supplies a product photograph as image_input[1] and the AI must
 * keep that asset bit-for-bit while regenerating only the surrounding
 * scene. See composite.ts:productReferenceDirective for the
 * complementary hard-constraint block inserted at prompt-build time.
 */
export const UPGEN_SERVICE_DEFAULT_PROMPT = [
  `You are an expert image editor. You will receive one or more reference images containing a subject and its branded/product elements. Your task is to generate a NEW image that preserves the subject's identity and all branded elements EXACTLY while completely changing the background, environment, lighting, and surrounding context.`,
  ``,
  `WHAT MUST BE PRESERVED (100% IDENTICAL — DO NOT ALTER):`,
  ``,
  `The subject's face, features, skin tone, hair, and expression (if a person is present)`,
  `All clothing, accessories, and worn items exactly as shown`,
  `Any product, vehicle, or object the subject is using or holding — its exact shape, color, design, panels, and proportions`,
  `Every logo, brand mark, badge, label, and text — including exact colors, fonts, placement, size, and orientation`,
  `The subject's pose, posture, and the camera angle/viewpoint of the subject`,
  ``,
  `WHAT TO CHANGE (FULL CREATIVE FREEDOM):`,
  ``,
  `The entire background and environment`,
  `Surrounding objects, vehicles, people, structures, and scenery`,
  `Time of day, lighting conditions, weather, and atmospheric mood`,
  `Background depth-of-field, blur, and motion as appropriate`,
  ``,
  `TECHNICAL & STYLE REQUIREMENTS:`,
  ``,
  `Photorealistic, high-resolution, professional commercial photography quality`,
  `Lighting on the subject must realistically match the NEW environment — consistent shadows, reflections, highlights, and color temperature`,
  `Natural integration: the subject must look genuinely photographed in the new location, never pasted or composited`,
  `Keep the subject in sharp focus; apply natural, context-appropriate background blur or motion`,
  `Match perspective and scale so the subject sits believably within the new scene`,
  ``,
  `NEGATIVE CONSTRAINTS (AVOID):`,
  ``,
  `Do NOT alter, distort, recolor, relocate, or duplicate any logo, badge, or text`,
  `Do NOT change the subject's identity, face, clothing, or any product/object design or color`,
  `No warped or illegible branding, no text artifacts, no extra or missing limbs, no distorted proportions`,
  `No change to the subject itself — only the world around it changes`,
].join("\n");

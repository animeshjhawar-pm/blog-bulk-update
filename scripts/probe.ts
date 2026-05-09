import { loadEnv } from "../src/env.js";
import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";

loadEnv();
const s3 = new S3Client({
  region: process.env.AWS_REGION ?? "us-east-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
});

const BUCKET = "gw-content-store";

async function main() {
  const cases = [
    { sub: "unleashx-1r3z1u", img: "12e80b1a-9630-41ee-b381-ed554f30c131" },
    { sub: "unleashx-1r3z1u", img: "ccd399ac-f791-40cd-b162-1acec4e8518c" },
    { sub: "unleashx-1r3z1u", img: "3baa6d10-9f55-402d-b8f5-a038c0c1fc68" },
  ];
  for (const { sub, img } of cases) {
    console.log(`\n=== sub=${sub} img=${img} ===`);
    const candidates = [
      `website/${sub}/assets/generated-images/${img}`,
      `website/${sub}/assets/refined-images/${img}`,
      `website/${sub}/assets/preprocessed-images/${img}`,
      `website/${sub}/assets/uploaded-assets/${img}`,
    ];
    for (const prefix of candidates) {
      const lr = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, MaxKeys: 6 }));
      if ((lr.KeyCount ?? 0) > 0) {
        console.log(`  HIT prefix='${prefix}'`);
        for (const k of lr.Contents ?? []) console.log(`    - ${k.Key} (${k.Size}B)`);
      }
    }
  }

  // Also enumerate generated-images/ to see naming conventions
  console.log("\n=== website/unleashx-1r3z1u/assets/generated-images/ first 8 ===");
  const gi = await s3.send(
    new ListObjectsV2Command({ Bucket: BUCKET, Prefix: "website/unleashx-1r3z1u/assets/generated-images/", MaxKeys: 8 }),
  );
  for (const k of gi.Contents ?? []) console.log(`  - ${k.Key}`);
}
main().catch((e) => { console.error(e); process.exit(1); });

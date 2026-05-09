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

async function listLogos(staging: string) {
  const r = await s3.send(new ListObjectsV2Command({
    Bucket: "gw-content-store",
    Prefix: `website/${staging}/assets/logo/`,
    MaxKeys: 30,
  }));
  return (r.Contents ?? []).map((k) => k.Key?.replace(`website/${staging}/assets/logo/`, "") ?? "");
}

async function main() {
  const clients = [
    "sentinelassetmanagementllc-lo1ayr",
    "specgasinc-tiygg8",
    "trussed-l05mo8",
    "achengineering-6iwgqb",
    "inzure-hqx5wx",
    "unleashx-1r3z1u", // extra reference
  ];
  for (const sub of clients) {
    console.log(`\n=== website/${sub}/assets/logo/ ===`);
    try {
      const items = await listLogos(sub);
      for (const k of items) console.log(`  - ${k}`);
      console.log(`  has logo.webp:`, items.includes("logo.webp"));
      console.log(`  has logo.png:`, items.includes("logo.png"));
      console.log(`  has logo.svg:`, items.includes("logo.svg"));
    } catch (e) {
      console.log(`  ERROR:`, (e as Error).message);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });

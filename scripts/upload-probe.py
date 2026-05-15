#!/usr/bin/env python3
"""
Instrumented Gushwork image-upload probe.

Runs ONLY the upload flow (presign -> S3 PUT -> notify -> poll).
Does NOT touch page_info. Goal: capture the EXACT raw response shape at
every step so we can see which identifier / URL the new image gets
(resolves blocker B2 before building the real pipeline).

Token: read from a file OUTSIDE the repo so it never lands in git or
a transcript. Default: ~/.gushwork_token  (override with --token-file).
Stops immediately on any non-2xx (per decision: "if observed, send an
error and don't proceed").
"""
import argparse
import json
import os
import sys
import time

import requests

BASE_URL = "https://api.gushwork.ai/seo-v2/project"


def dump(label, resp):
    print(f"\n===== {label} =====")
    print(f"HTTP {resp.status_code} {resp.reason}  ({resp.elapsed.total_seconds():.2f}s)")
    ct = resp.headers.get("content-type", "")
    if "json" in ct:
        try:
            body = resp.json()
            print(json.dumps(body, indent=2, default=str))
            return body
        except Exception as e:  # noqa: BLE001
            print(f"(json parse failed: {e})")
    print(resp.text[:2000])
    return None


def must_ok(resp, label):
    if not (200 <= resp.status_code < 300):
        print(f"\n[STOP] {label} returned HTTP {resp.status_code}")
        print(resp.text[:2000])
        sys.exit(1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--project-id", required=True)
    ap.add_argument("--file", required=True)
    ap.add_argument("--token-file", default=os.path.expanduser("~/.gushwork_token"))
    ap.add_argument("--refine", default="true", choices=["true", "false"])
    ap.add_argument("--max-poll", type=int, default=30)
    ap.add_argument("--poll-interval", type=int, default=2)
    args = ap.parse_args()

    if not os.path.isfile(args.token_file):
        print(f"[STOP] token file not found: {args.token_file}")
        print("Put a FRESH token there (1h TTL), e.g. from "
              "https://platform.gushwork.ai/api/auth/token")
        sys.exit(1)
    token = open(args.token_file).read().strip()
    if not token:
        print(f"[STOP] token file {args.token_file} is empty")
        sys.exit(1)

    if not os.path.isfile(args.file):
        print(f"[STOP] image not found: {args.file}")
        sys.exit(1)

    file_name = os.path.basename(args.file)
    file_size = os.path.getsize(args.file)
    refine = args.refine == "true"
    auth = {"Authorization": f"Bearer {token}"}

    print(f"project   : {args.project_id}")
    print(f"file      : {file_name} ({file_size} bytes)")
    print(f"refine    : {refine}")
    print(f"token     : {args.token_file} (len={len(token)})")
    print("-" * 60)

    # ---- Step 1: presigned URL --------------------------------------
    r = requests.post(
        f"{BASE_URL}/{args.project_id}/media/presigned-url",
        json={"fileName": file_name, "fileSize": file_size, "refine": refine},
        headers={**auth, "Content-Type": "application/json"},
        timeout=30,
    )
    body1 = dump("STEP 1  POST /media/presigned-url", r)
    must_ok(r, "presigned-url")
    presigned_url = body1.get("url")
    upload_key = body1.get("upload_image_key")
    refined_key = body1.get("refined_image_key")
    print(f"\n-> ALL keys returned by step 1: {list(body1.keys())}")
    if not presigned_url or not upload_key:
        print("[STOP] step 1 missing url/upload_image_key")
        sys.exit(1)

    # ---- Step 2: PUT bytes to S3 ------------------------------------
    with open(args.file, "rb") as f:
        r = requests.put(
            presigned_url,
            data=f,
            headers={"Content-Type": "application/octet-stream",
                     "Content-Length": str(file_size)},
            timeout=120,
        )
    print("\n===== STEP 2  PUT presigned S3 URL =====")
    print(f"HTTP {r.status_code} {r.reason}  ({r.elapsed.total_seconds():.2f}s)")
    print("ETag:", r.headers.get("ETag"))
    must_ok(r, "s3 put")

    # ---- Step 3: notify backend -------------------------------------
    r = requests.post(
        f"{BASE_URL}/{args.project_id}/media",
        json={"upload_image_key": upload_key, "refined_image_key": refined_key},
        headers={**auth, "Content-Type": "application/json"},
        timeout=30,
    )
    body3 = dump("STEP 3  POST /media", r)
    must_ok(r, "notify")
    print(f"\n-> ALL keys in step 3 response: {list(body3.keys())}")
    if isinstance(body3.get("data"), dict):
        print(f"-> step 3 data keys: {list(body3['data'].keys())}")

    # ---- Step 4: poll -----------------------------------------------
    poll_url = (f"{BASE_URL}/{args.project_id}/resource/projects/id/"
                f"{args.project_id}?process=image_update")
    print(f"\n===== STEP 4  poll {poll_url} =====")
    final = None
    for attempt in range(1, args.max_poll + 1):
        r = requests.get(poll_url, headers=auth, timeout=30)
        must_ok(r, "poll")
        data = r.json()
        status = data.get("status")
        print(f"  attempt {attempt:>2}: status={status} keys={list(data.keys())}")
        if status and status != "HOLD":
            final = data
            break
        time.sleep(args.poll_interval)

    print("\n===== FINAL POLL PAYLOAD (full) =====")
    print(json.dumps(final, indent=2, default=str) if final else "(timed out)")

    print("\n===== SUMMARY — identifiers to map into page_info later =====")
    print(json.dumps({
        "step1.upload_image_key": upload_key,
        "step1.refined_image_key": refined_key,
        "step1.all_keys": list(body1.keys()),
        "step3.data": body3.get("data"),
        "final.status": (final or {}).get("status"),
        "final.resource_id": (final or {}).get("resource_id"),
        "final.all_keys": list((final or {}).keys()),
    }, indent=2, default=str))
    print("\nNEXT: correlate refined_image_key against media_registry to see "
          "the new row's id + key + urls (the values page_info would need).")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Coaching reflection test: Qwen3 vs Scout via Workers AI REST API (2026-11-16).

Same system prompt + transcript the live /api/coaching/reflect uses.
Compares JSON validity and content quality.
"""
import json
import sys
import time
import urllib.request

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import dynamic_credential_entry

ACCOUNT_ID = "44501085a1a83d8c0f838a44c1800144"
BASE = f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/run"
DIR = "/home/hatch/workspace/goals/cloudflare-developer-day-seoul-2026-use-case-contest-entry/files/people-os/files/clef-flash-test"

SYSTEM = '너는 코칭 리플렉션 분석가다. 세션 전사본에서 핵심 질문, 반복 패턴, 다음 세션 질문 3개를 한국어로 뽑아 JSON으로만 답하라: {"questions":[],"patterns":[],"next_questions":[]}'


def call_ai(token, model, messages):
    url = f"{BASE}/{model}"
    req = urllib.request.Request(
        url,
        data=json.dumps({"messages": messages}).encode("utf-8"),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method="POST",
    )
    t0 = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=90) as resp:
            payload = json.load(resp)
    except urllib.error.HTTPError as e:
        return None, round((time.monotonic() - t0) * 1000), f"HTTP {e.code}: {e.read().decode('utf-8', 'replace')[:300]}"
    dt = round((time.monotonic() - t0) * 1000)
    if not payload.get("success"):
        return None, dt, f"api success=false: {json.dumps(payload)[:300]}"
    res = payload.get("result", {})
    text = res.get("response") if isinstance(res, dict) else res
    if not isinstance(text, str):
        text = json.dumps(res, ensure_ascii=False)
    return text, dt, None


def extract_json(text):
    t = text.replace("```json", "").replace("```", "")
    s, e = t.find("{"), t.rfind("}")
    if s < 0 or e <= s:
        return None
    try:
        return json.loads(t[s:e + 1])
    except Exception:
        return None


def main():
    token = str(dynamic_credential_entry("custom.cloudflare")["surrogate"]).strip()
    seed = json.load(open("/home/hatch/workspace/goals/cloudflare-developer-day-seoul-2026-use-case-contest-entry/files/people-os/seed/seed-data.json"))
    transcript = seed["coaching_transcript"][:4000]
    results = {}
    for model in ["@cf/meta/llama-4-scout-17b-16e-instruct", "@cf/qwen/qwen3-30b-a3b-fp8"]:
        short = model.split("/")[-1]
        text, ms, err = call_ai(token, model, [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": transcript},
        ])
        parsed = extract_json(text) if text else None
        ok = bool(parsed and isinstance(parsed.get("patterns"), list) and len(parsed["patterns"]) > 0)
        results[short] = {
            "model": short, "latencyMs": ms, "error": err,
            "raw": (text or "")[:1500], "parsed": parsed, "valid": ok,
        }
        print(f"=== {short} ({ms}ms) valid={ok} err={err} ===")
        print("raw:", (text or "")[:800])
        print("parsed:", json.dumps(parsed, ensure_ascii=False)[:800] if parsed else None)
        print()
    json.dump(results, open(f"{DIR}/reflection_qwen3_vs_scout.json", "w"), ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()

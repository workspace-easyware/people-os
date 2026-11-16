#!/usr/bin/env python3
"""Test the CLEF_CRITERIA fix: does allowing direct inferences change
Qwen3 gi_s03 from 'partial' to 'grounded'? (2026-11-16)

Calls Clef twice on the SAME Qwen3 gi_s03 (question, answer, evidence):
once with the OLD criteria, once with the NEW criteria.
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

OLD_CRITERIA = {
    "grounded": "Every key claim in the answer is present in the retrieved evidence.",
    "partial": "Some claims are supported by the evidence; others are missing from it or uncertain.",
    "ungrounded": "The key claims of the answer are not in the retrieved evidence (fabricated).",
    "off_topic": "The answer, or the retrieved evidence, is unrelated to the question.",
}

NEW_CRITERIA = {
    "grounded": "Every key claim in the answer is present in the retrieved evidence, or directly follows from it. A claim that reasonably follows from the evidence (for example, that the answer's use of leave does not conflict with a cited rule) counts as grounded, not partial.",
    "partial": "Some claims are supported by the evidence; others are missing from it, uncertain, or go beyond what the evidence supports.",
    "ungrounded": "The key claims of the answer are not in the retrieved evidence (fabricated).",
    "off_topic": "The answer, or the retrieved evidence, is unrelated to the question.",
}


def call_clef(token, state, criteria):
    payload = {
        "model": "clef",
        "state": state,
        "questions": {
            "verdict": {
                "type": "choice",
                "instructions": "Classify how well the answer to this Korean HR policy question is supported by the retrieved evidence. Pick exactly one option.",
                "criteria": criteria,
            }
        },
    }
    url = f"{BASE}/@cf/cloudflare/clef"
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method="POST",
    )
    t0 = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=90) as resp:
            body = json.load(resp)
    except urllib.error.HTTPError as e:
        return None, round((time.monotonic() - t0) * 1000), f"HTTP {e.code}: {e.read().decode('utf-8', 'replace')[:200]}"
    dt = round((time.monotonic() - t0) * 1000)
    if not body.get("success"):
        return None, dt, f"api success=false: {json.dumps(body)[:200]}"
    return body.get("result"), dt, None


def parse_verdict(raw):
    answers = (raw or {}).get("answers") or (raw or {}).get("response", {}).get("answers") or {}
    a = answers.get("verdict")
    if isinstance(a, str):
        return a, None
    if isinstance(a, dict):
        for k in ("choice", "answer", "option", "value", "label"):
            if isinstance(a.get(k), str):
                return a[k], a.get("confidence")
        probs = a.get("probabilities") or a.get("probs") or {}
        if probs:
            best = max(probs.items(), key=lambda kv: kv[1] if isinstance(kv[1], (int, float)) else -1)
            return best[0], best[1]
    return None, None


def main():
    token = str(dynamic_credential_entry("custom.cloudflare")["surrogate"]).strip()
    q = json.load(open(f"{DIR}/run_qwen3.json"))
    it = [x for x in q["items"] if x["itemId"] == "gi_s03_leave_3days"][0]
    # evidence_chunks.json has a leading wrangler proxy line, then a JSON array of D1 result sets
    raw_ev = open(f"{DIR}/evidence_chunks.json").read()
    start = raw_ev.find("[")
    ev_sets = json.loads(raw_ev[start:])
    by_id = {}
    for s in ev_sets:
        for row in s.get("results", []):
            by_id[row["id"]] = row
    ev_lines = []
    for cid in it["retrievedIds"]:
        c = by_id.get(cid)
        if c:
            # chunks rows have id/doc_id/article/text; article is the section label
            ev_lines.append(f"[{c.get('doc_id', '')} › {c.get('article', '')}] {c.get('text', '')}")
    state = "\n".join([
        f"질문: {it['question']}",
        f"답: {it['answer']}",
        "채택 근거:",
        "\n".join(ev_lines),
    ])
    print("Qwen3 gi_s03 answer:", it["answer"][:200])
    print("evidence chunks:", it["retrievedIds"])
    results = {}
    for label, criteria in [("OLD", OLD_CRITERIA), ("NEW", NEW_CRITERIA)]:
        raw, ms, err = call_clef(token, state, criteria)
        verdict, conf = parse_verdict(raw) if raw else (None, None)
        results[label] = {"verdict": verdict, "confidence": conf, "latencyMs": ms, "error": err, "raw": raw}
        print(f"{label} criteria: verdict={verdict} conf={conf} ({ms}ms) err={err}")
    json.dump(results, open(f"{DIR}/clef_criteria_fix_test.json", "w"), ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()

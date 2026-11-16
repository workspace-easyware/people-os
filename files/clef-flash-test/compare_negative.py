#!/usr/bin/env python3
"""Negative-case verdict test: clef vs clef-flash (People OS, 2026-11-16).

The golden-set test only covered 'grounded' verdicts (6/6 match). This closes
the gap: synthetic cases where the correct verdict is ungrounded / off_topic /
partial, to confirm flash actually discriminates instead of always saying grounded.
"""
import json
import sys

sys.path.insert(0, "/home/hatch/workspace/goals/cloudflare-developer-day-seoul-2026-use-case-contest-entry/files/people-os/files/clef-flash-test")
from compare_clef_flash import build_verdict_input, parse_verdict, call_ai, MODELS, DIR
from dynamic_credentials import dynamic_credential_entry
import sys as _s
_s.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")

LEAVE_EVIDENCE = [
    {"title": "연차휴가 규정", "section": "제12조", "snippet": "연차휴가는 사용 3일 전까지 신청한다."},
    {"title": "근태 규정", "section": "제8조 지각·결근", "snippet": "지각은 3회 누적 시 1일의 연차에서 차감되며, 무단결근은 1일당 2일의 연차에서 차감된다."},
]

CASES = [
    {
        "id": "neg_ungrounded",
        "question": "연차는 며칠 전에 신청하나요?",
        "answer": "연차는 사용 30일 전에 신청해야 하며, 신청하지 않으면 연차가 소멸됩니다.",
        "evidence": LEAVE_EVIDENCE,
        "expected": "ungrounded",
        "note": "fabricated claims (30일, 소멸) not in evidence",
    },
    {
        "id": "neg_off_topic",
        "question": "점심 뭐 먹지?",
        "answer": "김치찌개가 좋아요.",
        "evidence": LEAVE_EVIDENCE,
        "expected": "off_topic",
        "note": "question/answer unrelated to HR evidence",
    },
    {
        "id": "neg_partial",
        "question": "연차는 며칠 전에 신청하고, 지각하면 어떻게 되나요?",
        "answer": "연차는 사용 3일 전에 신청합니다. 지각은 5회 누적 시 연차에서 차감됩니다.",
        "evidence": LEAVE_EVIDENCE,
        "expected": "partial",
        "note": "first claim supported (3일), second claim wrong (5회 vs 3회)",
    },
]


def main():
    token = str(dynamic_credential_entry("custom.cloudflare")["surrogate"]).strip()
    results = []
    for model in MODELS:
        short = model.split("/")[-1]
        for c in CASES:
            body = build_verdict_input(short, c["question"], c["answer"], c["evidence"])
            out, ms, err = call_ai(token, model, body)
            if err:
                results.append({"model": short, "id": c["id"], "error": err, "latencyMs": ms})
                continue
            v, how = parse_verdict(out)
            results.append({
                "model": short, "id": c["id"], "verdict": v, "how": how,
                "expected": c["expected"], "match": v == c["expected"], "latencyMs": ms,
            })
    json.dump(results, open(f"{DIR}/clef_flash_negative.json", "w"), ensure_ascii=False, indent=2)
    for m in ["clef", "clef-flash", "clef-omni"]:
        rows = [r for r in results if r["model"] == m]
        ok = sum(1 for r in rows if r.get("match"))
        print(f"{m}: match {ok}/3")
        for r in rows:
            print(f"  {r['id']}: verdict={r.get('verdict')} expected={r.get('expected')} match={r.get('match')} ({r.get('how')}) {r.get('latencyMs')}ms err={r.get('error')}")


if __name__ == "__main__":
    main()

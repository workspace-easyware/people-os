#!/usr/bin/env python3
"""Clef vs clef-flash verdict/topic-guard comparison (People OS, 2026-11-16).

Calls the Workers AI REST API directly for both models with IDENTICAL inputs
(the same (question, answer, evidence) the live eval verdict saw, rebuilt from
run_76fc3e88d6074319 + remote D1 chunks), plus topic-guard probes.
Compares verdicts, measures latency. Cost follows from published rates:
  clef 21,818 neurons/1M input tokens ($0.24), clef-flash 3,455 ($0.038).
Auth: surrogate token via dynamic_credential_entry; the runtime swaps it for
the real credential on api.cloudflare.com requests. Never prints the token.
"""
import json
import sys
import time
import urllib.request

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import dynamic_credential_entry

ACCOUNT_ID = "44501085a1a83d8c0f838a44c1800144"
BASE = f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/run"
MODELS = ["@cf/cloudflare/clef", "@cf/cloudflare/clef-flash", "@cf/cloudflare/clef-omni"]
DIR = "/home/hatch/workspace/goals/cloudflare-developer-day-seoul-2026-use-case-contest-entry/files/people-os/files/clef-flash-test"

CLEF_CRITERIA = {
    "grounded": "Every key claim in the answer is present in the retrieved evidence.",
    "partial": "Some claims are supported by the evidence; others are missing from it or uncertain.",
    "ungrounded": "The key claims of the answer are not in the retrieved evidence (fabricated).",
    "off_topic": "The answer, or the retrieved evidence, is unrelated to the question.",
}
VERDICTS = ["grounded", "partial", "ungrounded", "off_topic"]
TOPIC_CRITERIA = {
    "work_related": "질문이 인사 규정, 회사 문서, 코칭, 업로드 문서와 관련이 있다.",
    "off_topic": "질문이 업무와 무관하다 (날씨, 스포츠, 연예, 일상 잡담, 일반 상식 등).",
}
SNIPPET_CHARS = 220


def format_evidence(evidence):
    if not evidence:
        return "(채택 근거 없음)"
    lines = []
    for i, e in enumerate(evidence):
        snip = (e.get("snippet") or "").replace("\n", " ")
        # collapse whitespace like the TS version (/\s+/g -> " ")
        snip = " ".join(snip.split())[:SNIPPET_CHARS]
        sec = f" › {e['section']}" if e.get("section") else ""
        lines.append(f"{i+1}. {e['title']}{sec} › {snip}")
    return "\n".join(lines)


def build_verdict_input(model_short, question, answer, evidence):
    state = "\n".join([f"질문: {question}", f"답: {answer}", "채택 근거:", format_evidence(evidence)])
    return {
        "model": model_short,
        "state": state,
        "questions": {
            "verdict": {
                "type": "choice",
                "instructions": "Classify how well the answer to this Korean HR policy question is supported by the retrieved evidence. Pick exactly one option.",
                "criteria": CLEF_CRITERIA,
            }
        },
    }


def build_topic_input(model_short, question):
    state = "\n".join(["업무 범위: 인사 규정, 회사 문서, 코칭, 업로드 문서에 대한 질문.", f"질문: {question}"])
    return {
        "model": model_short,
        "state": state,
        "questions": {
            "topic": {
                "type": "choice",
                "instructions": "이 질문이 업무 범위(인사 규정, 회사 문서, 코칭, 업로드 문서)와 관련이 있는지 판단한다. 딱 하나만 고른다.",
                "criteria": TOPIC_CRITERIA,
            }
        },
    }


def as_verdict(v):
    if not isinstance(v, str):
        return None
    s = v.strip().lower().replace(" ", "_").replace("-", "_")
    return s if s in VERDICTS else None


def parse_verdict(raw):
    root = raw if isinstance(raw, dict) else {}
    answers = root.get("answers") or (root.get("response") or {}).get("answers")
    if not isinstance(answers, dict):
        return None, "no answers field"
    a = answers.get("verdict")
    d = as_verdict(a)
    if d:
        return d, "direct string"
    if not isinstance(a, dict):
        return None, "unparseable"
    for k in ["choice", "answer", "option", "value", "label"]:
        v = as_verdict(a.get(k))
        if v:
            conf = a.get("confidence")
            return v, f"via {k}" + (f" conf={conf}" if isinstance(conf, (int, float)) else "")
    probs = a.get("probabilities") or a.get("probs")
    if isinstance(probs, dict):
        best, best_p = None, -1
        for k, p in probs.items():
            v = as_verdict(k)
            if v and isinstance(p, (int, float)) and p > best_p:
                best, best_p = v, p
        if best:
            return best, f"probs p={best_p}"
    return None, "unparseable"


def as_topic(v):
    if not isinstance(v, str):
        return None
    s = v.strip().lower().replace(" ", "_").replace("-", "_")
    return s if s in ("work_related", "off_topic") else None


def parse_topic(raw):
    root = raw if isinstance(raw, dict) else {}
    answers = root.get("answers") or (root.get("response") or {}).get("answers")
    if not isinstance(answers, dict):
        return None, None, "no answers field"
    a = answers.get("topic")
    d = as_topic(a)
    if d:
        return d == "off_topic", 1.0, "direct string"
    if not isinstance(a, dict):
        return None, None, "unparseable"
    choice = None
    for k in ["choice", "answer", "option", "value", "label"]:
        c = as_topic(a.get(k))
        if c:
            choice = c
            break
    probs = a.get("probabilities") or a.get("probs")
    p_off = None
    if isinstance(probs, dict):
        p_off = probs.get("off_topic")
    if choice is None and isinstance(probs, dict):
        best = max(((as_topic(k), p) for k, p in probs.items() if as_topic(k) and isinstance(p, (int, float))), key=lambda x: x[1], default=None)
        if best:
            choice, p_off = best
    if choice is None:
        return None, None, "unparseable"
    conf = p_off if isinstance(p_off, (int, float)) else 1.0
    return choice == "off_topic", conf, f"choice={choice} p_off={p_off}"


def call_ai(token, model, body):
    url = f"{BASE}/{model}"
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method="POST",
    )
    t0 = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            payload = json.load(resp)
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")[:500]
        return None, round((time.monotonic() - t0) * 1000), f"HTTP {e.code}: {raw}"
    dt = round((time.monotonic() - t0) * 1000)
    if not payload.get("success"):
        return None, dt, f"api success=false: {json.dumps(payload)[:400]}"
    return payload.get("result"), dt, None


def main():
    token = str(dynamic_credential_entry("custom.cloudflare")["surrogate"]).strip()
    assert token.startswith("hsurr:"), "no surrogate"

    run = json.load(open(f"{DIR}/run_76fc3e88d6074319.json"))
    raw_chunks = open(f"{DIR}/evidence_chunks.json").read()
    # wrangler prints a "Proxy environment variables..." line before the JSON.
    i = raw_chunks.find("[")
    chunks = json.loads(raw_chunks[i:])
    # wrangler d1 --json returns a list of {results:[...]} (first element) or a dict
    if isinstance(chunks, list):
        chunk_rows = chunks[0].get("results", []) if chunks else []
    else:
        chunk_rows = chunks.get("results", [])
    by_id = {r["id"]: r for r in chunk_rows}

    # Build verdict cases: same (question, answer, evidence) as the live eval saw.
    cases = []
    for it in run["items"]:
        ev = []
        for cid in it["retrievedIds"][:5]:
            c = by_id.get(cid)
            if c:
                ev.append({"title": c["title"], "section": c["article"], "snippet": c["text"]})
        cases.append({
            "itemId": it["itemId"],
            "question": it["question"],
            "answer": it["answer"],
            "evidence": ev,
            "clef_verdict": it["verdict"],
            "judge": it["judgeScore"],
        })
    missing = [c["itemId"] for c in cases if not c["evidence"]]
    if missing:
        print("WARNING: no evidence reconstructed for", missing)

    topic_cases = [
        ("점심 뭐 먹지?", True),
        ("오늘 기분이 우울해", True),
        ("연차 신청 어떻게 해요?", False),
        ("출장비 정산은 어떻게 하나요?", False),
    ]

    results = {"verdict": [], "topic": []}
    for model in MODELS:
        short = model.split("/")[-1]  # clef | clef-flash
        for c in cases:
            body = build_verdict_input(short, c["question"], c["answer"], c["evidence"])
            out, ms, err = call_ai(token, model, body)
            if err:
                results["verdict"].append({"model": short, "itemId": c["itemId"], "error": err, "latencyMs": ms})
                continue
            v, how = parse_verdict(out)
            results["verdict"].append({
                "model": short, "itemId": c["itemId"], "verdict": v, "how": how,
                "latencyMs": ms, "clef_verdict": c["clef_verdict"], "match": v == c["clef_verdict"],
                "raw_keys": list(out.keys()) if isinstance(out, dict) else type(out).__name__,
            })
        for q, expect_off in topic_cases:
            body = build_topic_input(short, q)
            out, ms, err = call_ai(token, model, body)
            if err:
                results["topic"].append({"model": short, "question": q, "error": err, "latencyMs": ms})
                continue
            off, conf, how = parse_topic(out)
            results["topic"].append({
                "model": short, "question": q, "offTopic": off, "confidence": conf, "how": how,
                "latencyMs": ms, "expected_off": expect_off,
                "match": (off == expect_off) if off is not None else None,
                "would_block": bool(off and conf is not None and conf >= 0.85),
            })

    json.dump(results, open(f"{DIR}/clef_flash_results.json", "w"), ensure_ascii=False, indent=2)

    # Summary
    print("=== VERDICT (6 golden items, live clef verdict = grounded for all) ===")
    for m in ["clef", "clef-flash", "clef-omni"]:
        rows = [r for r in results["verdict"] if r["model"] == m]
        ok = sum(1 for r in rows if r.get("match"))
        lat = [r["latencyMs"] for r in rows if "latencyMs" in r]
        print(f"{m}: match {ok}/6 | latency ms: {lat} | avg {sum(lat)/len(lat):.0f}ms")
        for r in rows:
            print(f"  {r['itemId']}: verdict={r.get('verdict')} ({r.get('how')}) err={r.get('error')}")
    print("=== TOPIC GUARD (2 off-topic, 2 work-related) ===")
    for m in ["clef", "clef-flash", "clef-omni"]:
        rows = [r for r in results["topic"] if r["model"] == m]
        ok = sum(1 for r in rows if r.get("match"))
        lat = [r["latencyMs"] for r in rows if "latencyMs" in r]
        print(f"{m}: match {ok}/4 | latency ms: {lat} | avg {sum(lat)/len(lat):.0f}ms")
        for r in rows:
            print(f"  {r['question']!r}: offTopic={r.get('offTopic')} conf={r.get('confidence')} would_block={r.get('would_block')} err={r.get('error')}")


if __name__ == "__main__":
    main()

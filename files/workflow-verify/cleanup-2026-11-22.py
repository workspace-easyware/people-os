#!/usr/bin/env python3
"""11-25 정리 (2026-11-22 앞당김): 테스트 문서·녹음·덱을 라이브 API로 삭제한다.

임시 hr_admin 세션 쿠키(cleanup-token.txt)를 쓴다. 토큰은 절대 출력하지 않는다.
삭제 대상은 files/workflow-verify/cleanup-2026-11-22/RESULT.md에 기록된 목록과 같다.
"""
import json
import sys
import time
import urllib.request
import urllib.error

BASE = "https://people-os.workspace-easyware.workers.dev"
TOKEN_FILE = "/home/hatch/workspace/goals/cloudflare-developer-day-seoul-2026-use-case-contest-entry/files/people-os/files/workflow-verify/cleanup-token.txt"

RECORDINGS_READY = [
    "rec_mwej4tl8_qdmuxc",  # original.mp3 -> doc_mwej585g
    "rec_mweo0ep4_pmou40",  # original.mp3 -> doc_mweo0s19
    "rec_mweobnho_3l5wh5",  # clip2min -> doc_mweobwdg
    "rec_mweq8csc_yjp0rf",  # seg4 -> doc_mweq8vjk
    "rec_mweqo8bw_rgli6q",  # original_0_krwd -> doc_mweryu3r
    "rec_mwf0o72z_ash50b",  # clip2min -> doc_mwf0om6x
]
DOCS = [
    # 11월 팀 회의 전사본 (샘플) 10건
    "doc_mwe8psey_gbsoak", "doc_mwe8wi96_n66p2l", "doc_mwe90hm2_tcwcp0",
    "doc_mwe94mc6_09sj6m", "doc_mwe98h0z_m6f83r", "doc_mweb1z26_yg185i",
    "doc_mwedegra_jvs3aw", "doc_mwedh15o_ykefyt", "doc_mweizjym_vjkiuj",
    "doc_mwf12bwo_8jrjox",
    # 파일 형식 테스트 4건
    "doc_mwf2u736_hzwr1s", "doc_mwf2xiux_p9tph7",
    "doc_mwf32vxe_b877cg", "doc_mwf338kr_nlv2jq",
]
DECKS = [
    "deck_mwedg0yr_wxjtb2", "deck_mwedhk3l_2ha7va",
    "deck_mwf13o6i_zxymhh", "deck_mwf14fsf_nmvrnq",
]


def call(token: str, method: str, path: str):
    req = urllib.request.Request(
        BASE + path, method=method,
        headers={"Cookie": f"people_os_session={token}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return resp.status, resp.read().decode()[:200]
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:200]
    except Exception as e:
        return 0, str(e)[:200]


def main() -> int:
    with open(TOKEN_FILE) as f:
        token = f.read().strip()
    results = []
    for group, path_tmpl, ids in [
        ("recording", "/api/recordings/{}", RECORDINGS_READY),
        ("document", "/api/documents/{}", DOCS),
        ("deck", "/api/decks/{}", DECKS),
    ]:
        for rid in ids:
            status, body = call(token, "DELETE", path_tmpl.format(rid))
            print(f"{group} {rid} -> {status} {body}")
            results.append((group, rid, status))
            time.sleep(0.3)
    failed = [r for r in results if r[2] != 200]
    print(f"done: {len(results) - len(failed)}/{len(results)} ok")
    if failed:
        print("FAILED:", failed)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

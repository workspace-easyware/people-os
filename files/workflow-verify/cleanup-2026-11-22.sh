#!/bin/bash
# 11-25 정리 (2026-11-22 앞당김): 테스트 녹음·문서·덱을 라이브 API로 삭제한다.
# python urllib은 workers.dev에서 1010으로 막히므로 curl을 쓴다.
# 임시 hr_admin 세션 쿠키(cleanup-token.txt)를 쓴다. 토큰은 절대 출력하지 않는다.
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
T=$(cat "$DIR/cleanup-token.txt")
BASE="https://people-os.workspace-easyware.workers.dev"

del() {
  local kind="$1" id="$2" path="$3"
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE "$BASE$path" -H "Cookie: people_os_session=$T")
  echo "$kind $id -> $code"
  sleep 0.3
}

for id in rec_mwej4tl8_qdmuxc rec_mweo0ep4_pmou40 rec_mweobnho_3l5wh5 rec_mweq8csc_yjp0rf rec_mweqo8bw_rgli6q rec_mwf0o72z_ash50b; do
  del recording "$id" "/api/recordings/$id"
done
for id in doc_mwe8psey_gbsoak doc_mwe8wi96_n66p2l doc_mwe90hm2_tcwcp0 doc_mwe94mc6_09sj6m doc_mwe98h0z_m6f83r doc_mweb1z26_yg185i doc_mwedegra_jvs3aw doc_mwedh15o_ykefyt doc_mweizjym_vjkiuj doc_mwf12bwo_8jrjox doc_mwf2u736_hzwr1s doc_mwf2xiux_p9tph7 doc_mwf32vxe_b877cg doc_mwf338kr_nlv2jq; do
  del document "$id" "/api/documents/$id"
done
for id in deck_mwedg0yr_wxjtb2 deck_mwedhk3l_2ha7va deck_mwf13o6i_zxymhh deck_mwf14fsf_nmvrnq; do
  del deck "$id" "/api/decks/$id"
done
echo done

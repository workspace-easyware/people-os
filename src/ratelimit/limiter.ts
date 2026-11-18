// DO-3 정밀 레이트 리미터 (2026-11-18). 클라이언트 키 1개 = DO 인스턴스 1개 (idFromName('rl:ask:' + clientKey)).
// 토큰 버킷: 용량 20, 보충 분당 20개(3초당 1개). DO는 입력 게이트로 요청을 순차 처리하므로 동시 버스트도 정확히 센다.
// 보충은 두 겹이다: (1) 요청이 올 때마다 경과 시간만큼 먼저 채우는 lazy refill — 알람이 늦어도 제한이 느슨해지지 않는다.
// (2) Alarms API — 버킷이 덜 찼으면 다음 토큰 시점에 알람을 걸어 두고, 가득 차면 저장소를 비운다(유휴 DO가 상태를 안 남김).
// 상태는 DO storage에 둔다(인메모리 캐시 없음) — DO가 내려갔다 올라와도 버킷이 유지된다.
// 프로토콜: POST https://limiter/check → {allowed, remaining, resetInSec}. index.ts checkAskRateLimit의 반환 형태와 같다.

export const RL_CAPACITY = 20;
export const RL_REFILL_MS = 3000; // 토큰 1개당 (분당 20개)
const KEY = "bucket";

interface Bucket {
  tokens: number; // 소수 허용 (경과 시간 비례 보충)
  at: number; // 마지막으로 tokens를 갱신한 시각 (ms)
}

export interface LimiterResult {
  allowed: boolean;
  remaining: number;
  resetInSec: number;
}

export class RateLimiter {
  state: DurableObjectState;

  constructor(state: DurableObjectState, _env: unknown) {
    this.state = state;
  }

  // 테스트에서 시계를 바꿀 수 있게 분리 (운영은 Date.now).
  protected now(): number {
    return Date.now();
  }

  private refill(b: Bucket | undefined, now: number): Bucket {
    if (!b || typeof b.tokens !== "number" || typeof b.at !== "number") return { tokens: RL_CAPACITY, at: now };
    const elapsed = Math.max(0, now - b.at); // 시계가 뒤로 가도 토큰을 깎지 않는다
    return { tokens: Math.min(RL_CAPACITY, b.tokens + elapsed / RL_REFILL_MS), at: now };
  }

  async fetch(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    if (path !== "/check" || req.method !== "POST") return new Response("not found", { status: 404 });

    const now = this.now();
    const b = this.refill(await this.state.storage.get<Bucket>(KEY), now);
    let result: LimiterResult;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      result = { allowed: true, remaining: Math.floor(b.tokens), resetInSec: Math.max(1, Math.ceil(((RL_CAPACITY - b.tokens) * RL_REFILL_MS) / 1000)) };
    } else {
      result = { allowed: false, remaining: 0, resetInSec: Math.max(1, Math.ceil(((1 - b.tokens) * RL_REFILL_MS) / 1000)) };
    }
    await this.state.storage.put(KEY, b);
    // 다음 토큰이 생기는 시각에 알람 (이미 걸려 있어도 덮어써서 항상 가장 가까운 시각 하나만 유지).
    await this.state.storage.setAlarm(now + Math.max(1, Math.ceil((1 - (b.tokens % 1)) * RL_REFILL_MS)));
    return Response.json(result);
  }

  async alarm(): Promise<void> {
    const now = this.now();
    const b = this.refill(await this.state.storage.get<Bucket>(KEY), now);
    if (b.tokens >= RL_CAPACITY) {
      await this.state.storage.deleteAll(); // 가득 참 = 새 버킷과 같다 → 저장소 비움
      return;
    }
    await this.state.storage.put(KEY, b);
    await this.state.storage.setAlarm(now + Math.ceil((1 - (b.tokens % 1)) * RL_REFILL_MS));
  }
}

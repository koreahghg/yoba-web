# YOBA ↔ 웹 서버 Redis 약속 (실시간 모드)

YOBA(사람 검출·블러)와 웹 서버는 **Redis 하나만** 공유합니다. YOBA는 최신 값을 덮어쓰고, 웹 서버는 그 값을 읽어 브라우저에 줍니다. 서로 직접 연결하지 않으므로 한쪽이 죽어도 다른 쪽은 계속 돕니다.

```
CCTV ─RTSP─▶ YOBA (매 프레임: 검출 → 구역 집계 → 블러) ─SET─▶ Redis ◀─GET─ 웹 서버 ─WebSocket/MJPEG─▶ 브라우저
```

## 왜 새 키가 필요한가

지금 YOBA 10초 모드가 쓰는 `yoba:zone:{zone_id}` JSON에는 `level`·`score`만 있고 **사람 수가 없습니다.** 이번 웹은 어드민이 "N명 이하 여유 / M명 이상 혼잡"처럼 **사람 수로** 기준을 정하므로, YOBA가 사람 수를 그대로 보내고 단계 판정은 웹 서버가 합니다. 기존 10초 모드 키는 건드리지 않고 아래 키를 **추가**합니다.

## 키

| 키 | 타입 | 값 | 쓰는 주기 |
|---|---|---|---|
| `yoba:cameras` | SET | 카메라 ID 목록 (`cam01` …) | 시작할 때 1번 + 매번 `SADD`해도 됨 |
| `yoba:live:{camera_id}` | STRING | 아래 JSON | 처리한 프레임마다 (초당 2~10번) |
| `yoba:frame:{camera_id}` | STRING (바이트) | **블러된** JPEG. TTL 5초 (`PX 5000`) | 처리한 프레임마다 |
| `yoba:heartbeat` | STRING | 마지막 동작 시각 (기존 그대로) | 기존 그대로 |

`yoba`는 접두사로, YOBA `service.yaml`의 `redis.key_prefix`와 웹 `.env`의 `REDIS_KEY_PREFIX`를 같게 맞춥니다.

## `yoba:live:{camera_id}` JSON

```json
{
  "camera_id": "cam01",
  "name": "행사장 CCTV",
  "updated_at": "2026-11-20T14:30:00.123+09:00",
  "frame_size": [1280, 720],
  "fps": 7.8,
  "latency_ms": 180,
  "blur_ok": true,
  "blur_fail_total": 3,
  "frames_total": 51234,
  "zones": [
    { "zone_id": "hall_a_front", "name": "입구 앞", "count": 12, "roi": [[120,400],[980,400],[1260,710],[20,710]] }
  ]
}
```

| 필드 | 필수 | 설명 |
|---|---|---|
| `updated_at` | ✅ | 프레임마다 **바뀌는 값**이면 됩니다. 웹은 이 값이 3초 넘게 안 바뀌면 "확인 불가"로 표시합니다. (YOBA와 웹 서버 시계가 달라도 상관없게 시각 비교는 하지 않음) |
| `zones[].count` | ✅ | 그 프레임에서 구역 안에 있는 사람 수 (스무딩 **안 한** 원본). 숫자가 덜 튀게 하는 스무딩은 웹이 합니다. |
| `zones[].roi` | ✅ | 구역 다각형. `cameras.yaml`의 roi를 그대로. 웹이 영상 위에 테두리를 그립니다. |
| `frame_size` | ✅ | roi 좌표의 기준 해상도 `[가로, 세로]` (원본 프레임 크기). 전송 JPEG를 줄였어도 원본 크기를 적으면 됩니다. |
| `name`, `zones[].name` | | 화면에 보일 이름. 없으면 ID를 보여 줌 |
| `fps` | | 실제 처리 fps (어드민 "처리 상태") |
| `latency_ms` | | 프레임 수신 → Redis 전송까지 걸린 시간 |
| `blur_ok` | | 이번 프레임 블러 검증 통과 여부 |
| `blur_fail_total` | | YOBA 시작 후 블러 검증 실패 누적 횟수. 웹이 증가분을 1초 단위로 DB에 쌓아 "오늘 실패 횟수"를 만듭니다 |
| `frames_total` | | 처리한 프레임 누적 수 |

## 개인정보 원칙 (기존 그대로)

- `yoba:frame:*`에는 **블러 검증을 통과한 JPEG만** 씁니다. 실패하면 **검은 JPEG**를 쓰고 `blur_ok: false`로 보냅니다. (사람 수는 그대로 보내도 됨)
- 원본 프레임은 Redis·디스크·로그 어디에도 쓰지 않습니다.
- 웹 서버도 프레임을 저장하지 않고 메모리에 최신 1장만 둡니다.

## YOBA 쪽 구현 예시 (참고용, 실행 검증 안 됨)

`yoba/live.py`의 `run_live` 루프가 이미 매 프레임 검출·집계·블러를 하므로, 화면에 띄우는 대신(또는 함께) Redis에 쓰면 됩니다. 아래는 방향을 보여 주는 스케치이고, 실제 코드에 맞춰 고쳐야 합니다.

```python
# yoba/live_publish.py (제안)
import json, logging, time
from datetime import datetime, timedelta, timezone

import cv2
import numpy as np
import redis

log = logging.getLogger(__name__)
KST = timezone(timedelta(hours=9))


class LivePublisher:
    def __init__(self, client: redis.Redis, camera, prefix: str = "yoba", frame_ttl_ms: int = 5000):
        self.r, self.cam, self.p, self.ttl = client, camera, prefix, frame_ttl_ms
        self.blur_fail_total = 0
        self.frames_total = 0
        ok, buf = cv2.imencode(".jpg", np.zeros((540, 960, 3), np.uint8))
        self._black = buf.tobytes()

    def publish(self, frame_shape, counts: dict, jpeg: bytes | None, fps: float, latency_ms: float) -> None:
        h, w = frame_shape[:2]
        self.frames_total += 1
        blur_ok = jpeg is not None
        if not blur_ok:
            self.blur_fail_total += 1
        payload = {
            "camera_id": self.cam.id,
            "updated_at": datetime.now(KST).isoformat(timespec="milliseconds"),
            "frame_size": [w, h],
            "fps": round(fps, 1),
            "latency_ms": round(latency_ms),
            "blur_ok": blur_ok,
            "blur_fail_total": self.blur_fail_total,
            "frames_total": self.frames_total,
            "zones": [
                {"zone_id": z.zone_id, "count": int(counts[z.zone_id]), "roi": [list(map(int, pt)) for pt in z.roi]}
                for z in self.cam.zones
            ],
        }
        try:
            p = self.r.pipeline()
            p.set(f"{self.p}:frame:{self.cam.id}", jpeg if blur_ok else self._black, px=self.ttl)
            p.set(f"{self.p}:live:{self.cam.id}", json.dumps(payload, ensure_ascii=False))
            p.sadd(f"{self.p}:cameras", self.cam.id)
            p.execute()
        except redis.RedisError as e:  # Redis 장애로 처리 루프가 멈추면 안 됨
            log.warning("live 전송 실패 (%s)", type(e).__name__)
```

루프 안에서는 대략 이렇게 부릅니다.

```python
t0 = time.perf_counter()                       # 새 프레임을 받은 시각
persons = detector.detect([frame])[0].persons
counts = assigner.count(persons)               # {zone_id: 사람 수}
jpeg = privacy_blur(frame, persons, service.blur)   # 실패면 None
del frame                                      # 원본은 바로 버림
publisher.publish(shape, counts, jpeg, fps, (time.perf_counter() - t0) * 1000)
```

> 웹 화면이 구역 테두리와 인원을 직접 그리므로, Redis로 보내는 JPEG에는 테두리·박스를 그리지 않은 **블러만 된 이미지**를 보내 주세요. (`LiveView.process`가 반환하는 `view`는 박스가 그려진 화면이라 그대로 쓰면 안 됨)

## 확인 방법

YOBA를 `uv run yoba --rtsp "rtsp://..." --live --publish`로 켠 상태에서, 웹 저장소에서 아래를 실행하면 Redis에 들어간 값이 이 문서와 맞는지 검사합니다 (읽기만 함).

```bash
npm run check-redis      # ✖가 없으면 웹에 그대로 붙음
```

카메라 없이 웹 쪽을 먼저 확인하려면 웹 저장소의 가짜 YOBA를 씁니다.

```bash
npm run fake-yoba                          # 이 문서 형식대로 Redis에 씀
npm run fake-yoba -- --image sample.jpg    # 사람 없는 사진을 프레임처럼 보냄
npm run fake-yoba -- --stop-after 20       # 20초 뒤 멈춤 → 웹이 3초 안에 "확인 불가"인지 확인
```

Redis에 들어간 값을 직접 보려면:

```bash
redis-cli SMEMBERS yoba:cameras
redis-cli GET yoba:live:cam01
redis-cli STRLEN yoba:frame:cam01      # JPEG 크기 (보통 30~80KB)
```

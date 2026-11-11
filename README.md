# YOBA Web: 행사장 실시간 혼잡도

[YOBA](https://github.com/lkw-k/YOBA)가 CCTV에서 센 사람 수와 블러 영상을 Redis로 넘기면, 이 서버가 방문객 화면과 어드민 화면으로 보여 줍니다. 디자인은 박람회(AI교육원) 대시보드와 같습니다.

- **방문객 화면 `/`**: 지도 혼잡도 링, 현재 화면 사람 수, 여유/보통/혼잡, CCTV 블러 영상 + 구역 오버레이(누르면 확대), 오늘 시간대별 추이
- **어드민 `/admin`**: 혼잡도 기준(사람 수) 조정·미리보기·즉시 반영, 처리 상태(fps·지연·마지막 수신·블러 실패), 1시간 단위 평균 동시 인원, CSV 내보내기

개발 계획과 결정 이유는 [docs/PLAN.md](docs/PLAN.md), YOBA가 Redis에 써야 하는 값은 [docs/REDIS_CONTRACT.md](docs/REDIS_CONTRACT.md)에 있습니다.

## 바로 실행해 보기 (Redis·카메라 없이)

Node.js 22.13 이상이 필요합니다.

```bash
npm install
npm run demo
```

- 방문객 화면: http://localhost:8080
- 어드민: http://localhost:8080/admin (데모 비밀번호 `admin`)
- 어드민 상단의 "데모: 카메라 8초 끊기"를 누르면 방문객 화면이 3초 안에 회색 "확인 불가"로 바뀌는 걸 볼 수 있습니다.

데모 모드는 가짜 인원만 만들고 영상은 없으므로, CCTV 자리에 "데모 화면" 그림이 나옵니다.

## 실제 운영 (Redis 연결)

```bash
cp .env.example .env     # ADMIN_PASSWORD, REDIS_URL 채우기
npm start
```

실제 YOBA(`uv run yoba --rtsp "rtsp://..." --live --publish`)를 켠 뒤 `npm run check-redis`를 실행하면 Redis 값이 약속과 맞는지 검사합니다.

YOBA 없이 Redis 연동만 먼저 확인하려면 다른 터미널에서 가짜 YOBA를 켭니다.

```bash
npm run fake-yoba                          # REDIS_CONTRACT.md 형식대로 Redis에 씀
npm run fake-yoba -- --image sample.jpg    # 사람 없는 사진을 영상 프레임처럼 보냄
npm run fake-yoba -- --stop-after 20       # 20초 뒤 멈춤 → "확인 불가" 확인
```

주요 설정 (`.env`, 전체는 [.env.example](.env.example)):

| 이름 | 기본값 | 설명 |
|---|---|---|
| `ADMIN_PASSWORD` | (필수) | 어드민 비밀번호 |
| `REDIS_URL` | `redis://localhost:6379/0` | YOBA와 같은 Redis |
| `STALE_MS` | `3000` | 이 시간 넘게 갱신 없으면 "확인 불가" |
| `SMOOTHING_SECONDS` | `2` | 화면 숫자 스무딩 정도 |
| `STREAM_MAX_CLIENTS` | `30` | 확대 화면(MJPEG) 동시 시청 상한. 넘으면 1초 스냅샷으로 자동 전환 |

## 배포 (서버 1대)

Node 서버 + Redis + nginx(HTTPS)로 충분합니다. nginx에서는 WebSocket 업그레이드와 MJPEG 버퍼링 끄기가 필요합니다.

```nginx
location /ws {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 1h;
}
location /stream/ {
    proxy_pass http://127.0.0.1:8080;
    proxy_buffering off;
    proxy_read_timeout 1h;
}
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

nginx 뒤에서는 `.env`에 `TRUST_PROXY=1`을 넣습니다. 프로세스 관리는 `pm2 start npm --name yoba-web -- start` 또는 systemd를 쓰면 됩니다.

## 공개 API (박람회 웹 연결용)

| 경로 | 내용 |
|---|---|
| `GET /api/state` | 현재 인원, 단계(`free`/`normal`/`busy`/`unknown`), CCTV 상태, 기준값 |
| `GET /api/hourly` | 오늘 시간대별 평균·최대 동시 인원 (30초 캐시) |
| `WS /ws` | 위 `state`를 0.5초마다 푸시 |
| `GET /snapshot/{cam}.jpg` | 최신 블러 프레임 1장 (끊겼으면 503) |
| `GET /stream/{cam}.mjpg` | 블러 프레임 MJPEG |

`unknown`(확인 불가)은 절대 "여유"로 표시하지 마세요.

## 구조

```
server/
  index.js          HTTP·WebSocket·루프 (Redis 읽기 0.2초, 푸시 0.5초, 기록 1초)
  state.js          스무딩, 3단계 판정, 장애 판정
  store.js          SQLite: 기준값, 1초 기록, 시간대별 집계, 변경 기록
  frames.js         스냅샷·MJPEG 중계
  auth.js           어드민 로그인 (세션 쿠키, 시도 제한)
  source/redis.js   YOBA Redis 읽기
  source/demo.js    데모용 가짜 데이터
public/
  index.html, admin.html
  css/tokens.css    디자인 토큰 (박람회 데모와 같은 값)
  js/               화면 코드 (빌드 없음)
  map/              박람회 지도 SVG
tools/fake-yoba.js  Redis에 가짜 YOBA 값 쓰기
test/               npm test
docs/               개발 계획, Redis 약속
```

## 개인정보

- 원본 프레임은 YOBA 밖으로 나오지 않습니다. 이 서버는 블러된 JPEG 최신 1장만 메모리에 두고 디스크에 저장하지 않습니다.
- YOBA 블러 검증이 실패하면 검은 화면이 송출되고, 실패 횟수는 어드민과 CSV에 남습니다.
- 통계 DB에는 사람 수와 시각만 저장됩니다.

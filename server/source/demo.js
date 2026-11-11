// 데모 소스: Redis·카메라 없이 화면과 어드민을 확인하기 위한 가짜 데이터.
// 인원은 몇 분 주기로 오르내리고, 어드민의 "데모: 연결 끊기"로 장애 화면도 볼 수 있다.
// 영상 프레임은 만들지 않는다 (브라우저가 데모용 그림을 대신 그린다).

const FRAME_SIZE = [960, 540];
const ZONES = [
  { zone_id: 'zone_front', name: '입구 앞', roi: [[60, 300], [520, 300], [560, 530], [20, 530]], base: 9 },
  { zone_id: 'zone_hall', name: '메인홀', roi: [[300, 120], [900, 120], [940, 300], [560, 300], [520, 300], [250, 300]], base: 16 },
];

export function createDemoSource() {
  const started = Date.now();
  let outageUntil = 0;
  let blurFailTotal = 0;
  let frames = 0;

  return {
    kind: 'demo',
    health: () => ({ ok: true, status: 'demo', error: null }),

    async readCameras() {
      const now = Date.now();
      if (now < outageUntil) return []; // 끊긴 동안 값이 갱신되지 않음 → 웹이 "확인 불가"로 판정
      const t = (now - started) / 1000;
      const wave = 0.5 + 0.5 * Math.sin(t / 45); // 약 4.7분 주기
      frames += 4;
      if (Math.random() < 0.0003) blurFailTotal += 1;
      return [{
        camera_id: 'cam01',
        name: '행사장 CCTV',
        updated_at: new Date(now).toISOString(),
        frame_size: FRAME_SIZE,
        fps: +(7 + Math.random() * 1.5).toFixed(1),
        latency_ms: Math.round(140 + Math.random() * 80),
        blur_ok: true,
        blur_fail_total: blurFailTotal,
        frames_total: frames,
        zones: ZONES.map((z) => ({
          zone_id: z.zone_id,
          name: z.name,
          roi: z.roi,
          count: Math.max(0, Math.round(z.base * (0.3 + 2.2 * wave) + (Math.random() - 0.5) * 6)),
        })),
      }];
    },

    async readFrame() {
      return null;
    },

    simulateOutage(seconds = 8) {
      outageUntil = Date.now() + seconds * 1000;
    },

    close: async () => {},
  };
}

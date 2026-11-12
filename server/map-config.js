// 지도(public/map/map_traffic.svg)의 주차장 점과 도로 구간 정의.
// svg: SVG 요소 id. its_links: 국가교통정보센터 링크 ID (npm run its-links로 찾아서 채움).
// 속도 기준(km/h): free_kmh 이상 원활, jam_kmh 미만 정체, 그 사이 서행.

export const PARKING = [
  { id: 'training_center', name: '교육연수원', svg: 'dot-training-center' },
  { id: 'usan_middle', name: '우산중', svg: 'dot-usan-middle' },
  { id: 'munjeong_girls_high', name: '문정여고', svg: 'dot-munjeong-girls-high' },
  { id: 'munjeong_elementary', name: '문정초', svg: 'dot-munjeong-elementary' },
  { id: 'munsan_middle', name: '문산중', svg: 'dot-munsan-middle' },
  { id: 'ojeong_elementary', name: '오정초', svg: 'dot-ojeong-elementary' },
  { id: 'yongbong_middle', name: '용봉중', svg: 'dot-yongbong-middle' },
  { id: 'munwoo_elementary', name: '문우초', svg: 'dot-munwoo-elementary' },
  { id: 'munheung_middle', name: '문흥중', svg: 'dot-munheung-middle' },
];

// ITS 링크는 AI교육원으로 들어가는 방향(지도 화살표 방향)만 넣었다. 2026-11-12에 ITS 노드 연결
// (시작·끝 노드)과 OpenStreetMap 도로 모양으로 경로를 확인함:
//   동광주IC ─천지인로─ 1780024800 ─문산로─ 1780027500(문흥중앙초) ─대천로─ 1780028600 ─대천로─
//   1780028500 ─대천로─ 1780028300(문흥중·문우초 앞) ─능안로─ 1780029500 (빛고을국민안전체험관 쪽)
// 속도 기준은 신호 많은 동네 길이라 낮게 잡았다. 행사 당일 실제 값을 보고 조정.
export const TRAFFIC = [
  { id: 'dg-01', name: '동광주IC 연결로 (천지인로)', svg: 'traffic-dg-01', its_links: ['1780064700'], free_kmh: 30, jam_kmh: 15 },
  { id: 'dg-02', name: 'IC → 문흥중앙초 (문산로)', svg: 'traffic-dg-02', its_links: ['1780064600'], free_kmh: 20, jam_kmh: 10 },
  { id: 'dg-03', name: '문흥중앙초 → 중앙분기 (대천로)', svg: 'traffic-dg-03', its_links: ['1780072500'], free_kmh: 20, jam_kmh: 10 },
  { id: 'dg-04', name: '중앙분기 연결부 (대천로)', svg: 'traffic-dg-04', its_links: ['1780075100'], free_kmh: 20, jam_kmh: 10 },
  { id: 'dg-05', name: 'AI교육원 남측 접근로 (대천로)', svg: 'traffic-dg-05', its_links: ['1780074500'], free_kmh: 20, jam_kmh: 10 },
  { id: 'dg-06', name: 'AI교육원 진입로 (능안로)', svg: 'traffic-dg-06', its_links: ['1780074800'], free_kmh: 20, jam_kmh: 10 },
];

// ITS 조회 범위 (경도 minX~maxX, 위도 minY~maxY). 위 6구간만 덮도록 좁힘 (응답이 작아짐)
export const ITS_BBOX = { minX: 126.914, maxX: 126.93, minY: 35.181, maxY: 35.19 };

export const PARKING_STATUS = ['free', 'busy', 'full', 'unknown'];
export const TRAFFIC_MODES = ['auto', 'free', 'busy', 'jam', 'unknown'];

// SQLite 저장소 (Node 내장 node:sqlite). 설정값, 1초 인원 기록, 어드민 변경 기록.
//
// 기록하는 값은 "그 순간 화면에 보인 사람 수"다. YOBA는 사람을 추적하지 않으므로
// 누적 방문자 수는 만들 수 없고, 통계는 "평균 동시 인원"으로만 낸다.

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const TOTAL_ID = '_total';
const KST_MS = 9 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;

export const DEFAULT_SETTINGS = {
  total: { free_max: 20, busy_min: 50 },
  zones: {},
};

/** KST 기준 오늘 날짜 'YYYY-MM-DD' */
export function todayKst(now = Date.now()) {
  return new Date(now + KST_MS).toISOString().slice(0, 10);
}

/** 'YYYY-MM-DD'(KST) → [시작ms, 끝ms) */
export function dayRangeKst(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('날짜 형식은 YYYY-MM-DD');
  const start = Date.parse(`${date}T00:00:00Z`) - KST_MS;
  if (!Number.isFinite(start)) throw new Error('잘못된 날짜');
  return [start, start + DAY_MS];
}

export function openStore(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS samples (
      ts INTEGER NOT NULL,          -- 기록 시각 (ms, UTC)
      camera_id TEXT NOT NULL,      -- 카메라 ID 또는 '_total'(전체 합)
      online INTEGER NOT NULL,      -- 1: 정상 수신, 0: 확인 불가
      count REAL,                   -- 스무딩한 인원 (화면에 보인 값)
      raw INTEGER,                  -- 스무딩 전 인원
      blur_fail INTEGER NOT NULL DEFAULT 0  -- 직전 기록 이후 블러 검증 실패 횟수
    );
    CREATE INDEX IF NOT EXISTS samples_cam_ts ON samples (camera_id, ts);
    CREATE TABLE IF NOT EXISTS admin_log (ts INTEGER NOT NULL, action TEXT NOT NULL, detail TEXT);
  `);

  const getSetting = db.prepare('SELECT value FROM settings WHERE key = ?');
  const putSetting = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  );
  const insSample = db.prepare(
    'INSERT INTO samples (ts, camera_id, online, count, raw, blur_fail) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const insLog = db.prepare('INSERT INTO admin_log (ts, action, detail) VALUES (?, ?, ?)');

  // 1시간 단위 집계. online=0인 초는 평균에서 뺀다 (카메라가 꺼진 시간을 0명으로 치지 않음).
  // SQLite는 MAX()와 함께 쓴 일반 컬럼에 최댓값 행의 값을 준다 → peak_ts.
  const hourlyStmt = db.prepare(`
    SELECT
      CAST(((ts + ${KST_MS}) % ${DAY_MS}) / 3600000 AS INTEGER) AS hour,
      COUNT(*) AS samples,
      SUM(online) AS online_samples,
      AVG(CASE WHEN online = 1 THEN count END) AS avg_count,
      MAX(CASE WHEN online = 1 THEN count END) AS max_count,
      ts AS peak_ts,
      SUM(blur_fail) AS blur_fail
    FROM samples
    WHERE camera_id = ? AND ts >= ? AND ts < ?
    GROUP BY hour
    ORDER BY hour
  `);
  const blurFailStmt = db.prepare(
    `SELECT COALESCE(SUM(blur_fail), 0) AS n FROM samples WHERE camera_id = ? AND ts >= ? AND ts < ?`,
  );
  const minuteStmt = db.prepare(`
    SELECT (ts / 60000) * 60000 AS minute_ts,
           AVG(CASE WHEN online = 1 THEN count END) AS avg_count,
           MAX(CASE WHEN online = 1 THEN count END) AS max_count,
           SUM(online) AS online_samples, COUNT(*) AS samples,
           SUM(blur_fail) AS blur_fail
    FROM samples WHERE camera_id = ? AND ts >= ? AND ts < ?
    GROUP BY minute_ts ORDER BY minute_ts
  `);
  const logStmt = db.prepare('SELECT ts, action, detail FROM admin_log ORDER BY ts DESC LIMIT ?');

  return {
    getSettings() {
      const row = getSetting.get('thresholds');
      if (!row) return structuredClone(DEFAULT_SETTINGS);
      try {
        const v = JSON.parse(row.value);
        return { total: v.total ?? DEFAULT_SETTINGS.total, zones: v.zones ?? {} };
      } catch {
        return structuredClone(DEFAULT_SETTINGS);
      }
    },
    saveSettings(settings) {
      putSetting.run('thresholds', JSON.stringify(settings));
    },

    /** rows: [{camera_id, online, count, raw, blur_fail}] — 한 트랜잭션 */
    recordSamples(ts, rows) {
      db.exec('BEGIN');
      try {
        for (const r of rows) insSample.run(ts, r.camera_id, r.online ? 1 : 0, r.count, r.raw, r.blur_fail || 0);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },

    hourly(date, cameraId = TOTAL_ID) {
      const [start, end] = dayRangeKst(date);
      const rows = hourlyStmt.all(cameraId, start, end);
      const byHour = new Map(rows.map((r) => [r.hour, r]));
      return Array.from({ length: 24 }, (_, hour) => {
        const r = byHour.get(hour);
        if (!r) return { hour, samples: 0, online_samples: 0, avg: null, max: null, peak_at: null, blur_fail: 0 };
        return {
          hour,
          samples: r.samples,
          online_samples: r.online_samples,
          avg: r.avg_count === null ? null : +r.avg_count.toFixed(1),
          max: r.max_count === null ? null : Math.round(r.max_count),
          peak_at: r.max_count === null ? null : r.peak_ts,
          blur_fail: r.blur_fail,
        };
      });
    },

    minutely(date, cameraId = TOTAL_ID) {
      const [start, end] = dayRangeKst(date);
      return minuteStmt.all(cameraId, start, end);
    },

    blurFailCount(date, cameraId = TOTAL_ID) {
      const [start, end] = dayRangeKst(date);
      return blurFailStmt.get(cameraId, start, end).n;
    },

    log(action, detail) {
      insLog.run(Date.now(), action, detail === undefined ? null : JSON.stringify(detail));
    },
    recentLog(limit = 20) {
      return logStmt.all(limit).map((r) => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null }));
    },

    close: () => db.close(),
  };
}

/** 1초마다 현재 상태를 samples에 쌓는다. 블러 실패는 YOBA 누적값의 증가분으로 계산. */
export function createRecorder(store) {
  const lastBlurTotal = new Map();
  return function record(state, now = Date.now()) {
    const diag = state.diagnostics(now);
    if (diag.length === 0) return;
    let total = 0;
    let totalRaw = 0;
    let anyOnline = false;
    let blurSum = 0;
    const rows = diag.map((d) => {
      let blurFail = 0;
      if (d.online && Number.isFinite(d.blur_fail_total)) {
        const prev = lastBlurTotal.get(d.id);
        // YOBA가 재시작해 누적값이 줄면 새 값 전체를 증가분으로 본다
        if (prev !== undefined) blurFail = d.blur_fail_total >= prev ? d.blur_fail_total - prev : d.blur_fail_total;
        lastBlurTotal.set(d.id, d.blur_fail_total);
      }
      if (d.online) {
        anyOnline = true;
        total += d.smooth_count ?? 0;
        totalRaw += d.raw_count ?? 0;
      }
      blurSum += blurFail;
      return {
        camera_id: d.id,
        online: d.online,
        count: d.online ? d.smooth_count : null,
        raw: d.online ? d.raw_count : null,
        blur_fail: blurFail,
      };
    });
    rows.push({ camera_id: TOTAL_ID, online: anyOnline, count: anyOnline ? total : null, raw: anyOnline ? totalRaw : null, blur_fail: blurSum });
    store.recordSamples(now, rows);
  };
}

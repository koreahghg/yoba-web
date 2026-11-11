// 어드민 로그인: 비밀번호 1개(.env ADMIN_PASSWORD) + 메모리 세션 쿠키.
// 서버를 재시작하면 다시 로그인해야 한다 (행사용 단일 서버라 이 정도로 충분).

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const COOKIE = 'yoba_admin';
const SESSION_MS = 12 * 3600 * 1000;
const MAX_ATTEMPTS = 5;
const ATTEMPT_WINDOW_MS = 60 * 1000;

const digest = (s) => createHash('sha256').update(String(s)).digest();

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function createAuth(password) {
  const expected = digest(password);
  const sessions = new Map(); // token → expiresAt
  const attempts = new Map(); // ip → {n, resetAt}

  const sweep = () => {
    const now = Date.now();
    for (const [t, exp] of sessions) if (exp < now) sessions.delete(t);
    for (const [ip, a] of attempts) if (a.resetAt < now) attempts.delete(ip);
  };
  setInterval(sweep, 60_000).unref();

  const isAuthed = (req) => {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    const exp = token && sessions.get(token);
    return Boolean(exp && exp > Date.now());
  };

  return {
    isAuthed,

    require(req, res, next) {
      if (isAuthed(req)) return next();
      res.status(401).json({ error: '로그인이 필요합니다.' });
    },

    login(req, res) {
      const ip = req.ip || 'unknown';
      const now = Date.now();
      const a = attempts.get(ip) || { n: 0, resetAt: now + ATTEMPT_WINDOW_MS };
      if (a.resetAt < now) Object.assign(a, { n: 0, resetAt: now + ATTEMPT_WINDOW_MS });
      if (a.n >= MAX_ATTEMPTS) {
        return res.status(429).json({ error: '시도가 너무 많습니다. 1분 뒤 다시 시도해 주세요.' });
      }
      a.n += 1;
      attempts.set(ip, a);

      const ok = timingSafeEqual(digest(req.body?.password ?? ''), expected);
      if (!ok) return res.status(401).json({ error: '비밀번호가 맞지 않습니다.' });

      attempts.delete(ip);
      const token = randomBytes(32).toString('hex');
      sessions.set(token, now + SESSION_MS);
      const secure = req.secure ? '; Secure' : '';
      res.setHeader(
        'Set-Cookie',
        `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}${secure}`,
      );
      res.json({ ok: true });
    },

    logout(req, res) {
      const token = parseCookies(req.headers.cookie)[COOKIE];
      if (token) sessions.delete(token);
      res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
      res.json({ ok: true });
    },
  };
}

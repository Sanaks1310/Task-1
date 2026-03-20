/**
 * ZEGIRON Command — Auth Middleware
 * gateway/src/auth-middleware.ts
 *
 * Stateless JWT verification with optional Redis revocation list.
 * Verification happens at WebSocket UPGRADE time — rejected clients
 * never open a socket, consuming zero server resources.
 *
 * Roles (least → most privileged):
 *   READONLY    view tracks + critical alerts
 *   OPERATOR    READONLY + geo filter + ack alerts
 *   ANALYST     OPERATOR + history + replay + export
 *   SUPERVISOR  ANALYST  + create alerts + sensor config
 *   ADMIN       all channels + system operations
 */

import jwt from 'jsonwebtoken';
import { createClient, type RedisClientType } from 'redis';
import pino from 'pino';

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });

// ─── Types ────────────────────────────────────────────────────────────────────
export type Role = 'READONLY' | 'OPERATOR' | 'ANALYST' | 'SUPERVISOR' | 'ADMIN';

export interface TokenPayload {
  sub:  string;   // userId (UUID)
  role: Role;
  exp:  number;   // unix timestamp
  iat:  number;
  jti?: string;   // JWT ID — used for per-token revocation
}

// ─── Configuration ────────────────────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET ?? '';
if (!JWT_SECRET && process.env.NODE_ENV === 'production') {
  process.stderr.write('FATAL: JWT_SECRET is not set\n');
  process.exit(1);
}

// ─── In-process LRU token cache ───────────────────────────────────────────────
// Avoids running crypto.verify() for every reconnect / heartbeat response.
const MAX_CACHE  = 10_000;
const CACHE_TTL  = 5 * 60 * 1000;  // 5 minutes

const tokenCache = new Map<string, { payload: TokenPayload; expiresAt: number }>();

function cacheGet(token: string): TokenPayload | null {
  const e = tokenCache.get(token);
  if (!e) return null;
  if (Date.now() > e.expiresAt) { tokenCache.delete(token); return null; }
  return e.payload;
}

function cachePut(token: string, payload: TokenPayload): void {
  if (tokenCache.size >= MAX_CACHE) {
    const first = tokenCache.keys().next().value;
    if (first) tokenCache.delete(first);
  }
  tokenCache.set(token, { payload, expiresAt: Date.now() + CACHE_TTL });
}

// ─── Redis revocation store ───────────────────────────────────────────────────
const revokedJtis = new Set<string>();  // in-process mirror
let   redisClient: RedisClientType | null = null;

if (process.env.REDIS_URL) {
  redisClient = createClient({ url: process.env.REDIS_URL }) as RedisClientType;
  redisClient.connect()
    .then(async () => {
      log.info('Auth: Redis revocation store connected');
      const keys = await redisClient!.keys('zegiron:revoked:*');
      keys.forEach(k => revokedJtis.add(k.replace('zegiron:revoked:', '')));
      log.info({ count: keys.length }, 'Revocation list synced');
    })
    .catch(err => log.error({ err }, 'Redis connect failed — revocation list unavailable'));
}

// ─── Public: verify ───────────────────────────────────────────────────────────
export function verifyToken(token: string): TokenPayload | null {
  const cached = cacheGet(token);
  if (cached) return cached;

  let payload: TokenPayload;
  try {
    payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }) as TokenPayload;
  } catch (err) {
    log.debug({ msg: (err as Error).message }, 'JWT verify failed');
    return null;
  }

  // Revocation check
  if (payload.jti && revokedJtis.has(payload.jti)) {
    log.warn({ jti: payload.jti, sub: payload.sub }, 'Rejected revoked token');
    return null;
  }

  // Role sanity check
  const validRoles: Role[] = ['READONLY', 'OPERATOR', 'ANALYST', 'SUPERVISOR', 'ADMIN'];
  if (!validRoles.includes(payload.role)) {
    log.warn({ role: payload.role }, 'Unknown role in token');
    return null;
  }

  cachePut(token, payload);
  return payload;
}

// ─── Public: revoke ───────────────────────────────────────────────────────────
export async function revokeToken(jti: string, ttlSeconds = 86400): Promise<void> {
  revokedJtis.add(jti);
  for (const [tok, e] of tokenCache) {
    if (e.payload.jti === jti) tokenCache.delete(tok);
  }
  if (redisClient) {
    await redisClient.set(`zegiron:revoked:${jti}`, '1', { EX: ttlSeconds });
  }
}

// ─── RBAC: channel subscriptions ─────────────────────────────────────────────
const CHANNEL_ACL: Record<Role, RegExp[]> = {
  READONLY:   [/^track:all$/, /^alert:critical$/],
  OPERATOR:   [/^track:(all|geo:[a-z0-9]{4,8})$/, /^alert:(critical|high)$/, /^sensor:health$/],
  ANALYST:    [/^track:.+$/, /^alert:.+$/, /^sensor:.+$/, /^replay:.+$/],
  SUPERVISOR: [/^track:.+$/, /^alert:.+$/, /^sensor:.+$/, /^replay:.+$/],
  ADMIN:      [/.*/],
};

export function canSubscribe(role: Role, channel: string): boolean {
  return (CHANNEL_ACL[role] ?? CHANNEL_ACL.READONLY).some(re => re.test(channel));
}

// ─── Dev utility — never invoke from production paths ─────────────────────────
export function issueDevToken(userId: string, role: Role): string {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('issueDevToken must not be called in production');
  }
  return jwt.sign(
    { sub: userId, role, jti: crypto.randomUUID() },
    JWT_SECRET,
    { expiresIn: '8h', algorithm: 'HS256' },
  );
}

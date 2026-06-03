const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Redis } = require('@upstash/redis');
const {
	PLAN_PREFIX,
	PLAN_LABEL,
	isValidPlanType,
	computeExpiresAt,
	isExpired,
} = require('./lib/licensePlans');

const app = express();
const PORT = process.env.PORT || 3000;
const BUNDLED_KEYS_DIR = path.join(__dirname, 'keys');
const ADMIN_DIR = path.join(__dirname, 'admin');

const ADMIN_RESET_TOKEN = process.env.ADMIN_RESET_TOKEN || '';
const PREFIX = process.env.REDIS_PREFIX || 'nexus:v3';
const IMPORT_FLAG_KEY = `${PREFIX}:imported:bundled:v3`;
const BUNDLED_KEY_FILES = [
	{ file: 'trial_2m.json', type: 'trial_2m' },
	{ file: 'month_1.json', type: 'month_1' },
	{ file: 'month_3.json', type: 'month_3' },
	{ file: 'lifetime.json', type: 'lifetime' },
];
const LIC_PREFIX = `${PREFIX}:lic`;
const RELEASE_META_KEY = `${PREFIX}:release:meta`;
const RELEASE_CHUNK_PREFIX = `${PREFIX}:release:chunk`;
const STATS_KEY = `${PREFIX}:stats:activations`;
const INDEX_FLAG_KEY = `${PREFIX}:indexes:v2`;
const IDX_ALL = `${PREFIX}:idx:all`;
const IDX_UNUSED = `${PREFIX}:idx:unused`;
const IDX_ACTIVE = `${PREFIX}:idx:active`;
const IDX_EXPIRED = `${PREFIX}:idx:expired`;
const IDX_BANNED = `${PREFIX}:idx:banned`;
const INDEX_SETS = [IDX_ALL, IDX_UNUSED, IDX_ACTIVE, IDX_EXPIRED, IDX_BANNED];

const SERVER_VERSION = '4.0.0';
const REVOKED_MESSAGE = 'Ключ деактивирован владельцем: mastin1337';
const CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;
const CHUNK_RAW_BYTES = 700 * 1024;

const redis = Redis.fromEnv();

app.use(express.json({ limit: '2mb' }));

function normalizeHwid(hwid) {
	return String(hwid || '').trim().toLowerCase();
}

function normalizeKey(key) {
	return String(key || '').trim().toUpperCase();
}

/** Must match Protect.cpp AuthSecret() + activation payload format. */
function activationSig(key, hwid, resultCode) {
	const secret = process.env.CLIENT_AUTH_SECRET || ADMIN_RESET_TOKEN;
	if (!secret) return null;
	return crypto
		.createHash('sha256')
		.update(`${secret}|${normalizeKey(key)}|${normalizeHwid(hwid)}|${resultCode}`)
		.digest('hex');
}

function isValidHwid(hwid) {
	return /^[a-f0-9]{64}$/.test(hwid);
}

function licHashKey(normalizedLicenseKey) {
	return `${LIC_PREFIX}:${normalizedLicenseKey}`;
}

function maskKey(key) {
	if (!key || key.length < 12) return '***';
	return `${key.slice(0, 8)}...${key.slice(-4)}`;
}

function getClientIp(req) {
	const forwarded = req.headers['x-forwarded-for'];
	if (typeof forwarded === 'string' && forwarded.length > 0) return forwarded.split(',')[0].trim();
	return req.socket?.remoteAddress || 'unknown';
}

function toSafeStr(s, maxLen) {
	return String(s || 'unknown').slice(0, maxLen);
}

function logActivation(entry) {
	console.log(JSON.stringify({ ts: new Date().toISOString(), ...entry }));
}

function getAdminToken(req) {
	const authHeader = req.headers?.authorization || '';
	if (authHeader.startsWith('Bearer ')) return authHeader.slice(7).trim();
	return String(req.body?.token || req.query?.token || '').trim();
}

function requireAdmin(req, res, next) {
	if (!ADMIN_RESET_TOKEN) {
		return res.status(503).json({ success: false, message: 'ADMIN_RESET_TOKEN not configured.' });
	}
	if (getAdminToken(req) !== ADMIN_RESET_TOKEN) {
		return res.status(401).json({ success: false, message: 'Unauthorized.' });
	}
	next();
}

function randomSegment(length) {
	const bytes = crypto.randomBytes(length);
	let out = '';
	for (let i = 0; i < length; i++) out += CHARSET[bytes[i] % CHARSET.length];
	return out;
}

function makeLicenseKey(type) {
	const prefix = PLAN_PREFIX[type] || PLAN_PREFIX.lifetime;
	return `${prefix}-${randomSegment(4)}-${randomSegment(4)}-${randomSegment(4)}-${randomSegment(4)}`;
}

function compareVersions(a, b) {
	const pa = String(a).split('.').map((x) => parseInt(x, 10) || 0);
	const pb = String(b).split('.').map((x) => parseInt(x, 10) || 0);
	const n = Math.max(pa.length, pb.length);
	for (let i = 0; i < n; i++) {
		const da = pa[i] || 0;
		const db = pb[i] || 0;
		if (da > db) return 1;
		if (da < db) return -1;
	}
	return 0;
}

async function recordToClient(record) {
	if (!record) return null;
	const type = record.type || 'lifetime';
	return {
		key: record.key,
		type,
		typeLabel: PLAN_LABEL[type] || type,
		status: record.status || 'unknown',
		hwid: record.hwid || '',
		activatedAt: record.activatedAt || null,
		expiresAt: record.expiresAt || null,
		resetAt: record.resetAt || null,
		banned: record.banned === '1',
		expired: isExpired(record),
	};
}

function licenseKeyFromHkey(hkey) {
	const prefix = `${LIC_PREFIX}:`;
	if (!hkey.startsWith(prefix)) return '';
	return hkey.slice(prefix.length);
}

function licenseBucket(record) {
	if (!record?.status) return null;
	if (record.banned === '1') return 'banned';
	if (isExpired(record)) return 'expired';
	if (record.status === 'active') return 'active';
	if (record.status === 'unused') return 'unused';
	return 'unused';
}

function indexSetForBucket(bucket) {
	if (bucket === 'unused') return IDX_UNUSED;
	if (bucket === 'active') return IDX_ACTIVE;
	if (bucket === 'expired') return IDX_EXPIRED;
	if (bucket === 'banned') return IDX_BANNED;
	return null;
}

async function syncLicenseIndex(licKey, record) {
	const key = normalizeKey(record?.key || licenseKeyFromHkey(licKey));
	const bucket = licenseBucket(record);
	if (!key || !bucket) return;

	const pipe = redis.pipeline();
	pipe.sadd(IDX_ALL, key);
	for (const setKey of INDEX_SETS) {
		if (setKey !== IDX_ALL) pipe.srem(setKey, key);
	}
	pipe.sadd(indexSetForBucket(bucket), key);
	await pipe.exec();
}

async function removeLicenseIndex(key) {
	const normalized = normalizeKey(key);
	if (!normalized) return;
	const pipe = redis.pipeline();
	for (const setKey of INDEX_SETS) pipe.srem(setKey, normalized);
	await pipe.exec();
}

async function getLicenseStats() {
	const [total, unused, active, expired, banned] = await Promise.all([
		redis.scard(IDX_ALL),
		redis.scard(IDX_UNUSED),
		redis.scard(IDX_ACTIVE),
		redis.scard(IDX_EXPIRED),
		redis.scard(IDX_BANNED),
	]);
	return { total, unused, active, expired, banned };
}

async function recordsFromKeys(keys) {
	if (!keys.length) return [];
	const pipe = redis.pipeline();
	for (const key of keys) pipe.hgetall(licHashKey(key));
	const results = await pipe.exec();
	const out = [];
	for (const record of results) {
		if (record?.key) out.push(await recordToClient(record));
	}
	return out;
}

async function reconcileExpiredIndexes(maxKeys = 500) {
	const activeKeys = await redis.smembers(IDX_ACTIVE);
	if (!activeKeys.length) return 0;

	let moved = 0;
	for (let i = 0; i < activeKeys.length && moved < maxKeys; i += 50) {
		const chunk = activeKeys.slice(i, i + 50);
		const pipe = redis.pipeline();
		for (const key of chunk) pipe.hgetall(licHashKey(key));
		const records = await pipe.exec();
		for (let j = 0; j < chunk.length; j++) {
			const record = records[j];
			if (!record?.key || !isExpired(record)) continue;
			await syncLicenseIndex(licHashKey(chunk[j]), record);
			moved++;
		}
	}
	return moved;
}

async function listLicensesPage({ statusFilter, search, page, limit }) {
	if (search) {
		const exact = await redis.hgetall(licHashKey(search));
		if (exact?.key) {
			const bucket = licenseBucket(exact);
			if (!statusFilter || bucket === statusFilter) {
				return {
					licenses: [await recordToClient(exact)],
					total: 1,
					page: 0,
					limit,
					hasMore: false,
				};
			}
			return { licenses: [], total: 0, page: 0, limit, hasMore: false };
		}

		const pool = statusFilter
			? await redis.smembers(indexSetForBucket(statusFilter))
			: await redis.smembers(IDX_ALL);
		const matched = pool.filter((k) => k.includes(search)).sort();
		const total = matched.length;
		const start = page * limit;
		const pageKeys = matched.slice(start, start + limit);
		const licenses = await recordsFromKeys(pageKeys);
		return { licenses, total, page, limit, hasMore: start + limit < total };
	}

	const idxKey = statusFilter ? indexSetForBucket(statusFilter) : IDX_ALL;
	if (!idxKey) {
		return { licenses: [], total: 0, page, limit, hasMore: false };
	}

	const allKeys = await redis.smembers(idxKey);
	const total = allKeys.length;
	const sorted = allKeys.sort();
	const start = page * limit;
	const pageKeys = sorted.slice(start, start + limit);
	const licenses = await recordsFromKeys(pageKeys);

	return {
		licenses,
		total,
		page,
		limit,
		hasMore: start + limit < total,
	};
}

async function rebuildLicenseIndexes() {
	const already = await redis.get(INDEX_FLAG_KEY);
	if (already) return 0;

	await redis.del(...INDEX_SETS);

	let indexed = 0;
	let cursor = 0;
	const pattern = `${LIC_PREFIX}:*`;

	do {
		const result = await redis.scan(cursor, { match: pattern, count: 100 });
		cursor = Number(result[0]);
		const hkeys = result[1] || [];
		if (!hkeys.length) continue;

		const readPipe = redis.pipeline();
		for (const hkey of hkeys) readPipe.hgetall(hkey);
		const records = await readPipe.exec();

		const indexPipe = redis.pipeline();
		for (let i = 0; i < hkeys.length; i++) {
			const record = records[i];
			if (!record?.key) continue;
			const key = normalizeKey(record.key);
			const bucket = licenseBucket(record);
			if (!key || !bucket) continue;
			indexPipe.sadd(IDX_ALL, key);
			indexPipe.sadd(indexSetForBucket(bucket), key);
			indexed++;
		}
		await indexPipe.exec();
	} while (cursor !== 0);

	await redis.set(INDEX_FLAG_KEY, String(indexed));
	return indexed;
}

async function activateLicense(licKey, hwid, autoLogin) {
	const record = await redis.hgetall(licKey);
	if (!record || !record.status) return { code: 'invalid_key' };
	if (record.banned === '1') return { code: 'banned' };

	if (autoLogin) {
		if (record.resetAt) return { code: 'revoked' };
		if (record.status === 'unused') return { code: 'session_invalid' };
	}

	if (isExpired(record)) return { code: 'expired' };

	const type = record.type || 'lifetime';
	const nowIso = new Date().toISOString();

	if (record.status === 'unused') {
		const expiresAt = computeExpiresAt(type, nowIso);
		const updated = {
			key: record.key || licenseKeyFromHkey(licKey),
			type,
			status: 'active',
			hwid,
			activatedAt: nowIso,
			expiresAt: expiresAt || '',
			resetAt: '',
			banned: record.banned || '0',
		};
		await redis.hset(licKey, updated);
		await syncLicenseIndex(licKey, updated);
		return { code: 'activated', type, expiresAt: expiresAt || null };
	}

	if (record.status === 'active') {
		if (normalizeHwid(record.hwid) !== hwid) {
			return { code: 'bound', bound: record.hwid };
		}
		return {
			code: 'valid',
			type,
			expiresAt: record.expiresAt || null,
		};
	}

	return { code: 'unknown', status: record.status };
}

async function importBundledChunk(records, type) {
	let imported = 0;
	const CHUNK = 50;

	for (let i = 0; i < records.length; i += CHUNK) {
		const slice = records.slice(i, i + CHUNK);
		const entries = [];

		for (const record of slice) {
			const key = normalizeKey(record.key);
			if (!key) continue;
			entries.push({ key, hkey: licHashKey(key), record });
		}
		if (entries.length === 0) continue;

		const existsPipe = redis.pipeline();
		for (const e of entries) existsPipe.exists(e.hkey);
		const existsResults = await existsPipe.exec();

		const writePipe = redis.pipeline();
		const toIndex = [];
		for (let j = 0; j < entries.length; j++) {
			const existed = existsResults?.[j];
			if (existed) continue;

			const { key, hkey, record } = entries[j];
			const status = record.status === 'active' ? 'active' : 'unused';
			const fields = {
				key,
				type: record.type && isValidPlanType(record.type) ? record.type : type,
				status,
				hwid: status === 'active' && record.hwid ? normalizeHwid(record.hwid) : '',
				activatedAt: status === 'active' && record.activatedAt ? String(record.activatedAt) : '',
				expiresAt: status === 'active' && record.expiresAt ? String(record.expiresAt) : '',
				resetAt: '',
				banned: '0',
			};
			writePipe.hset(hkey, fields);
			toIndex.push({ hkey, fields });
			imported++;
		}
		await writePipe.exec();

		if (toIndex.length) {
			const indexPipe = redis.pipeline();
			for (const { hkey, fields } of toIndex) {
				const key = fields.key;
				const bucket = licenseBucket(fields);
				indexPipe.sadd(IDX_ALL, key);
				for (const setKey of INDEX_SETS) {
					if (setKey !== IDX_ALL) indexPipe.srem(setKey, key);
				}
				indexPipe.sadd(indexSetForBucket(bucket), key);
			}
			await indexPipe.exec();
		}
	}

	return imported;
}

async function ensureBundledKeysImported() {
	const already = await redis.get(IMPORT_FLAG_KEY);
	if (already) return 0;

	let imported = 0;

	for (const bundle of BUNDLED_KEY_FILES) {
		const filePath = path.join(BUNDLED_KEYS_DIR, bundle.file);
		if (!fs.existsSync(filePath)) continue;

		const records = JSON.parse(fs.readFileSync(filePath, 'utf8'));
		if (!Array.isArray(records)) continue;

		imported += await importBundledChunk(records, bundle.type);
	}

	await redis.set(IMPORT_FLAG_KEY, String(imported));
	return imported;
}

async function getReleaseMeta() {
	const meta = await redis.get(RELEASE_META_KEY);
	if (!meta) return null;
	return typeof meta === 'string' ? JSON.parse(meta) : meta;
}

// --- Public ---

app.get('/', (_req, res) => {
	res.json({
		service: 'Nexus License Server',
		version: SERVER_VERSION,
		hosting: ['Upstash Redis', 'Render.com'],
		endpoints: {
			activate: 'POST /activate',
			health: 'GET /health',
			releaseLatest: 'GET /release/latest',
			releaseDownload: 'GET /release/download',
			adminPanel: 'GET /admin',
		},
	});
});

app.get('/health', (_req, res) => {
	res.json({ ok: true, version: SERVER_VERSION });
});

app.post('/activate', async (req, res) => {
	const key = normalizeKey(req.body?.key);
	const hwid = normalizeHwid(req.body?.hwid);
	const client = toSafeStr(req.body?.client, 64);
	const autoLogin = req.body?.autoLogin === true;
	const ip = getClientIp(req);
	const userAgent = toSafeStr(req.headers['user-agent'], 256);
	const baseLog = { ip, client, userAgent, key, keyMasked: maskKey(key), hwid, autoLogin };

	if (!key) {
		logActivation({ ...baseLog, success: false, reason: 'missing_key', httpStatus: 400 });
		return res.status(400).json({ success: false, message: 'Key is required.' });
	}
	if (!hwid || !isValidHwid(hwid)) {
		logActivation({ ...baseLog, success: false, reason: 'invalid_hwid', httpStatus: 400 });
		return res.status(400).json({ success: false, message: 'Invalid HWID format.' });
	}

	const licKey = licHashKey(key);
	try {
		const result = await activateLicense(licKey, hwid, autoLogin);

		if (result.code === 'invalid_key') {
			logActivation({ ...baseLog, success: false, reason: 'invalid_key', httpStatus: 401 });
			return res.status(401).json({ success: false, message: 'Invalid key.' });
		}
		if (result.code === 'revoked' || result.code === 'session_invalid') {
			logActivation({ ...baseLog, success: false, reason: result.code, httpStatus: 403 });
			return res.status(403).json({
				success: false,
				code: result.code === 'revoked' ? 'revoked_by_owner' : 'session_invalid',
				message: REVOKED_MESSAGE,
			});
		}
		if (result.code === 'banned') {
			logActivation({ ...baseLog, success: false, reason: 'banned', httpStatus: 403 });
			return res.status(403).json({ success: false, code: 'banned', message: 'Key is banned.' });
		}
		if (result.code === 'expired') {
			logActivation({ ...baseLog, success: false, reason: 'expired', httpStatus: 403 });
			return res.status(403).json({ success: false, code: 'expired', message: 'License expired.' });
		}
		if (result.code === 'bound') {
			logActivation({ ...baseLog, success: false, reason: 'bound', httpStatus: 403 });
			return res.status(403).json({ success: false, message: 'Key is bound to another device.' });
		}
		if (result.code === 'activated' || result.code === 'valid') {
			if (result.code === 'activated' && !autoLogin) {
				await redis.hset(licKey, { resetAt: '' });
			}
			logActivation({
				...baseLog,
				success: true,
				reason: result.code,
				httpStatus: 200,
				type: result.type,
				expiresAt: result.expiresAt,
			});
			try {
				await redis.incr(STATS_KEY);
			} catch (_) { /* ignore */ }
			const payload = {
				success: true,
				code: result.code,
				message: result.code === 'activated' ? 'Key activated successfully.' : 'License valid.',
				type: result.type,
				expiresAt: result.expiresAt,
			};
			const sig = activationSig(key, hwid, result.code);
			if (sig) payload.sig = sig;
			return res.json(payload);
		}

		logActivation({ ...baseLog, success: false, reason: 'unknown', httpStatus: 500, detail: result });
		return res.status(500).json({ success: false, message: 'Server error.' });
	} catch (e) {
		logActivation({ ...baseLog, success: false, reason: 'redis_error', httpStatus: 500, error: String(e?.message || e) });
		return res.status(500).json({ success: false, message: 'Server error during activation.' });
	}
});

app.post('/admin/reset', requireAdmin, async (req, res) => {
	const key = normalizeKey(req.body?.key);
	if (!key) return res.status(400).json({ success: false, message: 'key is required.' });

	const hkey = licHashKey(key);
	try {
		const exists = await redis.exists(hkey);
		if (!exists) return res.status(404).json({ success: false, message: 'Key not found.' });

		const prev = await redis.hgetall(hkey);
		const updated = {
			...prev,
			key,
			status: 'unused',
			hwid: '',
			activatedAt: '',
			expiresAt: '',
			resetAt: new Date().toISOString(),
			banned: prev.banned || '0',
		};
		await redis.hset(hkey, updated);
		await syncLicenseIndex(hkey, updated);
		return res.json({ success: true, message: 'HWID binding reset for this key.' });
	} catch (e) {
		return res.status(500).json({ success: false, message: 'Failed to reset key.' });
	}
});

// --- Releases (public) ---

app.get('/release/latest', async (req, res) => {
	try {
		res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
		res.set('Pragma', 'no-cache');

		const meta = await getReleaseMeta();
		const clientVersion = String(req.query?.version || req.query?.client || '').replace(/^Nexus\//i, '').trim();

		if (!meta || !meta.version) {
			return res.json({ success: true, updateAvailable: false, version: clientVersion || null });
		}

		const updateAvailable = clientVersion
			? compareVersions(meta.version, clientVersion) > 0
			: true;

		const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
		const host = req.headers['x-forwarded-host'] || req.headers.host;
		const baseUrl = host ? `${proto}://${host}` : '';

		return res.json({
			success: true,
			updateAvailable,
			version: meta.version,
			clientVersion: clientVersion || null,
			sha256: meta.sha256,
			size: meta.size,
			filename: meta.filename || 'kernel32.exe',
			mandatory: meta.mandatory === true,
			downloadUrl: `${baseUrl}/release/download`,
		});
	} catch (e) {
		return res.status(500).json({ success: false, message: String(e?.message || e) });
	}
});

app.get('/release/download', async (_req, res) => {
	try {
		res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
		res.set('Pragma', 'no-cache');

		const meta = await getReleaseMeta();
		if (!meta?.chunkCount) {
			return res.status(404).json({ success: false, message: 'No release published.' });
		}

		const chunks = [];
		for (let i = 0; i < meta.chunkCount; i++) {
			const part = await redis.get(`${RELEASE_CHUNK_PREFIX}:${i}`);
			if (!part) {
				return res.status(500).json({ success: false, message: `Missing chunk ${i}.` });
			}
			chunks.push(Buffer.from(part, 'base64'));
		}
		const file = Buffer.concat(chunks);
		if (meta.sha256 && crypto.createHash('sha256').update(file).digest('hex') !== meta.sha256) {
			return res.status(500).json({ success: false, message: 'Release checksum mismatch.' });
		}

		const filename = meta.filename || 'kernel32.exe';
		res.setHeader('Content-Type', 'application/octet-stream');
		res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
		res.setHeader('Content-Length', file.length);
		return res.send(file);
	} catch (e) {
		return res.status(500).json({ success: false, message: String(e?.message || e) });
	}
});

// --- Admin API ---

app.get('/admin/api/stats', requireAdmin, async (_req, res) => {
	try {
		const activations = Number(await redis.get(STATS_KEY)) || 0;
		await reconcileExpiredIndexes(200);
		const summary = await getLicenseStats();
		const release = await getReleaseMeta();
		return res.json({
			success: true,
			activations,
			licenses: summary,
			release: release
				? { version: release.version, size: release.size, uploadedAt: release.uploadedAt, mandatory: release.mandatory }
				: null,
			plans: PLAN_LABEL,
		});
	} catch (e) {
		return res.status(500).json({ success: false, message: String(e?.message || e) });
	}
});

app.get('/admin/api/licenses', requireAdmin, async (req, res) => {
	try {
		const limit = Math.min(Math.max(parseInt(req.query?.limit, 10) || 50, 1), 200);
		const page = Math.max(parseInt(req.query?.page, 10) || 0, 0);
		const statusFilter = String(req.query?.status || '').toLowerCase();
		const search = normalizeKey(req.query?.search || '');

		const allowed = new Set(['', 'unused', 'active', 'expired', 'banned']);
		if (!allowed.has(statusFilter)) {
			return res.status(400).json({ success: false, message: 'Invalid status filter.' });
		}

		if (statusFilter === 'expired') await reconcileExpiredIndexes(500);

		const result = await listLicensesPage({
			statusFilter: statusFilter || null,
			search,
			page,
			limit,
		});

		return res.json({ success: true, ...result });
	} catch (e) {
		return res.status(500).json({ success: false, message: String(e?.message || e) });
	}
});

app.post('/admin/api/licenses/rebuild-index', requireAdmin, async (_req, res) => {
	try {
		await redis.del(INDEX_FLAG_KEY);
		const count = await rebuildLicenseIndexes();
		await reconcileExpiredIndexes(2000);
		const summary = await getLicenseStats();
		return res.json({ success: true, indexed: count, licenses: summary });
	} catch (e) {
		return res.status(500).json({ success: false, message: String(e?.message || e) });
	}
});

app.post('/admin/api/licenses/generate', requireAdmin, async (req, res) => {
	const type = String(req.body?.type || 'lifetime');
	const count = Math.min(Math.max(parseInt(req.body?.count, 10) || 1, 1), 500);
	if (!isValidPlanType(type)) {
		return res.status(400).json({ success: false, message: 'Invalid type. Use trial_2m, month_1, month_3, lifetime.' });
	}

	const created = [];
	const seen = new Set();
	try {
		while (created.length < count) {
			const key = makeLicenseKey(type);
			if (seen.has(key)) continue;
			seen.add(key);
			const hkey = licHashKey(key);
			const exists = await redis.exists(hkey);
			if (exists) continue;

			const fields = {
				key,
				type,
				status: 'unused',
				hwid: '',
				activatedAt: '',
				expiresAt: '',
				resetAt: '',
				banned: '0',
			};
			await redis.hset(hkey, fields);
			await syncLicenseIndex(hkey, fields);
			created.push({ key, type, typeLabel: PLAN_LABEL[type] });
		}
		return res.json({ success: true, count: created.length, keys: created });
	} catch (e) {
		return res.status(500).json({ success: false, message: String(e?.message || e) });
	}
});

app.post('/admin/api/licenses/ban', requireAdmin, async (req, res) => {
	const key = normalizeKey(req.body?.key);
	if (!key) return res.status(400).json({ success: false, message: 'key required.' });
	const hkey = licHashKey(key);
	try {
		if (!(await redis.exists(hkey))) return res.status(404).json({ success: false, message: 'Key not found.' });
		const record = await redis.hgetall(hkey);
		const updated = {
			...record,
			key,
			banned: '1',
			status: 'unused',
			hwid: '',
			activatedAt: '',
			resetAt: new Date().toISOString(),
		};
		await redis.hset(hkey, updated);
		await syncLicenseIndex(hkey, updated);
		return res.json({ success: true, message: 'Key banned.' });
	} catch (e) {
		return res.status(500).json({ success: false, message: String(e?.message || e) });
	}
});

app.post('/admin/api/licenses/unban', requireAdmin, async (req, res) => {
	const key = normalizeKey(req.body?.key);
	if (!key) return res.status(400).json({ success: false, message: 'key required.' });
	const hkey = licHashKey(key);
	try {
		if (!(await redis.exists(hkey))) return res.status(404).json({ success: false, message: 'Key not found.' });
		const record = await redis.hgetall(hkey);
		const updated = { ...record, key, banned: '0', resetAt: '' };
		await redis.hset(hkey, updated);
		await syncLicenseIndex(hkey, updated);
		return res.json({ success: true, message: 'Key unbanned.' });
	} catch (e) {
		return res.status(500).json({ success: false, message: String(e?.message || e) });
	}
});

app.delete('/admin/api/licenses', requireAdmin, async (req, res) => {
	const key = normalizeKey(req.body?.key || req.query?.key);
	if (!key) return res.status(400).json({ success: false, message: 'key required.' });
	try {
		await redis.del(licHashKey(key));
		await removeLicenseIndex(key);
		return res.json({ success: true, message: 'Key deleted.' });
	} catch (e) {
		return res.status(500).json({ success: false, message: String(e?.message || e) });
	}
});

app.post('/admin/api/release/upload', requireAdmin, async (req, res) => {
	const version = String(req.body?.version || '').trim();
	const mandatory = req.body?.mandatory === true;
	const filename = String(req.body?.filename || 'kernel32.exe').replace(/[^\w.\-]/g, '_');
	const fileBase64 = String(req.body?.fileBase64 || '');

	if (!version) return res.status(400).json({ success: false, message: 'version required.' });
	if (!fileBase64) return res.status(400).json({ success: false, message: 'fileBase64 required.' });

	try {
		const raw = Buffer.from(fileBase64, 'base64');
		if (!raw.length) return res.status(400).json({ success: false, message: 'Empty file.' });
		if (raw.length > MAX_UPLOAD_BYTES) {
			return res.status(400).json({ success: false, message: `File too large (max ${MAX_UPLOAD_BYTES} bytes).` });
		}

		const sha256 = crypto.createHash('sha256').update(raw).digest('hex');
		const chunkCount = Math.ceil(raw.length / CHUNK_RAW_BYTES);

		const oldMeta = await getReleaseMeta();
		if (oldMeta?.chunkCount) {
			for (let i = 0; i < oldMeta.chunkCount; i++) {
				await redis.del(`${RELEASE_CHUNK_PREFIX}:${i}`);
			}
		}

		for (let i = 0; i < chunkCount; i++) {
			const slice = raw.subarray(i * CHUNK_RAW_BYTES, (i + 1) * CHUNK_RAW_BYTES);
			await redis.set(`${RELEASE_CHUNK_PREFIX}:${i}`, slice.toString('base64'));
		}

		const meta = {
			version,
			sha256,
			size: raw.length,
			filename,
			chunkCount,
			mandatory,
			uploadedAt: new Date().toISOString(),
		};
		await redis.set(RELEASE_META_KEY, JSON.stringify(meta));

		return res.json({ success: true, message: 'Release published.', release: meta });
	} catch (e) {
		return res.status(500).json({ success: false, message: String(e?.message || e) });
	}
});

app.delete('/admin/api/release', requireAdmin, async (_req, res) => {
	try {
		const meta = await getReleaseMeta();
		if (meta?.chunkCount) {
			for (let i = 0; i < meta.chunkCount; i++) {
				await redis.del(`${RELEASE_CHUNK_PREFIX}:${i}`);
			}
		}
		await redis.del(RELEASE_META_KEY);
		return res.json({ success: true, message: 'Release removed.' });
	} catch (e) {
		return res.status(500).json({ success: false, message: String(e?.message || e) });
	}
});

// Admin UI
app.use('/admin', express.static(ADMIN_DIR));
app.get('/admin', (_req, res) => {
	res.sendFile(path.join(ADMIN_DIR, 'index.html'));
});

async function start() {
	app.listen(PORT, '0.0.0.0', () => {
		console.log(`Nexus license server v${SERVER_VERSION} on port ${PORT}`);
		console.log(`Admin panel: http://localhost:${PORT}/admin`);
	});

	ensureBundledKeysImported()
		.then((n) => console.log(`Bundled keys import: ${n ?? 0} new key(s) from keys/`))
		.then(() => rebuildLicenseIndexes())
		.then((n) => console.log(`License indexes ready (${n ?? 0} keys indexed)`))
		.catch((e) => console.error('Startup import/index:', e?.message || e));
}

start().catch((e) => {
	console.error('Failed to start:', e);
	process.exit(1);
});

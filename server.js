const express = require('express');
const fs = require('fs');
const path = require('path');
const { Redis } = require('@upstash/redis');

const app = express();
const PORT = process.env.PORT || 3000;
const BUNDLED_KEYS_DIR = path.join(__dirname, 'keys');

const ADMIN_RESET_TOKEN = process.env.ADMIN_RESET_TOKEN || '';

const PREFIX = process.env.REDIS_PREFIX || 'nexus:v3';
const IMPORT_FLAG_KEY = `${PREFIX}:imported:lifetime:v1`;
const LIC_PREFIX = `${PREFIX}:lic`; // ${LIC_PREFIX}:${key}

const redis = Redis.fromEnv();

app.use(express.json());

function normalizeHwid(hwid) {
	return String(hwid || '').trim().toLowerCase();
}

function normalizeKey(key) {
	return String(key || '').trim().toUpperCase();
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

async function ensureLifetimeKeysImported() {
	const already = await redis.get(IMPORT_FLAG_KEY);
	if (already) return;

	const filePath = path.join(BUNDLED_KEYS_DIR, 'lifetime.json');
	if (!fs.existsSync(filePath)) throw new Error(`Missing key file: ${filePath}`);

	const records = JSON.parse(fs.readFileSync(filePath, 'utf8'));
	if (!Array.isArray(records)) throw new Error(`Invalid keys JSON: ${filePath}`);

	for (const record of records) {
		const key = normalizeKey(record.key);
		if (!key) continue;

		const hkey = licHashKey(key);
		const exists = await redis.exists(hkey);
		if (!exists) {
			const status = record.status === 'active' ? 'active' : 'unused';
			const boundHwid = record.hwid ? normalizeHwid(record.hwid) : '';
			const activatedAt = record.activatedAt ? String(record.activatedAt) : '';

			await redis.hset(hkey, {
				key,
				type: 'lifetime',
				status,
				hwid: status === 'active' ? boundHwid : '',
				activatedAt: status === 'active' ? activatedAt : '',
			});
		}
	}

	await redis.set(IMPORT_FLAG_KEY, '1');
}

const activateLua = `
local k = KEYS[1]
local hwid = ARGV[1]
local now = ARGV[2]
local status = redis.call('HGET', k, 'status')
if (not status) then
  return 'invalid_key'
end
if status == 'unused' then
  local bound = redis.call('HGET', k, 'hwid')
  if (not bound or bound == '') then
    redis.call('HSET', k, 'status', 'active', 'hwid', hwid, 'activatedAt', now)
    return 'activated'
  end
end
if status == 'active' then
  local bound = redis.call('HGET', k, 'hwid')
  if bound == hwid then
    return 'valid'
  else
    return 'bound|' .. tostring(bound)
  end
end
return 'unknown|' .. tostring(status)
`;
const activateScript = redis.createScript(activateLua);

app.get('/', (_req, res) => {
	res.json({
		service: 'Nexus License Server',
		version: '3.2.0-upstash',
		endpoints: { activate: 'POST /activate', adminReset: 'POST /admin/reset (token required)' },
	});
});

app.get('/health', (_req, res) => {
	res.json({ ok: true });
});

app.post('/activate', async (req, res) => {
	const key = normalizeKey(req.body?.key);
	const hwid = normalizeHwid(req.body?.hwid);
	const client = toSafeStr(req.body?.client, 64);

	const ip = getClientIp(req);
	const userAgent = toSafeStr(req.headers['user-agent'], 256);

	const baseLog = { ip, client, userAgent, key, keyMasked: maskKey(key), hwid };

	if (!key) {
		logActivation({ ...baseLog, success: false, reason: 'missing_key', httpStatus: 400 });
		return res.status(400).json({ success: false, message: 'Key is required.' });
	}
	if (!hwid) {
		logActivation({ ...baseLog, success: false, reason: 'missing_hwid', httpStatus: 400 });
		return res.status(400).json({ success: false, message: 'HWID is required.' });
	}
	if (!isValidHwid(hwid)) {
		logActivation({ ...baseLog, success: false, reason: 'invalid_hwid_format', httpStatus: 400 });
		return res.status(400).json({ success: false, message: 'Invalid HWID format.' });
	}

	const licKey = licHashKey(key);
	try {
		const nowIso = new Date().toISOString();
		const result = await activateScript.eval([licKey], [hwid, nowIso]);

		if (result === 'invalid_key') {
			logActivation({ ...baseLog, success: false, reason: 'invalid_key', httpStatus: 401 });
			return res.status(401).json({ success: false, message: 'Invalid key.' });
		}
		if (result === 'activated') {
			logActivation({ ...baseLog, success: true, reason: 'activated', httpStatus: 200, firstActivation: true });
			return res.json({ success: true, message: 'Key activated successfully.', type: 'lifetime', expiresAt: null });
		}
		if (result === 'valid') {
			logActivation({ ...baseLog, success: true, reason: 'valid', httpStatus: 200, firstActivation: false });
			return res.json({ success: true, message: 'License valid.', type: 'lifetime', expiresAt: null });
		}
		if (typeof result === 'string' && result.startsWith('bound|')) {
			const bound = result.split('|')[1] || null;
			logActivation({ ...baseLog, success: false, reason: 'bound_to_other_hwid', httpStatus: 403, boundHwid: bound });
			return res.status(403).json({ success: false, message: 'Key is bound to another device.' });
		}

		logActivation({ ...baseLog, success: false, reason: 'unknown_result', httpStatus: 500, result: String(result) });
		return res.status(500).json({ success: false, message: 'Server error.' });
	} catch (e) {
		logActivation({ ...baseLog, success: false, reason: 'redis_error', httpStatus: 500, error: String(e?.message || e) });
		return res.status(500).json({ success: false, message: 'Server error during activation.' });
	}
});

app.post('/admin/reset', async (req, res) => {
	const tokenFromBody = req.body?.token;
	const authHeader = req.headers?.authorization || '';
	const tokenFromHeader = authHeader.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : '';
	const token = tokenFromBody || tokenFromHeader;

	if (!ADMIN_RESET_TOKEN || token !== ADMIN_RESET_TOKEN) {
		return res.status(401).json({ success: false, message: 'Unauthorized.' });
	}

	const key = normalizeKey(req.body?.key);
	if (!key) return res.status(400).json({ success: false, message: 'key is required.' });

	const hkey = licHashKey(key);
	try {
		const exists = await redis.exists(hkey);
		if (!exists) return res.status(404).json({ success: false, message: 'Key not found.' });

		await redis.hset(hkey, { status: 'unused', hwid: '', activatedAt: '' });
		return res.json({ success: true, message: 'HWID binding reset for this key.' });
	} catch (e) {
		return res.status(500).json({ success: false, message: 'Failed to reset key.' });
	}
});

async function start() {
 // IMPORTANT: Render expects the web service to bind its HTTP port quickly.
 // Do not block startup on Redis import. Import runs in background.
 app.listen(PORT, '0.0.0.0', () => console.log(`Nexus license server listening on port ${PORT}`));

 ensureLifetimeKeysImported()
  .then(() => console.log('Lifetime keys import: OK'))
  .catch((e) => console.error('Lifetime keys import failed:', e));
}

start().catch((e) => {
	console.error('Failed to start server:', e);
	process.exit(1);
});

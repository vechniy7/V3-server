const express = require('express');
const fs = require('fs');
const path = require('path');
const { ensureKeysFile, getKeysPath } = require('./generate-keys');

const app = express();
const PORT = process.env.PORT || 3000;
const KEYS_FILE = getKeysPath();
const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

app.use(express.json());

let keys = [];

function loadKeys() {
	try {
		const raw = fs.readFileSync(KEYS_FILE, 'utf8');
		keys = JSON.parse(raw);
		if (!Array.isArray(keys)) {
			throw new Error('keys.json must be an array');
		}
		console.log(`Loaded ${keys.length} keys from ${KEYS_FILE}`);
	} catch (error) {
		console.error(`Error loading keys: ${error.message}`);
		process.exit(1);
	}
}

function saveKeys() {
	const tmp = `${KEYS_FILE}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(keys, null, 2), 'utf8');
	fs.renameSync(tmp, KEYS_FILE);
}

function normalizeHwid(hwid) {
	return String(hwid || '').trim().toLowerCase();
}

function normalizeKey(key) {
	return String(key || '').trim().toUpperCase();
}

function isExpired(record) {
	if (record.type !== 'monthly' || !record.expiresAt) {
		return false;
	}
	return new Date(record.expiresAt).getTime() <= Date.now();
}

function activateRecord(record, hwid) {
	const now = new Date();
	const nowIso = now.toISOString();

	// First activation on this key
	if (record.status === 'unused' || !record.hwid) {
		record.status = 'active';
		record.hwid = hwid;
		record.activatedAt = nowIso;
		record.expiresAt =
			record.type === 'monthly'
				? new Date(now.getTime() + MONTH_MS).toISOString()
				: null;
		return {
			ok: true,
			message: 'Key activated successfully.',
			firstActivation: true,
		};
	}

	// Re-login on the same PC — key stays valid (not single-use)
	if (record.hwid !== hwid) {
		return {
			ok: false,
			status: 403,
			message: 'Key is bound to another device.',
		};
	}

	if (isExpired(record)) {
		return {
			ok: false,
			status: 401,
			message: 'Key expired.',
		};
	}

	return {
		ok: true,
		message: 'License valid.',
		firstActivation: false,
	};
}

const keyBootstrap = ensureKeysFile({ keysPath: KEYS_FILE });
if (keyBootstrap.created) {
	console.log(`Generated ${keyBootstrap.count} new keys at ${KEYS_FILE}`);
	console.log('Download keys-lifetime.txt and keys-monthly.txt from the server disk or Render shell.');
} else {
	console.log(`Using existing keys (${keyBootstrap.count}) at ${KEYS_FILE}`);
}

loadKeys();

app.get('/', (_req, res) => {
	res.json({
		service: 'Nexus License Server',
		version: '2.0.0',
		endpoints: { activate: 'POST /activate' },
	});
});

app.get('/health', (_req, res) => {
	const stats = keys.reduce(
		(acc, k) => {
			acc.total += 1;
			if (k.type === 'lifetime') acc.lifetime += 1;
			if (k.type === 'monthly') acc.monthly += 1;
			if (k.status === 'unused') acc.unused += 1;
			if (k.status === 'active') acc.active += 1;
			return acc;
		},
		{ total: 0, lifetime: 0, monthly: 0, unused: 0, active: 0 }
	);
	res.json({ ok: true, stats });
});

app.post('/activate', (req, res) => {
	const key = normalizeKey(req.body?.key);
	const hwid = normalizeHwid(req.body?.hwid);

	if (!key) {
		return res.status(400).json({ success: false, message: 'Key is required.' });
	}
	if (!hwid) {
		return res.status(400).json({ success: false, message: 'HWID is required.' });
	}

	console.log(`Activate: key=${key.slice(0, 8)}... hwid=${hwid.slice(0, 12)}...`);

	const index = keys.findIndex((k) => normalizeKey(k.key) === key);
	if (index === -1) {
		console.log('Key not found');
		return res.status(401).json({ success: false, message: 'Invalid key.' });
	}

	const record = keys[index];
	const result = activateRecord(record, hwid);

	if (!result.ok) {
		console.log(`Denied: ${result.message}`);
		return res.status(result.status || 401).json({
			success: false,
			message: result.message,
		});
	}

	try {
		saveKeys();
	} catch (error) {
		console.error(`Save error: ${error.message}`);
		return res.status(500).json({
			success: false,
			message: 'Server error during activation.',
		});
	}

	console.log(
		result.firstActivation ? 'First activation OK' : 'Re-validation OK',
		`type=${record.type}`
	);

	return res.json({
		success: true,
		message: result.message,
		type: record.type,
		expiresAt: record.expiresAt,
	});
});

app.listen(PORT, () => {
	console.log(`Nexus license server listening on port ${PORT}`);
});

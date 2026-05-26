const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
// Persisted storage location (Render free/redeploy often resets local FS).
// If KEYS_DIR isn't configured, default to the common persistent mount.
const BUNDLED_KEYS_DIR = path.join(__dirname, 'keys');
const DEFAULT_PERSIST_KEYS_DIR = '/var/data/keys';
let KEYS_DIR = process.env.KEYS_DIR
	? path.resolve(process.env.KEYS_DIR)
	: DEFAULT_PERSIST_KEYS_DIR;

const MONTH_MS = 30 * 24 * 60 * 60 * 1000;
const TRIAL_MS = 5 * 60 * 1000;

const KEY_FILES = [
	{ file: 'lifetime.json', type: 'lifetime' },
	{ file: 'monthly.json', type: 'monthly' },
	{ file: 'trial-5min.json', type: 'trial' },
];

app.use(express.json());

let keys = [];

function ensurePersistedKeysDir() {
	// If the persisted directory isn't available (or not writable), fall back to bundled keys directory.
	try {
		if (!fs.existsSync(KEYS_DIR)) {
			fs.mkdirSync(KEYS_DIR, { recursive: true });
		}
		for (const entry of KEY_FILES) {
			const src = path.join(BUNDLED_KEYS_DIR, entry.file);
			const dst = path.join(KEYS_DIR, entry.file);
			if (!fs.existsSync(dst) && fs.existsSync(src)) {
				fs.copyFileSync(src, dst);
			}
		}
	} catch (e) {
		console.error(`Failed to init persisted KEYS_DIR=${KEYS_DIR}: ${e.message}`);
		KEYS_DIR = BUNDLED_KEYS_DIR;
	}
}

function loadKeys() {
	keys = [];

	ensurePersistedKeysDir();

	if (!fs.existsSync(KEYS_DIR)) {
		console.error(`Keys directory not found: ${KEYS_DIR}`);
		process.exit(1);
	}

	for (const entry of KEY_FILES) {
		const filePath = path.join(KEYS_DIR, entry.file);
		if (!fs.existsSync(filePath)) {
			console.error(`Missing key file: ${filePath}`);
			process.exit(1);
		}

		let records;
		try {
			records = JSON.parse(fs.readFileSync(filePath, 'utf8'));
		} catch (error) {
			console.error(`Invalid JSON in ${filePath}: ${error.message}`);
			process.exit(1);
		}

		if (!Array.isArray(records)) {
			console.error(`${filePath} must contain a JSON array`);
			process.exit(1);
		}

		for (const record of records) {
			record.type = record.type || entry.type;
			record._sourceFile = entry.file;
			keys.push(record);
		}

		console.log(`Loaded ${records.length} keys from keys/${entry.file}`);
	}

	console.log(`Total keys in memory: ${keys.length}`);
}

function saveKeys() {
	const grouped = {};
	for (const entry of KEY_FILES) {
		grouped[entry.file] = [];
	}

	for (const record of keys) {
		const file = record._sourceFile;
		if (!file || !grouped[file]) continue;
		const { _sourceFile, ...clean } = record;
		grouped[file].push(clean);
	}

	for (const [file, records] of Object.entries(grouped)) {
		const filePath = path.join(KEYS_DIR, file);
		const tmp = `${filePath}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(records, null, 2), 'utf8');
		fs.renameSync(tmp, filePath);
	}
}

function normalizeHwid(hwid) {
	return String(hwid || '').trim().toLowerCase();
}

function normalizeKey(key) {
	return String(key || '').trim().toUpperCase();
}

function expiryMsForType(type) {
	if (type === 'monthly') return MONTH_MS;
	if (type === 'trial') return TRIAL_MS;
	return 0;
}

function isExpired(record) {
	if (!record.expiresAt) return false;
	return new Date(record.expiresAt).getTime() <= Date.now();
}

function activateRecord(record, hwid) {
	const now = new Date();
	const nowIso = now.toISOString();

	if (record.status === 'unused' || !record.hwid) {
		record.status = 'active';
		record.hwid = hwid;
		record.activatedAt = nowIso;

		const duration = expiryMsForType(record.type);
		record.expiresAt = duration > 0 ? new Date(now.getTime() + duration).toISOString() : null;

		return {
			ok: true,
			message: 'Key activated successfully.',
			firstActivation: true,
		};
	}

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

loadKeys();

app.get('/', (_req, res) => {
	res.json({
		service: 'Nexus License Server',
		version: '3.0.0',
		endpoints: { activate: 'POST /activate' },
		keyFiles: KEY_FILES.map((k) => k.file),
	});
});

app.get('/health', (_req, res) => {
	const stats = keys.reduce(
		(acc, k) => {
			acc.total += 1;
			if (k.type === 'lifetime') acc.lifetime += 1;
			if (k.type === 'monthly') acc.monthly += 1;
			if (k.type === 'trial') acc.trial += 1;
			if (k.status === 'unused') acc.unused += 1;
			if (k.status === 'active') acc.active += 1;
			return acc;
		},
		{ total: 0, lifetime: 0, monthly: 0, trial: 0, unused: 0, active: 0 }
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

	const index = keys.findIndex((k) => normalizeKey(k.key) === key);
	if (index === -1) {
		return res.status(401).json({ success: false, message: 'Invalid key.' });
	}

	const record = keys[index];
	const result = activateRecord(record, hwid);

	if (!result.ok) {
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

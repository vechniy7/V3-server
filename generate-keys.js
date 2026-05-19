/**
 * Generates keys.json: 100 lifetime + 100 monthly keys for Nexus.
 * Skips if file already exists (set FORCE_KEYS=1 to overwrite).
 */
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const LIFETIME_COUNT = 100;
const MONTHLY_COUNT = 100;

function getKeysPath() {
	return process.env.KEYS_FILE
		? path.resolve(process.env.KEYS_FILE)
		: path.join(__dirname, 'keys.json');
}

function randomSegment(length) {
	const bytes = crypto.randomBytes(length);
	let out = '';
	for (let i = 0; i < length; i++) {
		out += CHARSET[bytes[i] % CHARSET.length];
	}
	return out;
}

function makeKey(prefix) {
	return `${prefix}-${randomSegment(4)}-${randomSegment(4)}-${randomSegment(4)}-${randomSegment(4)}`;
}

function createKey(type) {
	return {
		key: makeKey(type === 'lifetime' ? 'NXS-L' : 'NXS-M'),
		type,
		status: 'unused',
		hwid: null,
		activatedAt: null,
		expiresAt: null,
	};
}

function generateKeys() {
	const keys = [];
	const seen = new Set();

	while (keys.filter((k) => k.type === 'lifetime').length < LIFETIME_COUNT) {
		const k = createKey('lifetime');
		if (!seen.has(k.key)) {
			seen.add(k.key);
			keys.push(k);
		}
	}

	while (keys.filter((k) => k.type === 'monthly').length < MONTHLY_COUNT) {
		const k = createKey('monthly');
		if (!seen.has(k.key)) {
			seen.add(k.key);
			keys.push(k);
		}
	}

	return keys;
}

/**
 * Creates keys.json if missing. Returns { created, path, count }.
 */
function ensureKeysFile(options = {}) {
	const keysPath = options.keysPath || getKeysPath();
	const force = options.force || process.env.FORCE_KEYS === '1';

	if (!force && fs.existsSync(keysPath)) {
		try {
			const existing = JSON.parse(fs.readFileSync(keysPath, 'utf8'));
			if (Array.isArray(existing) && existing.length > 0) {
				return { created: false, path: keysPath, count: existing.length };
			}
		} catch {
			// broken file — regenerate below
		}
	}

	const dir = path.dirname(keysPath);
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}

	const keys = generateKeys();
	fs.writeFileSync(keysPath, JSON.stringify(keys, null, 2), 'utf8');

	const baseDir = path.dirname(keysPath);
	const lifetime = keys.filter((k) => k.type === 'lifetime').map((k) => k.key);
	const monthly = keys.filter((k) => k.type === 'monthly').map((k) => k.key);
	fs.writeFileSync(path.join(baseDir, 'keys-lifetime.txt'), lifetime.join('\n') + '\n', 'utf8');
	fs.writeFileSync(path.join(baseDir, 'keys-monthly.txt'), monthly.join('\n') + '\n', 'utf8');

	return { created: true, path: keysPath, count: keys.length };
}

function main() {
	const result = ensureKeysFile({ force: process.env.FORCE_KEYS === '1' });
	if (result.created) {
		console.log(`Created ${result.count} keys -> ${result.path}`);
		console.log('  keys-lifetime.txt / keys-monthly.txt updated');
	} else {
		console.log(`Keys already exist (${result.count}) -> ${result.path}`);
		console.log('  Set FORCE_KEYS=1 to regenerate.');
	}
}

module.exports = { ensureKeysFile, getKeysPath, generateKeys };

if (require.main === module) {
	main();
}

/**
 * Generates keys.json: 100 lifetime + 100 monthly keys for Nexus.
 * Run: node generate-keys.js
 */
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const OUT = path.join(__dirname, 'keys.json');
const CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomSegment(length) {
	const bytes = crypto.randomBytes(length);
	let out = '';
	for (let i = 0; i < length; i++) {
		out += CHARSET[bytes[i] % CHARSET.length];
	}
	return out;
}

function makeKey(prefix) {
	// NXS-L-XXXX-XXXX-XXXX-XXXX  (lifetime)
	// NXS-M-XXXX-XXXX-XXXX-XXXX  (monthly)
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

function main() {
	const keys = [];
	const seen = new Set();

	while (keys.filter((k) => k.type === 'lifetime').length < 100) {
		const k = createKey('lifetime');
		if (!seen.has(k.key)) {
			seen.add(k.key);
			keys.push(k);
		}
	}

	while (keys.filter((k) => k.type === 'monthly').length < 100) {
		const k = createKey('monthly');
		if (!seen.has(k.key)) {
			seen.add(k.key);
			keys.push(k);
		}
	}

	fs.writeFileSync(OUT, JSON.stringify(keys, null, 2), 'utf8');

	const lifetime = keys.filter((k) => k.type === 'lifetime').map((k) => k.key);
	const monthly = keys.filter((k) => k.type === 'monthly').map((k) => k.key);
	fs.writeFileSync(path.join(__dirname, 'keys-lifetime.txt'), lifetime.join('\n') + '\n', 'utf8');
	fs.writeFileSync(path.join(__dirname, 'keys-monthly.txt'), monthly.join('\n') + '\n', 'utf8');

	console.log(`Wrote ${keys.length} keys to ${OUT}`);
	console.log(`  Lifetime: ${lifetime.length} -> keys-lifetime.txt`);
	console.log(`  Monthly:  ${monthly.length} -> keys-monthly.txt`);
}

main();

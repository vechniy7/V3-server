/**
 * One-time generator for keys/ folder (run locally: node generate-keys.js).
 * Not used by the server at startup.
 */
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const KEYS_DIR = path.join(__dirname, 'keys');
const CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const PLAN = { id: 'lifetime', prefix: 'NXS-L', count: 500, json: 'lifetime.json', txt: 'lifetime.txt' };

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

function generatePlan(plan, globalSeen) {
	const records = [];
	while (records.length < plan.count) {
		const key = makeKey(plan.prefix);
		if (globalSeen.has(key)) continue;
		globalSeen.add(key);
		records.push({
			key,
			type: plan.id,
			status: 'unused',
			hwid: null,
			activatedAt: null,
			expiresAt: null,
		});
	}
	return records;
}

function main() {
	if (!fs.existsSync(KEYS_DIR)) {
		fs.mkdirSync(KEYS_DIR, { recursive: true });
	}

	const globalSeen = new Set();
	const records = generatePlan(PLAN, globalSeen);
	const jsonPath = path.join(KEYS_DIR, PLAN.json);
	const txtPath = path.join(KEYS_DIR, PLAN.txt);

	fs.writeFileSync(jsonPath, JSON.stringify(records, null, 2), 'utf8');
	fs.writeFileSync(txtPath, records.map((r) => r.key).join('\n') + '\n', 'utf8');

	console.log(`${PLAN.id}: ${records.length} -> keys/${PLAN.json}, keys/${PLAN.txt}`);
	console.log(`Done. Total keys: ${records.length}`);
}

main();

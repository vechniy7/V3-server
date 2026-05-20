/**
 * One-time generator for keys/ folder (run locally: node generate-keys.js).
 * Not used by the server at startup.
 */
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const KEYS_DIR = path.join(__dirname, 'keys');
const CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const PLANS = [
	{ id: 'lifetime', prefix: 'NXS-L', count: 500, json: 'lifetime.json', txt: 'lifetime.txt' },
	{ id: 'monthly', prefix: 'NXS-M', count: 500, json: 'monthly.json', txt: 'monthly.txt' },
	{ id: 'trial', prefix: 'NXS-T', count: 500, json: 'trial-5min.json', txt: 'trial-5min.txt' },
];

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
	let total = 0;

	for (const plan of PLANS) {
		const records = generatePlan(plan, globalSeen);
		const jsonPath = path.join(KEYS_DIR, plan.json);
		const txtPath = path.join(KEYS_DIR, plan.txt);

		fs.writeFileSync(jsonPath, JSON.stringify(records, null, 2), 'utf8');
		fs.writeFileSync(txtPath, records.map((r) => r.key).join('\n') + '\n', 'utf8');

		console.log(`${plan.id}: ${records.length} -> keys/${plan.json}, keys/${plan.txt}`);
		total += records.length;
	}

	console.log(`Done. Total keys: ${total}`);
}

main();

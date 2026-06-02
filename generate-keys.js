/**
 * Offline key generator (run locally: node generate-keys.js).
 * Server also creates keys via admin panel API.
 */
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { PLAN_PREFIX } = require('./lib/licensePlans');

const KEYS_DIR = path.join(__dirname, 'keys');
const CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const PLANS = [
	{ id: 'trial_2m', prefix: PLAN_PREFIX.trial_2m, count: 1000, json: 'trial_2m.json', txt: 'trial_2m.txt' },
	{ id: 'month_1', prefix: PLAN_PREFIX.month_1, count: 1000, json: 'month_1.json', txt: 'month_1.txt' },
	{ id: 'month_3', prefix: PLAN_PREFIX.month_3, count: 1000, json: 'month_3.json', txt: 'month_3.txt' },
	{ id: 'lifetime', prefix: PLAN_PREFIX.lifetime, count: 1000, json: 'lifetime.json', txt: 'lifetime.txt' },
];

function randomSegment(length) {
	const bytes = crypto.randomBytes(length);
	let out = '';
	for (let i = 0; i < length; i++) out += CHARSET[bytes[i] % CHARSET.length];
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
	if (!fs.existsSync(KEYS_DIR)) fs.mkdirSync(KEYS_DIR, { recursive: true });

	const globalSeen = new Set();
	let total = 0;

	for (const plan of PLANS) {
		const records = generatePlan(plan, globalSeen);
		fs.writeFileSync(path.join(KEYS_DIR, plan.json), JSON.stringify(records, null, 2), 'utf8');
		fs.writeFileSync(path.join(KEYS_DIR, plan.txt), records.map((r) => r.key).join('\n') + '\n', 'utf8');
		console.log(`${plan.id}: ${records.length} -> keys/${plan.json}`);
		total += records.length;
	}
	console.log(`Done. Total keys: ${total}`);
}

main();

/** License duration plans (ms from activation). */
const PLAN_MS = {
	trial_2m: 2 * 60 * 1000,
	month_1: 30 * 24 * 60 * 60 * 1000,
	month_3: 90 * 24 * 60 * 60 * 1000,
	lifetime: null,
};

const PLAN_PREFIX = {
	trial_2m: 'NXS-T2',
	month_1: 'NXS-1M',
	month_3: 'NXS-3M',
	lifetime: 'NXS-L',
};

const PLAN_LABEL = {
	trial_2m: '2 minutes (test)',
	month_1: '1 month',
	month_3: '3 months',
	lifetime: 'Lifetime',
};

function isValidPlanType(type) {
	return Object.prototype.hasOwnProperty.call(PLAN_MS, type);
}

function computeExpiresAt(type, activatedAtIso) {
	const ms = PLAN_MS[type];
	if (!ms) return null;
	return new Date(new Date(activatedAtIso).getTime() + ms).toISOString();
}

function isExpired(record) {
	if (!record?.expiresAt) return false;
	const t = Date.parse(record.expiresAt);
	return Number.isFinite(t) && Date.now() > t;
}

module.exports = {
	PLAN_MS,
	PLAN_PREFIX,
	PLAN_LABEL,
	isValidPlanType,
	computeExpiresAt,
	isExpired,
};

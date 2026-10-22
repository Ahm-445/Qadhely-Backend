function normalizeSaudiPhone(input) {
	if (!input) return null;

	// Remove spaces, dashes, dots and parentheses
	const cleaned = String(input).trim().replace(/[\s\-().]/g, '');

	// 009665… | 9665… | +9665… | 05… | 5…  → capture the 9-digit local part (5XXXXXXXX)
	const match = cleaned.match(/^(?:\+966|00966|966|0)?(5\d{8})$/);
	return match ? `+966${match[1]}` : null;
}

module.exports = { normalizeSaudiPhone };
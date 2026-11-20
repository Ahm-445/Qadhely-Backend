// AI suggestions — parity between the Python model and the Node scorer.
//
// ml/train.py writes ml/out/parity_fixture.json: a small history, a fixed "now", the features
// ml/features.py computed for every candidate, and the probability scikit-learn gave each one.
// src/services/suggestions.js must produce the same numbers, or the model is quietly wrong at serving
// time while every other test still passes.
//
// Run from src/:  npm test -- us23.suggestions.parity

const { candidateFeatures, tripRows, score, MODEL } = require("../src/services/suggestions");
const fixture = require("../ml/out/parity_fixture.json");

const TOLERANCE = 1e-6;

const now = Date.parse(fixture.now);
const trips = tripRows(fixture.history);
const candidates = candidateFeatures(trips, now, fixture.fallbackMedianInterval);
const byId = new Map(candidates.map((candidate) => [candidate.catalogItemId, candidate]));


describe("the model file and the fixture belong together", () => {

	test("the fixture was written by the model that is loaded", () => {
		expect(fixture.modelVersion).toBe(MODEL.version);
		expect(fixture.features).toEqual(MODEL.features);
	});

	test("the fixture carries the nine features of the plan", () => {
		expect(MODEL.features).toEqual([
			"trip_freq",
			"recent_freq",
			"log_count",
			"days_since_last",
			"trips_since_last",
			"median_interval",
			"due_ratio",
			"interval_cv",
			"in_last_trip",
		]);
	});

});


describe("the same history gives the same candidates", () => {

	test("the trip count and the candidate set match Python", () => {
		expect(candidates.map((candidate) => candidate.catalogItemId))
			.toEqual(fixture.candidates.map((candidate) => candidate.catalogItemId));
	});

	test("an addition whose trip never completed is not a candidate", () => {
		const bought = trips.flatMap((trip) => [...trip.itemIds]);

		expect(bought).not.toContain("tamimi-000000");
	});

	test("custom items are not candidates either", () => {
		const withCustom = [
			...fixture.history,
			{
				group: "g000",
				tripId: "g000-t99",
				catalogItemId: null,
				customName: "Birthday cake",
				quantity: 1,
				unit: "piece",
				addedAt: fixture.now,
				createdAt: fixture.now,
				status: "found",
			},
		];

		const ids = candidateFeatures(tripRows(withCustom), now, fixture.fallbackMedianInterval)
			.map((candidate) => candidate.catalogItemId);

		expect(ids).toEqual(fixture.candidates.map((candidate) => candidate.catalogItemId));
	});

});


describe("every feature matches Python", () => {

	test.each(fixture.candidates.map((expected) => [expected.catalogItemId, expected.features]))(
		"%s",
		(catalogItemId, expected) => {
			const candidate = byId.get(catalogItemId);

			expect(candidate).toBeDefined();

			for (const name of MODEL.features) {
				expect(Number.isFinite(candidate.features[name])).toBe(true);
				expect(Math.abs(candidate.features[name] - expected[name])).toBeLessThan(TOLERANCE);
			}
		}
	);

});


describe("every probability matches Python", () => {

	test.each(fixture.candidates.map((expected) => [expected.catalogItemId, expected.probability]))(
		"%s",
		(catalogItemId, expected) => {
			const probability = score(byId.get(catalogItemId).features);

			expect(Math.abs(probability - expected)).toBeLessThan(TOLERANCE);
		}
	);

	test("the scorer's probabilities are in [0, 1]", () => {
		for (const candidate of candidates) {
			const probability = score(candidate.features);

			expect(probability).toBeGreaterThanOrEqual(0);
			expect(probability).toBeLessThanOrEqual(1);
		}
	});

});

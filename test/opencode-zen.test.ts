import assert from "node:assert/strict";
import test from "node:test";
import { normalizeOpenCodeZenBalance } from "../src/providers/opencode-zen.ts";
import { SUPPORTED_ADAPTERS } from "../src/query.ts";

const capturedAt = Date.parse("2030-01-01T00:00:00Z");

test("OpenCode Zen adapter is registered with the official origin", () => {
	const adapter = SUPPORTED_ADAPTERS.find(
		(candidate) => candidate.id === "opencode",
	);
	assert.ok(adapter);
	assert.deepEqual(adapter.providerIds, ["opencode"]);
	assert.deepEqual(adapter.officialOrigins, ["https://opencode.ai"]);
});

test("normalizes microcents into a USD wallet balance", () => {
	const report = normalizeOpenCodeZenBalance(
		{ availableMicroCents: 150_000_000 },
		capturedAt,
	);
	assert.equal(report.providerId, "opencode");
	assert.equal(report.buckets.length, 0);
	assert.deepEqual(report.metrics, [
		{ id: "balance", label: "Wallet balance", value: 1.5, unit: "usd" },
	]);
	assert.equal(report.notes, undefined);
});

test("accepts string microcents and invoiceable credit mode", () => {
	const report = normalizeOpenCodeZenBalance(
		{ availableMicroCents: "250000000", mode: "invoiceable" },
		capturedAt,
	);
	assert.deepEqual(report.metrics, [
		{ id: "balance", label: "Available credit", value: 2.5, unit: "usd" },
	]);
});

test("exhausted balance is reported, not hidden", () => {
	const report = normalizeOpenCodeZenBalance(
		{ availableMicroCents: 0 },
		capturedAt,
	);
	assert.equal(report.metrics[0]?.value, 0);
	assert.ok(report.notes?.includes("Balance is exhausted."));
});

test("missing or invalid balance stays unknown", () => {
	for (const payload of [
		undefined,
		{},
		{ availableMicroCents: null },
		{ availableMicroCents: "abc" },
		{ availableMicroCents: 1.5 },
	]) {
		const report = normalizeOpenCodeZenBalance(payload, capturedAt);
		assert.equal(report.metrics.length, 0);
		assert.ok(
			report.notes?.includes(
				"Billing response did not include a valid balance.",
			),
		);
	}
});

test("a negative balance is clamped to zero with a note", () => {
	const report = normalizeOpenCodeZenBalance(
		{ availableMicroCents: -123_000_000 },
		capturedAt,
	);
	assert.equal(report.metrics[0]?.value, 0);
	assert.ok(
		report.notes?.includes("Balance was reported negative and is displayed as 0."),
	);
});

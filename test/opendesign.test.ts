import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	fetchOpenDesignQuota,
	normalizeOpenDesignQuota,
	readOpenDesignControlKey,
} from "../src/providers/opendesign.ts";
import { SUPPORTED_ADAPTERS } from "../src/query.ts";

const capturedAt = Date.parse("2030-01-01T00:00:00Z");
const controlKey = "vela_ctrl_fixture";
const windows = [
	{
		durationSeconds: 604_800,
		usedCredits: "16251",
		limitCredits: "150000",
		resetsAt: "2030-01-08T00:00:00.000Z",
	},
	{
		durationSeconds: 18_000,
		usedCredits: "16251",
		limitCredits: "50000",
		resetsAt: "2030-01-01T05:00:00.000Z",
	},
];
const preflight = {
	balanceUsd: "1.5000",
	funding: "wallet",
	codingPlan: { eligible: true, tier: "go", windows },
};
const summary = {
	membershipTier: "go",
	balanceUsd: "2.0000",
	subscriptionCurrentPeriodEnd: "2030-02-01T00:00:00.000Z",
};

test("OpenDesign adapter is registered with control-plane origin", () => {
	const adapter = SUPPORTED_ADAPTERS.find(
		(candidate) => candidate.id === "opendesign",
	);
	assert.ok(adapter);
	assert.deepEqual(adapter.providerIds, ["opendesign"]);
	assert.ok(adapter.officialOrigins.includes("https://amr-api.open-design.ai"));
	assert.ok(
		adapter.officialOrigins.includes("https://amr-link.open-design.ai"),
	);
});

test("normalizes 5h/7d windows, wallet balance and plan", () => {
	const report = normalizeOpenDesignQuota(
		{ preflight, summary },
		capturedAt,
	);
	assert.equal(report.providerId, "opendesign");
	assert.equal(report.buckets.length, 2);
	assert.deepEqual(
		report.buckets.map((bucket) => bucket.label),
		["5 hours", "7 days"],
	);
	assert.equal(report.buckets[0]?.used, 32.5);
	assert.equal(report.buckets[0]?.remaining, 67.5);
	assert.equal(report.buckets[1]?.used, 10.8);
	assert.equal(report.buckets[1]?.remaining, 89.2);
	assert.equal(report.metrics[0]?.id, "balance");
	assert.equal(report.metrics[0]?.value, 1.5);
	assert.equal(report.metrics[0]?.unit, "usd");
	assert.ok(report.notes?.includes("Design Plan: go"));
});

test("an ineligible coding plan yields no windows and an explicit note", () => {
	const report = normalizeOpenDesignQuota(
		{
			preflight: { balanceUsd: "3", codingPlan: { eligible: false } },
			summary,
		},
		capturedAt,
	);
	assert.equal(report.buckets.length, 0);
	assert.ok(
		report.notes?.some((note) => /no Design Plan allowance/.test(note)),
	);
});

test("missing summary degrades to preflight data without failing", () => {
	const report = normalizeOpenDesignQuota(
		{ preflight, summaryUnavailable: true },
		capturedAt,
	);
	assert.equal(report.buckets.length, 2);
	assert.ok(
		report.notes?.some((note) => /Billing summary unavailable/.test(note)),
	);
});

test("missing balance is reported instead of fabricated as zero", () => {
	const report = normalizeOpenDesignQuota(
		{ preflight: { codingPlan: { eligible: true, windows } } },
		capturedAt,
	);
	assert.equal(report.metrics.length, 0);
	assert.ok(report.notes?.includes("Wallet balance unavailable."));
});

test("quota reads use only the fixed control origin and never the runtime key", async () => {
	const seen: Array<{ url: string; init?: RequestInit }> = [];
	const fetchImpl: typeof fetch = async (input, init) => {
		const url = String(input);
		seen.push({ url, init });
		if (url.endsWith("/api/v1/workspaces/current")) {
			return Response.json({ activeWorkspaceId: "ws/fixture" });
		}
		if (url.includes("/billing/preflight")) return Response.json(preflight);
		if (url.endsWith("/api/v1/billing/summary")) return Response.json(summary);
		throw new Error(`unexpected request: ${url}`);
	};
	const payload = await fetchOpenDesignQuota(
		controlKey,
		new AbortController().signal,
		1000,
		fetchImpl,
	);
	assert.deepEqual(
		seen.map(({ url }) => url),
		[
			"https://amr-api.open-design.ai/api/v1/workspaces/current",
			"https://amr-api.open-design.ai/api/v1/workspaces/ws%2Ffixture/billing/preflight",
			"https://amr-api.open-design.ai/api/v1/billing/summary",
		],
	);
	for (const { init } of seen) {
		assert.equal(init?.method, "GET");
		assert.equal(init?.redirect, "error");
		assert.equal(
			(init?.headers as Record<string, string>).Authorization,
			`Bearer ${controlKey}`,
		);
		assert.ok(!JSON.stringify(init).includes("sk-amr-"));
	}
	const report = normalizeOpenDesignQuota(payload, capturedAt);
	assert.equal(report.buckets.length, 2);
});

test("a failed billing summary downgrades instead of failing the query", async () => {
	const fetchImpl: typeof fetch = async (input) => {
		const url = String(input);
		if (url.endsWith("/workspaces/current")) {
			return Response.json({ activeWorkspaceId: "ws_fixture" });
		}
		if (url.includes("/billing/preflight")) return Response.json(preflight);
		return new Response("unavailable", { status: 503 });
	};
	const payload = await fetchOpenDesignQuota(
		controlKey,
		new AbortController().signal,
		1000,
		fetchImpl,
	);
	assert.equal(payload.summaryUnavailable, true);
	assert.equal(payload.summary, undefined);
	const report = normalizeOpenDesignQuota(payload, capturedAt);
	assert.equal(report.buckets.length, 2);
});

test("refuses a non-control key before any request", async () => {
	let called = false;
	const fetchImpl: typeof fetch = async () => {
		called = true;
		return Response.json({});
	};
	await assert.rejects(
		fetchOpenDesignQuota(
			"sk-amr-runtime",
			new AbortController().signal,
			1000,
			fetchImpl,
		),
		/untrusted control origin or key/,
	);
	assert.equal(called, false);
});

test("reads the control key only from the OpenDesign record", () => {
	const dir = mkdtempSync(join(tmpdir(), "od-cred-"));
	const file = join(dir, ".credentials.yaml");
	writeFileSync(
		file,
		[
			"refs:",
			"  OTHER: sk-amr-not-this-one",
			"  dsh-opencode-live-models/opendesign:",
			"    kind: grant",
			"    payload:",
			"      type: oauth",
			"      access: sk-amr-fixture",
			"      control: vela_ctrl_fixture",
			"      uid: fixture",
			"",
		].join("\n"),
	);
	assert.equal(readOpenDesignControlKey(file)?.controlKey, controlKey);

	const apiKeyOnly = join(dir, "api-key.yaml");
	writeFileSync(
		apiKeyOnly,
		[
			"  dsh-opencode-live-models/opendesign:",
			"    kind: grant",
			"    payload:",
			"      type: api-key",
			"      access: sk-amr-fixture",
			"",
		].join("\n"),
	);
	assert.equal(readOpenDesignControlKey(apiKeyOnly), undefined);
});

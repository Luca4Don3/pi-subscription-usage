// OpenCode Zen 钱包余额。
//
// Zen 的计费接口与 Go 订阅窗口分开：Go 走 /zen/go/v1/usage 的百分比窗口，
// Zen 走 console billing 的 availableMicroCents（1 USD = 100,000,000）。
import type { UsageMetric, UsageReport } from "../types.ts";

/** Console BillingStatus uses signed integer microcents. */
const MICROCENTS_PER_USD = 100_000_000;

export function normalizeOpenCodeZenBalance(
	payload: unknown,
	capturedAt: number,
): UsageReport {
	const root = asObject(payload);
	const microcents = asSafeInteger(root?.availableMicroCents);
	const rawAmount =
		microcents === undefined ? undefined : microcents / MICROCENTS_PER_USD;
	const amount = rawAmount === undefined ? undefined : Math.max(0, rawAmount);
	const metrics: UsageMetric[] = [];
	if (amount !== undefined) {
		metrics.push({
			id: "balance",
			label: root?.mode === "invoiceable" ? "Available credit" : "Wallet balance",
			value: amount,
			unit: "usd",
		});
	}
	const notes: string[] = [];
	if (amount === undefined) {
		notes.push("Billing response did not include a valid balance.");
	}
	if (rawAmount !== undefined && rawAmount < 0) {
		notes.push("Balance was reported negative and is displayed as 0.");
	} else if (amount !== undefined && amount <= 0) {
		notes.push("Balance is exhausted.");
	}
	return {
		providerId: "opencode",
		providerName: "OpenCode Zen",
		capturedAt,
		source: "opencode-zen-billing",
		semantics: {
			kind: "consumer-subscription",
			label: "OpenCode Zen wallet balance",
		},
		buckets: [],
		metrics,
		...(notes.length > 0 ? { notes } : {}),
	};
}

function asObject(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function asSafeInteger(value: unknown): number | undefined {
	if (typeof value === "number") {
		return Number.isSafeInteger(value) ? value : undefined;
	}
	if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
		const parsed = Number(value);
		return Number.isSafeInteger(parsed) ? parsed : undefined;
	}
	return undefined;
}

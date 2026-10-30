// OpenDesign 控制面额度读取。
//
// 模型请求用 runtime key（sk-amr-…）；额度查询只接受 control key（vela_ctrl_…），
// 且只发往 amr-api 控制面。control key 由本扩展自己的授权流程
// （/opendesign-login）保存到 Pi 配置，或由 OPENDESIGN_CONTROL_KEY 提供；
// 不读取其他工具（如 DSH）的凭据，也不把 runtime key 发到控制面。
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { sanitizeDisplayText } from "../core.ts";
import type { UsageBucket, UsageMetric, UsageReport } from "../types.ts";

export const OPENDESIGN_CONTROL_ORIGIN = "https://amr-api.open-design.ai";
export const USAGE_CONFIG_FILE = "subscription-usage.json";

/** 与 Pi 的 getAgentDir() 一致：PI_AGENT_DIR 优先，否则 ~/.pi/agent。 */
export function piAgentDir(): string {
	const env = process.env.PI_AGENT_DIR;
	if (env) {
		return env.startsWith("~") ? join(homedir(), env.slice(1)) : env;
	}
	return join(homedir(), ".pi", "agent");
}

export function usageConfigPath(): string {
	return join(piAgentDir(), USAGE_CONFIG_FILE);
}

const MAX_BODY_BYTES = 128 * 1024;
const MAX_TIMEOUT_MS = 30_000;

/**
 * 只读取当前 Pi agent 自己的配置：环境变量优先，其次是
 * ~/.pi/agent/subscription-usage.json 中的 opendesignControlKey。
 */
export function readOpenDesignControlKey(
	configFile = usageConfigPath(),
): string | undefined {
	const env = process.env.OPENDESIGN_CONTROL_KEY?.trim();
	if (env && /^vela_ctrl_[!-~]+$/.test(env)) return env;
	if (!existsSync(configFile)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(configFile, "utf8")) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return undefined;
		}
		const value = (parsed as Record<string, unknown>).opendesignControlKey;
		return typeof value === "string" && /^vela_ctrl_[!-~]+$/.test(value.trim())
			? value.trim()
			: undefined;
	} catch {
		return undefined;
	}
}

export interface OpenDesignQuotaPayload {
	workspace?: Record<string, unknown>;
	preflight?: Record<string, unknown>;
	summary?: Record<string, unknown>;
	summaryUnavailable?: boolean;
}

/**
 * 依次读取 workspace、billing preflight 与可选的 billing summary。
 * summary 失败只降级补充信息，不影响主额度窗口。
 */
export async function fetchOpenDesignQuota(
	controlKey: string,
	signal: AbortSignal,
	timeoutMs: number,
	fetchImpl: typeof fetch = globalThis.fetch,
): Promise<OpenDesignQuotaPayload> {
	const workspace = await requestControlJson(
		"/api/v1/workspaces/current",
		controlKey,
		signal,
		timeoutMs,
		fetchImpl,
	);
	const workspaceId =
		asString(workspace.activeWorkspaceId) ?? asString(workspace.workspaceId);
	if (!workspaceId) {
		throw new Error("OpenDesign workspace id was not returned.");
	}
	const preflight = await requestControlJson(
		`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/billing/preflight`,
		controlKey,
		signal,
		timeoutMs,
		fetchImpl,
	);
	let summary: Record<string, unknown> | undefined;
	let summaryUnavailable = false;
	try {
		summary = await requestControlJson(
			"/api/v1/billing/summary",
			controlKey,
			signal,
			timeoutMs,
			fetchImpl,
		);
	} catch (error) {
		if (isAbortError(error) || signal.aborted) throw error;
		summaryUnavailable = true;
	}
	return { workspace, preflight, summary, summaryUnavailable };
}

const WINDOW_LABELS: Readonly<Record<number, string>> = {
	18_000: "5 hours",
	604_800: "7 days",
};

export function normalizeOpenDesignQuota(
	payload: OpenDesignQuotaPayload,
	capturedAt: number,
): UsageReport {
	const preflight = asObject(payload.preflight) ?? {};
	const summary = asObject(payload.summary) ?? {};
	const workspace = asObject(payload.workspace) ?? {};
	const codingPlan = asObject(preflight.codingPlan);
	const rawWindows =
		codingPlan?.eligible === false ? [] : (asArray(codingPlan?.windows) ?? []);
	const buckets: UsageBucket[] = rawWindows.flatMap((raw, index) => {
		const window = asObject(raw);
		if (!window) return [];
		const used = asNonnegativeNumber(window.usedCredits);
		const limit = asNonnegativeNumber(window.limitCredits);
		const seconds = asNonnegativeNumber(window.durationSeconds);
		if (
			used === undefined ||
			limit === undefined ||
			limit <= 0 ||
			seconds === undefined ||
			seconds <= 0
		) {
			return [];
		}
		const ratio = (used / limit) * 100;
		if (!Number.isFinite(ratio)) return [];
		const usedPercent = Math.round(clampPercent(ratio) * 10) / 10;
		const resetsAt = asEpochSeconds(window.resetsAt);
		return [
			{
				id: `window-${seconds}-${index}`,
				label: WINDOW_LABELS[seconds] ?? windowLabel(seconds),
				used: usedPercent,
				remaining: Math.round((100 - usedPercent) * 10) / 10,
				limit: 100,
				unit: "percent",
				windowMinutes: Math.ceil(seconds / 60),
				...(resetsAt === undefined ? {} : { resetsAt }),
			} satisfies UsageBucket,
		];
	});
	buckets.sort((a, b) => (a.windowMinutes ?? 0) - (b.windowMinutes ?? 0));

	const metrics: UsageMetric[] = [];
	const balance =
		asNonnegativeNumber(preflight.balanceUsd) ??
		asNonnegativeNumber(summary.balanceUsd) ??
		asNonnegativeNumber(summary.totalAvailableCreditsUsd);
	if (balance !== undefined) {
		metrics.push({ id: "balance", label: "Wallet balance", value: balance, unit: "usd" });
	}

	const notes: string[] = [];
	const tier =
		asString(summary.membershipTier) ??
		asString(codingPlan?.tier) ??
		asString(workspace.personalMembershipTier);
	if (tier) notes.push(`Design Plan: ${tier}`);
	if (payload.summaryUnavailable) {
		notes.push("Billing summary unavailable; plan and renewal details are unknown.");
	}
	if (balance === undefined) notes.push("Wallet balance unavailable.");
	if (buckets.length === 0 && codingPlan?.eligible !== false) {
		notes.push("No subscription usage windows were returned.");
	}
	if (codingPlan?.eligible === false) {
		notes.push("This account has no Design Plan allowance; requests may draw from the wallet.");
	}

	return {
		providerId: "opendesign",
		providerName: "OpenDesign",
		capturedAt,
		source: "opendesign-control-plane",
		semantics: {
			kind: "consumer-subscription",
			label: "OpenDesign Design Plan usage and wallet",
		},
		buckets,
		metrics,
		...(notes.length > 0 ? { notes } : {}),
	};
}

async function requestControlJson(
	path: string,
	controlKey: string,
	signal: AbortSignal,
	timeoutMs: number,
	fetchImpl: typeof fetch,
): Promise<Record<string, unknown>> {
	const url = new URL(path, OPENDESIGN_CONTROL_ORIGIN);
	if (
		url.origin !== OPENDESIGN_CONTROL_ORIGIN ||
		url.username ||
		url.password ||
		!url.pathname.startsWith("/api/v1/") ||
		!/^vela_ctrl_[!-~]+$/.test(controlKey)
	) {
		throw new Error("OpenDesign quota request was refused: untrusted control origin or key.");
	}
	const controller = new AbortController();
	const abortFromCaller = () => controller.abort();
	if (signal.aborted) controller.abort();
	else signal.addEventListener("abort", abortFromCaller, { once: true });
	const timer = setTimeout(
		() => controller.abort(),
		Math.min(Math.max(1, timeoutMs), MAX_TIMEOUT_MS),
	);
	try {
		const response = await fetchImpl(url.href, {
			method: "GET",
			headers: {
				Accept: "application/json",
				Authorization: `Bearer ${controlKey}`,
				"User-Agent": "pi-subscription-usage",
			},
			redirect: "error",
			signal: controller.signal,
		});
		if (response.redirected) {
			throw new Error("OpenDesign quota request was refused: redirected response.");
		}
		if (!response.ok) {
			void response.body?.cancel?.().catch(() => {});
			throw new Error(
				`OpenDesign quota endpoint returned HTTP ${response.status}.`,
			);
		}
		const text = await readBoundedText(response);
		const parsed = JSON.parse(text) as unknown;
		const object = asObject(parsed);
		if (!object) {
			throw new Error("OpenDesign quota endpoint returned an invalid JSON object.");
		}
		return object;
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", abortFromCaller);
	}
}

async function readBoundedText(response: Response): Promise<string> {
	const declared = Number(response.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
		throw new Error("OpenDesign quota response exceeded the size limit.");
	}
	const reader = response.body?.getReader();
	if (!reader) throw new Error("OpenDesign quota response had no body.");
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		for (;;) {
			const part = await reader.read();
			if (part.done) break;
			bytes += part.value.byteLength;
			if (bytes > MAX_BODY_BYTES) {
				void reader.cancel().catch(() => {});
				throw new Error("OpenDesign quota response exceeded the size limit.");
			}
			chunks.push(part.value);
		}
	} finally {
		reader.releaseLock();
	}
	return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), bytes).toString("utf8");
}

function windowLabel(seconds: number): string {
	if (seconds % 86_400 === 0) {
		const days = seconds / 86_400;
		return `${days} day${days === 1 ? "" : "s"}`;
	}
	if (seconds % 3_600 === 0) {
		const hours = seconds / 3_600;
		return `${hours} hour${hours === 1 ? "" : "s"}`;
	}
	return `${Math.ceil(seconds / 60)} minutes`;
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

function clampPercent(value: number): number {
	return Math.min(100, Math.max(0, value));
}

function asObject(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function asArray(value: unknown): unknown[] | undefined {
	return Array.isArray(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string"
		? sanitizeDisplayText(value, 80) || undefined
		: undefined;
}

function asNonnegativeNumber(value: unknown): number | undefined {
	if (typeof value === "number") {
		return Number.isFinite(value) && value >= 0 ? value : undefined;
	}
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
	}
	return undefined;
}

function asEpochSeconds(value: unknown): number | undefined {
	if (typeof value !== "string" || !value.trim()) return undefined;
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? undefined : Math.floor(parsed / 1000);
}

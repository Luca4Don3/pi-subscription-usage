// OpenDesign 设备授权（仅使用当前 Pi agent 自己的凭据）。
//
// 流程：POST /api/v1/cli/device-authorizations 取得激活链接与设备密钥，
// 轮询 /{deviceId}/token 直到用户在浏览器里确认，然后把 control key
// 保存到 ~/.pi/agent/subscription-usage.json（0600）。
// 不读取 DSH 或其他工具的凭据。
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
	OPENDESIGN_CONTROL_ORIGIN,
	usageConfigPath,
} from "./providers/opendesign.ts";

const ACTIVATE_ORIGIN = "https://open-design.ai";
const ACTIVATE_PATH = "/cloud/cli/activate";
const DEVICE_PATH = "/api/v1/cli/device-authorizations";
const MAX_LOGIN_MS = 15 * 60 * 1000;
const MAX_BODY_BYTES = 64 * 1024;

export interface OpenDesignDeviceLogin {
	activationUrl: string;
	userCode?: string;
	deviceId: string;
	deviceSecret: string;
	expiresAt: number;
	intervalMs: number;
}

export async function startOpenDesignDeviceLogin(
	fetchImpl: typeof fetch = globalThis.fetch,
): Promise<OpenDesignDeviceLogin> {
	const response = await fetchImpl(`${OPENDESIGN_CONTROL_ORIGIN}${DEVICE_PATH}`, {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/json",
			"User-Agent": "pi-subscription-usage",
		},
		body: JSON.stringify({
			cliVersion: "0.1.4",
			host: "pi-subscription-usage",
			profile: "prod",
		}),
		redirect: "error",
	});
	if (!response.ok) {
		throw new Error(
			`OpenDesign device authorization returned HTTP ${response.status}.`,
		);
	}
	const body = await readJsonObject(response);
	const activationUrl = asString(body.activationUrl);
	const deviceId = asString(body.deviceId);
	const deviceSecret = asString(body.deviceSecret);
	const userCode = asString(body.userCode);
	if (
		!activationUrl ||
		!deviceId ||
		!deviceSecret ||
		deviceId.length > 512 ||
		deviceSecret.length > 8192 ||
		/[\u0000-\u001f\u007f]/.test(deviceId + deviceSecret)
	) {
		throw new Error("OpenDesign device authorization response was incomplete.");
	}
	const url = new URL(activationUrl);
	if (
		url.origin !== ACTIVATE_ORIGIN ||
		url.pathname !== ACTIVATE_PATH ||
		url.username ||
		url.password ||
		url.hash ||
		decodeURIComponent(url.href).includes(deviceSecret)
	) {
		throw new Error("OpenDesign activation link was not trusted.");
	}
	const now = Date.now();
	const parsedExpiry =
		typeof body.expiresAt === "string" ? Date.parse(body.expiresAt) : Number.NaN;
	const expiresAt = Math.min(
		Number.isFinite(parsedExpiry) ? parsedExpiry : now + 10 * 60 * 1000,
		now + MAX_LOGIN_MS,
	);
	if (expiresAt <= now) {
		throw new Error("OpenDesign authorization code already expired.");
	}
	const seconds = Number(body.pollIntervalSeconds);
	const intervalMs =
		Number.isFinite(seconds) && seconds > 0
			? Math.max(1000, seconds * 1000)
			: 2000;
	return {
		activationUrl: url.href,
		...(userCode ? { userCode } : {}),
		deviceId,
		deviceSecret,
		expiresAt,
		intervalMs,
	};
}

export async function pollOpenDesignDeviceLogin(
	login: OpenDesignDeviceLogin,
	options: {
		signal?: AbortSignal;
		fetchImpl?: typeof fetch;
		wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
	} = {},
): Promise<{ controlKey: string }> {
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;
	const wait = options.wait ?? delay;
	while (Date.now() < login.expiresAt) {
		if (options.signal?.aborted) {
			throw new Error("OpenDesign login was cancelled.");
		}
		await wait(
			Math.min(login.intervalMs, login.expiresAt - Date.now()),
			options.signal,
		);
		let response: Response;
		try {
			response = await fetchImpl(
				`${OPENDESIGN_CONTROL_ORIGIN}${DEVICE_PATH}/${encodeURIComponent(login.deviceId)}/token`,
				{
					method: "POST",
					headers: {
						Accept: "application/json",
						"Content-Type": "application/json",
						"User-Agent": "pi-subscription-usage",
					},
					body: JSON.stringify({ deviceSecret: login.deviceSecret }),
					redirect: "error",
					...(options.signal ? { signal: options.signal } : {}),
				},
			);
		} catch {
			if (options.signal?.aborted) {
				throw new Error("OpenDesign login was cancelled.");
			}
			continue;
		}
		if (
			response.status === 401 ||
			response.status === 403 ||
			response.status === 404
		) {
			throw new Error("OpenDesign device authorization expired or was denied.");
		}
		if (!response.ok) continue;
		const body = await readJsonObject(response);
		const status =
			typeof body.status === "string" ? body.status.toLowerCase() : "";
		if (
			["expired", "canceled", "cancelled", "denied", "rejected"].includes(status)
		) {
			throw new Error("OpenDesign device authorization expired or was denied.");
		}
		if (status === "pending") continue;
		if (status && status !== "approved") {
			throw new Error("OpenDesign returned an unknown authorization status.");
		}
		const user =
			body.user && typeof body.user === "object" && !Array.isArray(body.user)
				? (body.user as Record<string, unknown>)
				: {};
		const controlKey = asString(body.controlKey) ?? asString(user.controlKey);
		if (!controlKey || !/^vela_ctrl_[!-~]+$/.test(controlKey)) {
			throw new Error("OpenDesign authorization did not return a control key.");
		}
		return { controlKey };
	}
	throw new Error("OpenDesign authorization code expired; run /opendesign-login again.");
}

/** 保存 control key 到 Pi 自己的配置文件（0600），保留其它已有设置。 */
export function saveOpenDesignControlKey(controlKey: string): void {
	if (!/^vela_ctrl_[!-~]+$/.test(controlKey)) {
		throw new Error("Refusing to save an invalid OpenDesign control key.");
	}
	const file = usageConfigPath();
	let current: Record<string, unknown> = {};
	if (existsSync(file)) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(file, "utf8"));
		} catch {
			throw new Error(
				`${file} is not valid JSON; fix or remove it before signing in.`,
			);
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error(
				`${file} must contain a JSON object; fix or remove it before signing in.`,
			);
		}
		current = parsed as Record<string, unknown>;
	}
	writeFileSync(
		file,
		`${JSON.stringify({ ...current, opendesignControlKey: controlKey }, null, 2)}\n`,
		{ mode: 0o600 },
	);
}

/** 删除 Pi 配置中保存的 control key，保留其它设置。 */
export function removeOpenDesignControlKey(): void {
	const file = usageConfigPath();
	if (!existsSync(file)) return;
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(file, "utf8"));
	} catch {
		throw new Error(`${file} is not valid JSON; fix or remove it.`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`${file} must contain a JSON object; fix or remove it.`);
	}
	const next = { ...(parsed as Record<string, unknown>) };
	delete next.opendesignControlKey;
	writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("aborted"));
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", abort);
			resolve();
		}, Math.max(1, ms));
		const abort = () => {
			clearTimeout(timer);
			reject(new Error("aborted"));
		};
		signal?.addEventListener("abort", abort, { once: true });
	});
}

async function readJsonObject(response: Response): Promise<Record<string, unknown>> {
	const declared = Number(response.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
		throw new Error("OpenDesign authorization response exceeded the size limit.");
	}
	const text = await response.text();
	if (text.length > MAX_BODY_BYTES) {
		throw new Error("OpenDesign authorization response exceeded the size limit.");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error("OpenDesign authorization returned invalid JSON.");
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("OpenDesign authorization returned an invalid JSON object.");
	}
	return parsed as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

// Copy-paste HTTP client (~130 lines). Upstash Redis–compatible API for lmdis.
// Not published to npm — vendor this file into your project.

export type LmdisClientConfig = {
	url: string;
	token: string;
	fetch?: typeof fetch;
};

export type SetCommandOptions = {
	ex?: number;
	px?: number;
	exat?: number;
	pxat?: number;
	keepTtl?: boolean;
	get?: boolean;
	nx?: boolean;
	xx?: boolean;
};

export class LmdisError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LmdisError";
	}
}

const serialize = (value: unknown): string => {
	switch (typeof value) {
		case "string":
			return value;
		case "number":
		case "boolean":
			return String(value);
		default:
			return JSON.stringify(value);
	}
};

const deserialize = <T>(value: string | null): T | null => {
	if (value === null) return null;
	try {
		return JSON.parse(value) as T;
	} catch {
		return value as T;
	}
};

const unsupportedSetOptions = (opts?: SetCommandOptions): string | null => {
	if (!opts) return null;
	if (opts.get) return "get";
	if (opts.nx) return "nx";
	if (opts.xx) return "xx";
	return null;
};

const buildSetBody = (
	key: string,
	value: string,
	opts?: SetCommandOptions,
): unknown[] => {
	const body: unknown[] = ["SET", key, value];
	const ttlOpts = [
		opts?.ex !== undefined ? "ex" : null,
		opts?.px !== undefined ? "px" : null,
		opts?.exat !== undefined ? "exat" : null,
		opts?.pxat !== undefined ? "pxat" : null,
		opts?.keepTtl ? "keepTtl" : null,
	].filter(Boolean);
	if (ttlOpts.length > 1) {
		throw new LmdisError("SET TTL options are mutually exclusive");
	}
	if (opts?.ex !== undefined) body.push("EX", opts.ex);
	else if (opts?.px !== undefined) body.push("PX", opts.px);
	else if (opts?.exat !== undefined) body.push("EXAT", opts.exat);
	else if (opts?.pxat !== undefined) body.push("PXAT", opts.pxat);
	else if (opts?.keepTtl) body.push("KEEPTTL");
	return body;
};

export class LmdisClient {
	private readonly baseUrl: string;
	private readonly headers: Record<string, string>;
	private readonly fetchFn: typeof fetch;

	constructor(config: LmdisClientConfig) {
		this.baseUrl = config.url.replace(/\/$/, "");
		this.headers = {
			Authorization: `Bearer ${config.token}`,
			"Content-Type": "application/json",
		};
		this.fetchFn = config.fetch ?? fetch;
	}

	private async request<T>(body: unknown[]): Promise<T> {
		const res = await this.fetchFn(this.baseUrl, {
			method: "POST",
			headers: this.headers,
			body: JSON.stringify(body),
		});
		const data = (await res.json()) as {
			result?: T;
			error?: string;
			code?: string;
		};
		if (!res.ok) {
			throw new LmdisError(
				data.error ?? `request failed with status ${res.status}`,
			);
		}
		if (data.result === undefined) {
			throw new LmdisError("request did not return a result");
		}
		return data.result;
	}

	async set<T>(
		key: string,
		value: T,
		opts?: SetCommandOptions,
	): Promise<"OK" | null> {
		const unsupported = unsupportedSetOptions(opts);
		if (unsupported) {
			throw new LmdisError(
				`SET option "${unsupported}" is not supported by lmdis`,
			);
		}
		await this.request<"OK">(buildSetBody(key, serialize(value), opts));
		return "OK";
	}

	async get<T>(key: string): Promise<T | null> {
		const result = await this.request<string | null>(["GET", key]);
		return deserialize<T>(result);
	}

	async del(...keys: string[]): Promise<number> {
		let removed = 0;
		for (const key of keys) {
			removed += await this.request<number>(["DEL", key]);
		}
		return removed;
	}

	async hincrby(
		key: string,
		field: string,
		increment: number,
	): Promise<number> {
		return this.request<number>(["HINCR", key, field, String(increment)]);
	}

	async sadd(key: string, ...members: (string | number)[]): Promise<number> {
		let added = 0;
		for (const member of members) {
			added += await this.request<number>(["SADD", key, serialize(member)]);
		}
		return added;
	}

	async smembers(key: string): Promise<string[]> {
		return this.request<string[]>(["SMEMB", key]);
	}

	async srem(key: string, ...members: (string | number)[]): Promise<number> {
		let removed = 0;
		for (const member of members) {
			removed += await this.request<number>(["SDEL", key, serialize(member)]);
		}
		return removed;
	}

	async keys(pattern?: string): Promise<string[]> {
		return this.request<string[]>(
			pattern === undefined ? ["KEYS"] : ["KEYS", pattern],
		);
	}

	async scanKeys(
		cursor: string,
		count: number,
		pattern?: string,
	): Promise<[string, string[]]> {
		const body: unknown[] = ["SCANKEYS", cursor, count];
		if (pattern !== undefined) body.push("MATCH", pattern);
		return this.request<[string, string[]]>(body);
	}
}

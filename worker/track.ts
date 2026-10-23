// Client click-through telemetry (PLAN3): validation + the Analytics
// Engine write for POST /t. Kept separate from index.ts so the allow-list
// is unit-testable without Hono.
//
// One row per user intent, nothing else (PLAN3 §1): client slug, choice
// kind (explicit pick vs auto-open), coarse device class, host. NO cast
// ids, usernames, IPs, UA strings, or identifiers of any kind — the
// negative list is the privacy design and /transparency declares it.

import { CLIENTS, findClient } from "./client-registry.ts";

/** Explicit pill click on the action row. */
export const KIND_PILL = "pill";
/** Auto-open redirect fired by the countdown/arming timer (or delay 0). */
export const KIND_AUTO = "auto";
/** Explicit open from the paused view or the countdown link. */
export const KIND_GO_NOW = "go-now";
export const EVENT_KINDS = [KIND_PILL, KIND_AUTO, KIND_GO_NOW] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

/** `native` = the click-time path attempted the app (scheme/intent). */
export const TRANSPORTS = ["web", "native"] as const;
export type Transport = (typeof TRANSPORTS)[number];

/** Coarse pointer class from the client's own matchMedia — no UA sniffing. */
export const DEVICES = ["coarse", "fine"] as const;
export type DeviceClass = (typeof DEVICES)[number];

/**
 * First-choice flag, computed client-side from the fc_client cookie
 * BEFORE the click rewrites it: `first` = no slug saved yet, `switch` =
 * differs from the saved slug, `repeat` = same slug. Auto/go-now events
 * omit it (the client is the saved slug by construction).
 */
export const FIRST_FLAGS = ["first", "switch", "repeat"] as const;
export type FirstFlag = (typeof FIRST_FLAGS)[number];

/** Maximum beacon body size — real events are ~60 bytes. */
export const MAX_BODY_BYTES = 128;

export interface TrackEvent {
	slug: string;
	kind: EventKind;
	transport: Transport;
	device: DeviceClass | "";
	first: FirstFlag | "";
}

/**
 * Parses and validates one beacon body. Anything not exactly on the
 * allow-list → null (drop): unknown slugs (including eol/suspended —
 * `findClient` only passes active ids), unknown kinds/transports/flags,
 * non-JSON, oversize. The route answers 204 either way; invalid input has
 * no observable difference from valid input.
 */
export function parseTrackEvent(raw: string): TrackEvent | null {
	if (raw.length > MAX_BODY_BYTES) return null;
	let body: unknown;
	try {
		body = JSON.parse(raw);
	} catch {
		return null;
	}
	if (body === null || typeof body !== "object") return null;
	const b = body as Record<string, unknown>;
	// Kill switch + registry whitelist: only active client ids are recorded.
	if (typeof b.c !== "string" || findClient(b.c) === undefined) return null;
	const kind = EVENT_KINDS.find((k) => k === b.k);
	if (kind === undefined) return null;
	const transport = TRANSPORTS.find((t) => t === b.t) ?? "web";
	const device = DEVICES.find((d) => d === b.d) ?? "";
	// The first-flag is only meaningful for pill clicks.
	const first =
		kind === KIND_PILL ? (FIRST_FLAGS.find((f) => f === b.f) ?? "") : "";
	return { slug: b.c, kind, transport, device, first };
}

/** Placeholder for a field that is validly absent (AE blobs are strings). */
const ABSENT = "-";

/** The AE row shape (CLICK_STATS): index = slug, blobs = detail, host last. */
export function trackBlobs(event: TrackEvent, host: string): string[] {
	return [
		`${event.kind}:${event.transport}`,
		event.device === "" ? ABSENT : event.device,
		event.first === "" ? ABSENT : event.first,
		host,
	];
}

/** Fire-and-forget AE write; callers wrap in waitUntil inside try/catch. */
export function writeTrackEvent(
	dataset: AnalyticsEngineDataset,
	event: TrackEvent,
	host: string,
): void {
	dataset.writeDataPoint({
		indexes: [event.slug],
		blobs: trackBlobs(event, host),
	});
}

/** Active client ids — the documented universe of countable slugs. */
export const TRACKABLE_IDS = CLIENTS.filter(
	(client) => client.status === undefined || client.status === "active",
).map((client) => client.id);

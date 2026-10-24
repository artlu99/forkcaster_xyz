// Warpcast channel API client — the one place that knows api.warpcast.com's
// channel route, shapes, and failure semantics (the same seat worker/shim.ts
// holds for shim). Zero dependencies beyond zod; consumers (channel landings
// today, anything channel-shaped tomorrow) import this file.
//
// The zod contract wraps the owner's hand-rolled ChannelObject types
// (bcbhshow-lite-client src/api/warpcast-types.ts — valid), extended with the
// fields verified live Oct 2026. Unknown fields are stripped (zod default),
// so API growth never breaks a render; `moderatorFid` (singular) and
// `followedAt` are kept from the hand-rolled types for fidelity — the live
// endpoint has only ever shown the plural `moderatorFids`, and `followedAt`
// is viewer-scoped data this route never carries.

import { z } from "zod";

/** Base URL of the official Warpcast API (first-party Farcaster, keyless). */
export const WARPCAST_API_BASE = "https://api.warpcast.com";

export const channelUrl = (id: string): string =>
	`${WARPCAST_API_BASE}/v1/channel?channelId=${encodeURIComponent(id)}`;

/**
 * Channel entity as returned by GET /v1/channel. Only the minimal identity
 * (id, name, imageUrl) is load-bearing for the schema; everything else is
 * optional — absent fields render nothing, never faked. `url` is the
 * channel's parent key (legacy channels carry a `chain://…` NFT-contract
 * URL) and is renamed `parentUrl` at the JSON edge to keep "the channel's
 * page URL" unambiguous. Timestamps are unix SECONDS (profile convention).
 */
export const channelObjectSchema = z.object({
	id: z.string(),
	url: z.string().optional(),
	name: z.string(),
	description: z.string().optional(),
	imageUrl: z.string(),
	leadFid: z.number().nullish(),
	moderatorFid: z.number().nullish(),
	moderatorFids: z.array(z.number()).nullish(),
	createdAt: z.number().nullish(),
	followerCount: z.number().nullish(),
	followedAt: z.number().nullish(),
	memberCount: z.number().nullish(),
	publicCasting: z.boolean().nullish(),
	headerImageUrl: z.string().nullish(),
	pinnedCastHash: z.string().nullish(),
	externalLink: z
		.object({ title: z.string(), url: z.string() })
		.nullish(),
});

const channelResponseSchema = z.object({
	result: z.object({ channel: channelObjectSchema }),
});

export type WarpcastChannel = z.infer<typeof channelObjectSchema>;

export type ChannelLookup =
	| { status: "found"; channel: WarpcastChannel }
	| { status: "miss" }
	| { status: "error"; message: string };

/**
 * GET /v1/channel?channelId={id} — a miss is the API's HTTP 400
 * `{errors:[{message:"No channel found with key …"}]}`: an authoritative
 * status-code verdict, simpler than shim's sparse-shape misses. Any other
 * non-2xx, a thrown request (timeout included), or a 200 body that fails
 * the zod parse is an error — identity has no fail-open source, same seat
 * as shim /f for profiles. Never throws.
 */
export async function getChannelById(
	id: string,
	signal: AbortSignal,
): Promise<ChannelLookup> {
	let res: Response;
	try {
		res = await fetch(channelUrl(id), { signal });
	} catch (error) {
		return { status: "error", message: String(error) };
	}
	if (res.status === 400) return { status: "miss" };
	if (!res.ok) return { status: "error", message: `HTTP ${res.status}` };
	const data = (await res.json().catch(() => undefined)) as unknown;
	const parsed = channelResponseSchema.safeParse(data);
	if (!parsed.success) {
		return { status: "error", message: "malformed channel payload" };
	}
	return { status: "found", channel: parsed.data.result.channel };
}

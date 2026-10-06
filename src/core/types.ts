/**
 * Tiers decide who a memory may reach.
 *
 * - private:  used only in the owner's own DM with Tact. Never consulted for a group.
 * - discreet: consulted for group decisions (it can veto a venue), but never stated,
 *             quoted, or attributed in a group. The default for allergies, diets,
 *             budgets and home areas.
 * - shared:   may be quoted in a group, e.g. "Minh loves spicy food".
 */
export type Tier = "private" | "discreet" | "shared";

export type Kind =
  | "allergy"
  | "diet"
  | "avoid"
  | "budget"
  | "area"
  | "availability"
  | "like"
  | "dislike"
  | "note"
  | "venue"
  | "verdict"
  | "event";

export type Channel = "web" | "telegram" | "seed" | "cli";

export interface Fact {
  kind: Kind;
  tier: Tier;
  /** Supersede key: the newest fact with the same key wins; a retraction removes it. */
  key: string;
  /** One readable sentence, written so it makes sense on its own when recalled. */
  text: string;
  attrs: Record<string, string>;
  retract?: boolean;
  /** The person's own words, short, kept for provenance. */
  quote?: string;
  source?: "dm" | "group" | "seed";
  /** Display name of the member a group-level fact came from (verdicts). */
  by?: string;
  /** ISO time the fact was learned. */
  at: string;
}

/** A fact as read back from Walrus, with its provenance. */
export interface StoredFact extends Fact {
  blobId?: string;
  /** "walrus" when it came from recall, "pending" while the write is still landing. */
  origin: "walrus" | "pending";
  createdAt?: string;
  distance?: number;
}

export type OwnerRef = { type: "member"; id: string } | { type: "group"; id: string };

export interface Member {
  id: string;
  displayName: string;
  channel: Channel;
  externalId: string;
  createdAt: string;
  demo: boolean;
}

export interface Group {
  id: string;
  name: string;
  channel: Channel;
  externalId: string;
  inviteCode: string;
  createdAt: string;
  demo: boolean;
}

export type RoomType = "group" | "dm";

export interface ChatMessage {
  id: string;
  roomType: RoomType;
  roomId: string;
  memberId: string | null;
  role: "user" | "bot";
  text: string;
  createdAt: string;
  meta?: Record<string, unknown>;
}

export interface Inbound {
  channel: Channel;
  roomType: RoomType;
  /** group id for group rooms, member id for DMs */
  roomId: string;
  memberId: string;
  text: string;
  /** Telegram: the bot was @mentioned or replied to; web: always true. */
  addressed?: boolean;
}

export interface Outbound {
  roomType: RoomType;
  roomId: string;
  text: string;
  meta?: Record<string, unknown>;
}

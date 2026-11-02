import { supabaseAdmin } from "./supabase.js";

type RealtimeNotifier = {
  sideBetChanged: (betId: string, reason: string) => Promise<void>;
  walletChanged: (userIds: string | string[], reason: string) => Promise<void>;
};

/** Diaconis, Holmes, Montgomery: caught flip lands the starting face about 51% of the time. */
export const SAME_FACE_PROBABILITY = 0.51;
/** Murray and Teare (1993): a US nickel lands on edge about 1 in 6000 tosses onto a surface. */
export const EDGE_PROBABILITY = 1 / 6000;
export const COIN_FLIP_SOURCE = "sidebets:coin-flip";
export const COIN_FLIP_BUY_IN = 1;
export const WINDOW_MS = 3 * 60 * 1000;

export type CoinFace = "heads" | "tails";
export type CoinOutcome = CoinFace | "edge";

export const COIN_OPTIONS = [
  { id: "heads", label: "Heads" },
  { id: "tails", label: "Tails" },
  { id: "edge", label: "Edge" }
];

export function currentWindow(now = Date.now()) {
  const starts = Math.floor(now / WINDOW_MS) * WINDOW_MS;
  return { startsAt: new Date(starts).toISOString(), closesAt: new Date(starts + WINDOW_MS).toISOString(), startsMs: starts };
}

export function startFaceForWindow(startsMs: number): CoinFace {
  return Math.floor(startsMs / 1000) % 2 === 0 ? "heads" : "tails";
}

/**
 * Edge is drawn first (1/6000). The remaining probability is split 0.51 / 0.49
 * toward the face that was up when the toss started (Diaconis et al.).
 */
export function sampleCoinOutcome(startFace: CoinFace, random = Math.random): CoinOutcome {
  const roll = random();
  if (roll < EDGE_PROBABILITY) return "edge";
  const withinFaces = (roll - EDGE_PROBABILITY) / (1 - EDGE_PROBABILITY);
  if (withinFaces < SAME_FACE_PROBABILITY) return startFace;
  return startFace === "heads" ? "tails" : "heads";
}

type FlipRow = {
  id: string;
  status: string;
  starts_at: string;
  closes_at: string;
  winning_option_id: string | null;
  options: { id: string; label: string }[];
};

async function findWindowBet(startsAt: string) {
  const { data, error } = await supabaseAdmin
    .from("side_bets")
    .select("id, status, starts_at, closes_at, winning_option_id, options")
    .eq("source_url", COIN_FLIP_SOURCE)
    .eq("starts_at", startsAt)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data as FlipRow | null;
}

export async function getCoinFlipState(userId: string) {
  const window = currentWindow();
  const startFace = startFaceForWindow(window.startsMs);
  const bet = await findWindowBet(window.startsAt);
  let counts = { heads: 0, tails: 0, edge: 0 };
  let myOption: string | null = null;

  if (bet) {
    const { data: entries, error } = await supabaseAdmin
      .from("bet_entries")
      .select("user_id, option_id")
      .eq("side_bet_id", bet.id);
    if (error) throw new Error(error.message);
    for (const entry of entries ?? []) {
      const option = entry.option_id as CoinOutcome;
      if (option === "heads" || option === "tails" || option === "edge") {
        counts[option] += 1;
      }
      if (entry.user_id === userId) myOption = entry.option_id;
    }
  }

  return {
    buyInCredits: COIN_FLIP_BUY_IN,
    startsAt: window.startsAt,
    closesAt: window.closesAt,
    startFace,
    sideBetId: bet?.id ?? null,
    status: bet?.status ?? "awaiting-stakes",
    winningOptionId: bet?.winning_option_id ?? null,
    counts,
    myOption,
    model: {
      sameFaceProbability: SAME_FACE_PROBABILITY,
      edgeProbability: EDGE_PROBABILITY,
      note: "Same-face bias from Diaconis, Holmes, and Montgomery. Edge rate from Murray and Teare for a nickel landing on a surface."
    }
  };
}

export async function stakeCoinFlip(userId: string, optionId: CoinOutcome, realtime: RealtimeNotifier) {
  if (optionId !== "heads" && optionId !== "tails" && optionId !== "edge") {
    throw new Error("Pick heads, tails, or edge");
  }

  const window = currentWindow();
    if (Date.now() >= new Date(window.closesAt).getTime() - 10_000) {
      throw new Error("Bets are locked for the last 10 seconds");
    }

  let bet = await findWindowBet(window.startsAt);
  if (bet && bet.status !== "open") {
    throw new Error("This flip is already settled");
  }

  if (!bet) {
    const startFace = startFaceForWindow(window.startsMs);
    const label = new Date(window.startsMs).toISOString().slice(11, 16);
    const { data, error } = await supabaseAdmin
      .from("side_bets")
      .insert({
        manager_id: userId,
        title: `Coin flip ${label} UTC`,
        description: `Live coin flip. Starts ${startFace}. Same face ${(SAME_FACE_PROBABILITY * 100).toFixed(0)}% of non-edge landings. Edge about 1 in ${Math.round(1 / EDGE_PROBABILITY)}.`,
        source_url: COIN_FLIP_SOURCE,
        buy_in_credits: COIN_FLIP_BUY_IN,
        house_fee_percent: 0,
        starts_at: window.startsAt,
        closes_at: window.closesAt,
        options: COIN_OPTIONS
      })
      .select("id, status, starts_at, closes_at, winning_option_id, options")
      .single();

    if (error) {
      bet = await findWindowBet(window.startsAt);
      if (!bet) throw new Error(error.message);
    } else {
      bet = data as FlipRow;
      await realtime.sideBetChanged(bet.id, "created");
    }
  }

  const { data: existing } = await supabaseAdmin
    .from("bet_entries")
    .select("id, option_id")
    .eq("side_bet_id", bet.id)
    .eq("user_id", userId)
    .maybeSingle();

  if (existing) {
    if (existing.option_id !== optionId) {
      const { error } = await supabaseAdmin.from("bet_entries").update({ option_id: optionId }).eq("id", existing.id);
      if (error) throw new Error(error.message);
      await realtime.sideBetChanged(bet.id, "entry-changed");
    }
    return getCoinFlipState(userId);
  }

  const { data: profile, error: profileError } = await supabaseAdmin
    .from("profiles")
    .select("credits_balance")
    .eq("id", userId)
    .single();
  if (profileError || !profile) throw new Error("Profile not found");
  if (Number(profile.credits_balance) < COIN_FLIP_BUY_IN) throw new Error("Not enough credits");

  const { error: entryError } = await supabaseAdmin.from("bet_entries").insert({
    side_bet_id: bet.id,
    user_id: userId,
    option_id: optionId,
    stake_credits: COIN_FLIP_BUY_IN
  });
  if (entryError) throw new Error(entryError.message);

  await supabaseAdmin
    .from("profiles")
    .update({ credits_balance: Number(profile.credits_balance) - COIN_FLIP_BUY_IN })
    .eq("id", userId);
  await supabaseAdmin.from("credit_transactions").insert({
    user_id: userId,
    amount_credits: -COIN_FLIP_BUY_IN,
    kind: "buy_in",
    description: `Buy-in for coin flip`,
    side_bet_id: bet.id,
    created_by: userId
  });

  await realtime.sideBetChanged(bet.id, "joined");
  await realtime.walletChanged(userId, "buy-in");
  return getCoinFlipState(userId);
}

export async function settleDueCoinFlips(realtime: RealtimeNotifier) {
  const now = new Date().toISOString();
  const { data: due, error } = await supabaseAdmin
    .from("side_bets")
    .select("id, starts_at, status")
    .eq("source_url", COIN_FLIP_SOURCE)
    .eq("status", "open")
    .lte("closes_at", now);
  if (error || !due) return;

  for (const row of due) {
    const startsMs = new Date(row.starts_at).getTime();
    const startFace = startFaceForWindow(startsMs);
    const winningOptionId = sampleCoinOutcome(startFace);
    const { data: entries } = await supabaseAdmin.from("bet_entries").select("*").eq("side_bet_id", row.id);
    const list = entries ?? [];
    if (list.length === 0) {
      await supabaseAdmin.from("side_bets").delete().eq("id", row.id).eq("status", "open");
      continue;
    }

    const winners = list.filter((entry) => entry.option_id === winningOptionId);
    const pot = list.reduce((total, entry) => total + Number(entry.stake_credits), 0);
    const payout = winners.length > 0 ? pot / winners.length : 0;

    for (const winner of winners) {
      const { data: profile } = await supabaseAdmin.from("profiles").select("credits_balance").eq("id", winner.user_id).single();
      if (!profile) continue;
      await supabaseAdmin
        .from("profiles")
        .update({ credits_balance: Number(profile.credits_balance) + payout })
        .eq("id", winner.user_id);
      await supabaseAdmin.from("credit_transactions").insert({
        user_id: winner.user_id,
        amount_credits: payout,
        kind: "payout",
        description: `Coin flip payout (${winningOptionId})`,
        side_bet_id: row.id,
        created_by: winner.user_id
      });
    }

    await supabaseAdmin
      .from("side_bets")
      .update({
        status: "settled",
        winning_option_id: winningOptionId,
        settles_at: new Date().toISOString()
      })
      .eq("id", row.id)
      .eq("status", "open");

    await realtime.sideBetChanged(row.id, "settled");
    await realtime.walletChanged(
      winners.map((winner) => winner.user_id),
      "settlement"
    );
  }
}

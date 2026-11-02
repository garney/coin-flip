import type { CoinFlipState } from "../api";
import type { CoinPhase, Face } from "./motion";

export const LOCK_MS = 10_000;
/** How long after the close a landed result stays up before the coin flips over to the next starting face. */
export const SHOW_RESULT_MS = 12_000;
/** Give up waiting for a settlement after this long and bring the coin down. */
export const MAX_WAIT_MS = 15_000;

/**
 * Decides what the coin should be doing.
 * Bets lock with 10 seconds left: the coin waits while the camera pulls back.
 * The server reveals the result when bets lock, so at the close the coin is
 * flicked straight away (the flick is simulated to land on it). Against an
 * older server without `result` it waits for the settlement instead. When the
 * window rolls over, the server reports the closed window as `previous`; once
 * it has a result the coin falls onto it and stays there until the next toss.
 */
export function coinPhase(
  state: CoinFlipState | null,
  previous: CoinFlipState["previous"] | null,
  closesIn: number,
  now: number
): {
  phase: CoinPhase;
  /** Caption while this phase plays. */
  phaseCaption: string | null;
  /** Caption once the coin has landed. Kept separate so it never gives the result away mid-air. */
  resultCaption: string | null;
} {
  if (!state) return { phase: { kind: "rest", face: "heads" }, phaseCaption: null, resultCaption: null };

  if (closesIn <= 0) {
    if (state.result) {
      return {
        phase: { kind: "land", id: state.startsAt, face: state.result, startFace: state.startFace },
        phaseCaption: "Flipping…",
        resultCaption: landedCaption(state.result, Boolean(state.sideBetId))
      };
    }
    return { phase: { kind: "wait", id: state.startsAt, face: state.startFace }, phaseCaption: "Flipping…", resultCaption: null };
  }
  if (closesIn <= LOCK_MS) {
    return { phase: { kind: "lock", id: state.startsAt, face: state.startFace }, phaseCaption: `Bets locked. Starts ${state.startFace} up.`, resultCaption: null };
  }

  if (previous) {
    const closedAt = new Date(previous.closesAt).getTime();
    // When the window that just closed is the one before this one, the close has
    // happened even if this clock still reads a little earlier (it ticks every
    // 200ms and can lag the server). Without this the coin briefly "rests" on
    // the next round's face and flips over before the real toss.
    const justClosed = closedAt === new Date(state.startsAt).getTime();
    const sinceClose = justClosed ? Math.max(0, now - closedAt) : now - closedAt;
    if (sinceClose >= 0 && sinceClose < Math.max(SHOW_RESULT_MS, MAX_WAIT_MS)) {
      const staked = Boolean(previous.sideBetId);
      const face = previous.winningOptionId ?? previous.result ?? (staked ? null : previewFace(previous.startsAt, previous.startFace));
      if (face && sinceClose < SHOW_RESULT_MS) {
        return {
          phase: { kind: "land", id: previous.startsAt, face, startFace: previous.startFace },
          phaseCaption: "Flipping…",
          resultCaption: landedCaption(face, staked)
        };
      }
      if (!face && sinceClose < MAX_WAIT_MS) {
        return { phase: { kind: "wait", id: previous.startsAt, face: previous.startFace }, phaseCaption: "Flipping…", resultCaption: null };
      }
    }
  }

  return { phase: { kind: "rest", face: state.startFace }, phaseCaption: null, resultCaption: null };
}

function landedCaption(face: Face, staked: boolean) {
  return staked ? `Landed on ${face}.` : `No stakes. Landed on ${face}, nothing recorded.`;
}

/** Fallback for an older server without `result`: unstaked windows still get a show, the same for every viewer. */
export function previewFace(key: string, startFace: Face): Face {
  let h = 2166136261;
  for (let i = 0; i < key.length; i += 1) h = Math.imul(h ^ key.charCodeAt(i), 16777619) >>> 0;
  const roll = h / 4294967296;
  if (roll < 1 / 6000) return "edge";
  if (roll < 0.51) return startFace;
  return startFace === "heads" ? "tails" : "heads";
}

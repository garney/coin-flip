import { useEffect, useRef, useState } from "react";
import type { PublicTable } from "../../../../shared/types";

import { DEAL_ANIM_MS } from "../cardAssets";

function dealerCardDelay(index: number) {
  return index * 120;
}

function playerCardDelay(seatIndex: number, cardIndex: number) {
  return 220 + seatIndex * 60 + cardIndex * 140;
}

export function handValueFromCards(cards: Array<{ rank: number; suit: string }>): number | null {
  const live = cards.filter((c) => c.suit !== "hidden" && c.rank > 0);
  if (live.length === 0) return null;
  let total = 0;
  let aces = 0;
  for (const card of live) {
    if (card.rank === 11) {
      aces += 1;
      total += 11;
    } else if (card.rank >= 10) {
      total += 10;
    } else {
      total += card.rank;
    }
  }
  while (total > 21 && aces > 0) {
    total -= 10;
    aces -= 1;
  }
  return total;
}

/** Tracks when each card's deal animation has finished so totals stay hidden until then. */
export function useCardReveal(table: PublicTable) {
  const [revealed, setRevealed] = useState<Set<string>>(() => new Set());
  const roundRef = useRef(table.round);
  const handSig = `${table.dealerHand.length}:${table.seats.map((s) => `${s.userId}:${s.hand.length}`).join(",")}`;

  useEffect(() => {
    if (table.round !== roundRef.current) {
      roundRef.current = table.round;
      setRevealed(new Set());
    }
  }, [table.round]);

  useEffect(() => {
    const timers: number[] = [];

    if (table.phase === "betting" || table.phase === "open") {
      const all = new Set<string>();
      table.dealerHand.forEach((_, i) => all.add(`d:${i}`));
      for (const seat of table.seats) {
        seat.hand.forEach((_, i) => all.add(`p:${seat.userId}:${i}`));
      }
      setRevealed(all);
      return;
    }

    const schedule = (key: string, delayMs: number) => {
      const id = window.setTimeout(() => {
        setRevealed((prev) => {
          if (prev.has(key)) return prev;
          const next = new Set(prev);
          next.add(key);
          return next;
        });
      }, delayMs + DEAL_ANIM_MS);
      timers.push(id);
    };

    table.dealerHand.forEach((_, i) => schedule(`d:${i}`, dealerCardDelay(i)));
    for (const seat of table.seats) {
      seat.hand.forEach((_, i) => schedule(`p:${seat.userId}:${i}`, playerCardDelay(seat.seatIndex, i)));
    }

    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [table.phase, table.round, handSig]);

  function isDealerCardRevealed(i: number) {
    return revealed.has(`d:${i}`);
  }

  function isPlayerCardRevealed(userId: string, i: number) {
    return revealed.has(`p:${userId}:${i}`);
  }

  function playerHandTotal(userId: string, hand: PublicTable["seats"][0]["hand"]): number | null {
    if (hand.length === 0) return null;
    for (let i = 0; i < hand.length; i += 1) {
      if (!isPlayerCardRevealed(userId, i)) return null;
    }
    return handValueFromCards(hand);
  }

  function dealerDisplayTotal(holeHidden: boolean, flipHole: boolean): number | null {
    if (table.dealerHand.length === 0) return null;
    if (holeHidden && !flipHole) {
      if (!isDealerCardRevealed(0) || (table.dealerHand.length > 1 && !isDealerCardRevealed(1))) return null;
      return handValueFromCards([table.dealerHand[0]]);
    }
    for (let i = 0; i < table.dealerHand.length; i += 1) {
      if (!isDealerCardRevealed(i)) return null;
    }
    const cards =
      holeHidden && !flipHole
        ? [table.dealerHand[0]]
        : table.dealerHand.filter((c) => c.suit !== "hidden");
    return handValueFromCards(cards);
  }

  return {
    isDealerCardRevealed,
    isPlayerCardRevealed,
    playerHandTotal,
    dealerDisplayTotal
  };
}

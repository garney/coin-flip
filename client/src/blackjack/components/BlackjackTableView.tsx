import { useEffect, useMemo, useRef, useState } from "react";
import type { Profile, PublicTable } from "../../../../shared/types";
import { PlayingCard } from "./PlayingCard";
import { cardKey } from "../cardUtils";
import { betError } from "../session";
import { useCardReveal } from "./useCardReveal";

const CHIP_VALUES = [1, 5, 20, 50, 100];

type Props = {
  table: PublicTable;
  profile: Profile;
  betAmount: string;
  setBetAmount: (v: string) => void;
  busy: boolean;
  socketReady: boolean;
  onBet: () => void;
  onHit: () => void;
  onStand: () => void;
  onDeal: () => void;
  onStartBetting: () => void;
  onEndTable: () => void;
};

function secondsLeft(deadline: number | null, now: number) {
  if (deadline == null) return null;
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}

function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}

function seatStatus(seat: PublicTable["seats"][number], active: boolean) {
  if (active) return "Your turn";
  if (seat.status === "stood") return "standing";
  if (seat.status === "bust") return "bust";
  if (seat.status === "blackjack") return "blackjack";
  if (seat.status === "acting") return "playing";
  if (seat.bet > 0) return "bet in";
  return "seated";
}

export function BlackjackTableView({
  table,
  profile,
  betAmount,
  setBetAmount,
  busy,
  socketReady,
  onBet,
  onHit,
  onStand,
  onDeal,
  onStartBetting,
  onEndTable
}: Props) {
  const mySeat = table.seats.find((s) => s.userId === profile.id);
  const isHost = table.dealerUserId === profile.id;
  const holeHidden = table.dealerHand.some((c) => c.suit === "hidden");
  const [flipHole, setFlipHole] = useState(false);
  const reveal = useCardReveal(table);

  useEffect(() => {
    if (!holeHidden && table.dealerHand.length >= 2) {
      const t = window.setTimeout(() => setFlipHole(true), 200);
      return () => window.clearTimeout(t);
    }
    setFlipHole(false);
  }, [holeHidden, table.dealerHand.length, table.round]);

  const waiting =
    table.dealStartsAt != null || table.turnEndsAt != null || table.seats.some((seat) => seat.idleEndsAt != null);
  const now = useNow(waiting);
  const dealIn = secondsLeft(table.dealStartsAt, now);
  const turnIn = secondsLeft(table.turnEndsAt, now);
  const myIdleIn = secondsLeft(mySeat?.idleEndsAt ?? null, now);
  const dealerTotalLabel = reveal.dealerDisplayTotal(holeHidden, flipHole);
  const myTurn = Boolean(mySeat && mySeat.status === "acting" && table.activeSeatIndex === mySeat.seatIndex);
  const myResult = table.lastRoundResults?.find((result) => result.userId === profile.id);
  const resultCopy =
    myResult?.outcome === "blackjack"
      ? `Blackjack. You won ${myResult.net}.`
      : myResult?.outcome === "win"
        ? `You won ${myResult.net}.`
        : myResult?.outcome === "push"
          ? "Push. Your bet is back."
          : myResult?.outcome === "bust"
            ? `Bust. You lost ${Math.abs(myResult.net)}.`
            : myResult?.outcome === "lose"
              ? `You lost ${Math.abs(myResult.net)}.`
              : null;
  const canBet = Boolean(!isHost && mySeat && table.phase === "betting" && mySeat.bet <= 0);
  const amount = Number(betAmount);
  const invalidBet = betError(amount, table.minBet, table.maxBet);
  const chips = CHIP_VALUES.filter((value) => value >= table.minBet && value <= table.maxBet);
  const spotRef = useRef<HTMLSpanElement | null>(null);
  const [flyer, setFlyer] = useState<{ amount: number; left: number; top: number; dx: number; dy: number; go: boolean } | null>(null);

  const seatSlots = useMemo(() => {
    const slots = Array.from({ length: table.maxSeats }, () => null as (typeof table.seats)[0] | null);
    for (const seat of table.seats) slots[seat.seatIndex] = seat;
    return slots;
  }, [table.seats, table.maxSeats]);

  const phaseLabel =
    table.phase === "playing" ? "Live" : table.phase === "dealer" ? "Dealer turn" : table.phase === "betting" ? "Betting" : table.phase;

  return (
    <section className="felt-stage" aria-label={`${table.title} blackjack table`}>
      <div className="felt-status">
        <span className="live-dot" aria-hidden />
        <span>
          {phaseLabel} · Round {table.round}
          {table.mode === "live" && table.dealerBankroll != null ? ` · bankroll ${table.dealerBankroll}` : ""}
          {table.mode === "practice" && mySeat ? ` · ${mySeat.practiceChips ?? 0} practice chips` : ""}
        </span>
        {dealIn != null ? <span>Dealing in {dealIn}s</span> : null}
        {turnIn != null ? (
          <span className={turnIn <= 10 ? "action-timer urgent" : "action-timer"} role="timer">
            {turnIn}s
          </span>
        ) : null}
        {myIdleIn != null && mySeat && mySeat.bet <= 0 ? <span>Bet within {myIdleIn}s</span> : null}
      </div>

      <div className="dealer-stage">
        <p className="dealer-name">Dealer · {table.dealerName}</p>
        <p className="dealer-total">{dealerTotalLabel != null ? `Showing ${dealerTotalLabel}` : table.phase === "betting" ? "Waiting for bets" : "Waiting for deal"}</p>
        <div className="card-row center">
          {table.dealerHand.length === 0
            ? [0, 1].map((i) => <span key={i} className="card-ghost" aria-hidden />)
            : table.dealerHand.map((card, i) => {
                const facedown = card.suit === "hidden" || (i === 1 && holeHidden && !flipHole);
                return (
                  <PlayingCard
                    key={cardKey(card, i, "dealer")}
                    suit={facedown ? "hidden" : card.suit}
                    rank={facedown ? 0 : card.rank}
                    faceDown={facedown}
                    dealDelayMs={i * 120}
                  />
                );
              })}
        </div>
      </div>

      <div className="seat-rail">
        {seatSlots.map((seat, slot) => {
          const mine = seat?.userId === profile.id;
          const active = Boolean(seat && table.activeSeatIndex === seat.seatIndex && seat.status === "acting");
          const total = seat ? reveal.playerHandTotal(seat.userId, seat.hand) : null;
          return (
            <article key={slot} className={`seat ${mine ? "mine" : ""} ${active ? "active" : ""} ${seat ? "taken" : "open"}`}>
              {seat ? (
                <>
                  <div className="card-row compact">
                    {seat.hand.map((card, i) => (
                      <PlayingCard
                        key={cardKey(card, i, seat.userId)}
                        suit={card.suit}
                        rank={card.rank}
                        small={!mine}
                        dealDelayMs={220 + seat.seatIndex * 60 + i * 140}
                      />
                    ))}
                  </div>
                  {mine ? (
                    <span ref={spotRef} className="chip-spot">
                      {seat.bet > 0 && !flyer ? <span className="table-chip">{seat.bet}</span> : null}
                    </span>
                  ) : seat.bet > 0 ? (
                    <span className="table-chip">{seat.bet}</span>
                  ) : null}
                  <strong>
                    {mine ? "You" : seat.displayName}
                    {total != null ? ` · ${total}` : ""}
                  </strong>
                  <span className={active ? "turn-pill" : "seat-meta"}>
                    {active ? "Your turn" : seatStatus(seat, false)}
                    {table.mode === "practice" && seat.practiceChips != null ? ` · ${seat.practiceChips} chips` : ""}
                  </span>
                </>
              ) : (
                <span>Open seat</span>
              )}
            </article>
          );
        })}
      </div>
      <p className="open-seats-note">
        {seatSlots.filter((seat) => !seat).length} open {seatSlots.filter((seat) => !seat).length === 1 ? "seat" : "seats"}
      </p>

      <div className="table-cta">
      {resultCopy && table.phase === "betting" ? (
        <p className={`round-result ${myResult?.net && myResult.net > 0 ? "win" : myResult?.net === 0 ? "push" : "lose"}`} role="status">
          {resultCopy} Place your next bet.
        </p>
      ) : null}

      {canBet ? (
        <form
          className="bet-dock"
            onSubmit={(event) => {
              event.preventDefault();
              if (invalidBet) return;
              const from = (event.currentTarget.querySelector(".chip.selected") as HTMLElement | null)?.getBoundingClientRect();
              const to = spotRef.current?.getBoundingClientRect();
              if (from && to) {
                const next = { amount, left: from.left, top: from.top, dx: to.left - from.left, dy: to.top - from.top, go: false };
                setFlyer(next);
                window.setTimeout(() => setFlyer({ ...next, go: true }), 30);
                window.setTimeout(() => setFlyer(null), 820);
              }
              onBet();
            }}
        >
          <div className="chip-row" role="group" aria-label="Quick bets">
            {chips.map((value) => (
              <button
                key={value}
                type="button"
                className={`chip v${value}${amount === value ? " selected" : ""}`}
                aria-pressed={amount === value}
                onClick={() => setBetAmount(String(value))}
              >
                {value}
              </button>
            ))}
            <label className="custom-bet">
              Custom
              <input
                value={betAmount}
                onChange={(event) => setBetAmount(event.target.value)}
                type="number"
                min={table.minBet}
                max={table.maxBet}
                inputMode="numeric"
                aria-invalid={Boolean(invalidBet)}
              />
            </label>
          </div>
          <p className={invalidBet ? "bet-note bad" : "bet-note"}>
            {invalidBet ?? `Table limits ${table.minBet}–${table.maxBet}`}
          </p>
          <button type="submit" className="confirm-bet" disabled={!socketReady || busy || Boolean(invalidBet)}>
            Confirm bet {Number.isFinite(amount) && amount > 0 ? amount : ""}
          </button>
        </form>
      ) : null}

      {flyer ? (
        <span
          className={`chip flyer v${CHIP_VALUES.includes(flyer.amount) ? flyer.amount : 5}`}
          style={{
            left: flyer.left,
            top: flyer.top,
            transform: flyer.go ? `translate(${flyer.dx}px, ${flyer.dy}px) scale(0.72)` : "translate(0, 0)"
          }}
        >
          {flyer.amount}
        </span>
      ) : null}

      {myTurn ? (
        <div className="action-dock" role="group" aria-label="Your turn">
          <button type="button" disabled={!socketReady || busy} onClick={onHit}>
            Hit
          </button>
          <button type="button" disabled={!socketReady || busy} onClick={onStand}>
            Stand
          </button>
          <button type="button" disabled title="This table does not offer double">
            Double
          </button>
          <button type="button" disabled title="This table does not offer split">
            Split
          </button>
        </div>
      ) : null}

      {isHost && table.mode === "live" ? (
        <div className="host-dock">
          {table.phase === "betting" && table.seats.some((s) => s.bet > 0) ? (
            <button type="button" disabled={!socketReady || busy} onClick={onDeal}>
              Deal now
            </button>
          ) : null}
          <button type="button" className="quiet" disabled={!socketReady || busy} onClick={onEndTable}>
            Close table
          </button>
        </div>
      ) : null}
      {isHost && table.mode !== "live" && table.phase === "open" ? (
        <div className="host-dock">
          <button type="button" disabled={!socketReady || busy} onClick={onStartBetting}>
            Open betting
          </button>
        </div>
      ) : null}
      {isHost && table.mode !== "live" && table.phase === "betting" ? (
        <div className="host-dock">
          <button type="button" disabled={!socketReady || busy} onClick={onDeal}>
            Deal
          </button>
        </div>
      ) : null}
      </div>
    </section>
  );
}

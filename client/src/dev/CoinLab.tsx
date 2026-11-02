import { Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
import type { CoinFlipState } from "../api";
import { CoinFlipPanel } from "../CoinFlipModal";
import { unlockAudio } from "../coin/audio";
import type { CoinPhase, Face } from "../coin/motion";
import { LOCK_MS, coinPhase } from "../coin/phase";

/**
 * Dev-only test bench for the coin. Served at /dev/coin/ by the Vite dev
 * server; it is not part of the production build.
 *
 * The top half drives the real CoinFlipPanel with a fake clock and fake
 * server, so the countdown, lock, rollover and settlement logic run exactly
 * as they do live, just on demand. The bottom half sets scene phases directly.
 */

const CoinScene = lazy(() => import("../coin/CoinScene"));

type ResultChoice = "heads" | "tails" | "edge" | "odds" | "no-stakes";
type StartChoice = "alternate" | "heads" | "tails";

type Round = {
  startsAt: number;
  closesAt: number;
  startFace: "heads" | "tails";
  /** Drawn when bets lock, like the server. */
  result?: Face;
};
type Previous = NonNullable<CoinFlipState["previous"]>;

const iso = (ms: number) => new Date(ms).toISOString();

/** Same rule as the server: edge 1/6000, then 51% for the face that started up. */
function serverOdds(startFace: "heads" | "tails"): Face {
  const roll = Math.random();
  if (roll < 1 / 6000) return "edge";
  if ((roll - 1 / 6000) / (1 - 1 / 6000) < 0.51) return startFace;
  return startFace === "heads" ? "tails" : "heads";
}

export function CoinLab() {
  const [roundSeconds, setRoundSeconds] = useState(20);
  const [result, setResult] = useState<ResultChoice>("odds");
  const [settleMs, setSettleMs] = useState(1200);
  const [neverSettle, setNeverSettle] = useState(false);
  const [noEarlyResult, setNoEarlyResult] = useState(false);
  const [autoLoop, setAutoLoop] = useState(false);
  const [startChoice, setStartChoice] = useState<StartChoice>("alternate");

  const [round, setRound] = useState<Round>(() => {
    const now = Date.now();
    return { startsAt: now, closesAt: now + 20_000, startFace: "heads" };
  });
  const [previous, setPrevious] = useState<Previous | null>(null);
  const [counts, setCounts] = useState({ heads: 0, tails: 0, edge: 0 });
  const [myOption, setMyOption] = useState<Face | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [log, setLog] = useState<string[]>([]);

  // Settings read inside timers.
  const settings = useRef({ roundSeconds, result, settleMs, neverSettle, noEarlyResult, autoLoop, startChoice });
  settings.current = { roundSeconds, result, settleMs, neverSettle, noEarlyResult, autoLoop, startChoice };
  const roundRef = useRef(round);
  roundRef.current = round;
  const settleTimer = useRef<number | null>(null);

  const note = useCallback((line: string) => {
    const stamp = new Date().toLocaleTimeString([], { hour12: false });
    setLog((lines) => [`${stamp}  ${line}`, ...lines].slice(0, 14));
  }, []);

  const nextFace = (after: "heads" | "tails"): "heads" | "tails" => {
    const choice = settings.current.startChoice;
    if (choice !== "alternate") return choice;
    return after === "heads" ? "tails" : "heads";
  };

  const startRound = (seconds: number, startFace?: "heads" | "tails") => {
    const at = Date.now();
    const face = startFace ?? nextFace(roundRef.current.startFace);
    setRound({ startsAt: at, closesAt: at + seconds * 1000, startFace: face });
    setCounts({ heads: 0, tails: 0, edge: 0 });
    setMyOption(null);
    note(`New round, ${seconds}s, starts ${face} up`);
  };

  // The fake server: roll over when the window closes, then settle after the delay.
  useEffect(() => {
    const timer = window.setInterval(() => {
      const at = Date.now();
      setNow(at);
      let current = roundRef.current;
      const s = settings.current;
      if (at >= current.closesAt - LOCK_MS && !current.result) {
        // Bets just locked: draw the result now, as the server does.
        const drawn = s.result === "odds" ? serverOdds(current.startFace) : s.result === "no-stakes" ? serverOdds(current.startFace) : s.result;
        current = { ...current, result: drawn };
        roundRef.current = current;
        setRound(current);
        note(s.noEarlyResult ? `Drew ${drawn} (kept hidden: old server)` : `Bets locked. Result ${drawn} revealed to the browser`);
      }
      if (at < current.closesAt) return;

      const staked = s.result !== "no-stakes";
      const closed: Previous = {
        startsAt: iso(current.startsAt),
        closesAt: iso(current.closesAt),
        startFace: current.startFace,
        sideBetId: staked ? `lab-${current.startsAt}` : null,
        status: staked ? "open" : "no-stakes",
        winningOptionId: null,
        result: s.noEarlyResult ? undefined : current.result
      };
      setPrevious(closed);
      const nextLength = s.autoLoop ? s.roundSeconds : 3600;
      const face = nextFace(current.startFace);
      const next = { startsAt: current.closesAt, closesAt: current.closesAt + nextLength * 1000, startFace: face };
      roundRef.current = next;
      setRound(next);
      setCounts({ heads: 0, tails: 0, edge: 0 });
      setMyOption(null);
      note(`Window closed. Next round starts ${face} up${s.autoLoop ? "" : " (paused, use the buttons)"}`);

      if (settleTimer.current) window.clearTimeout(settleTimer.current);
      if (!staked) {
        note("No stakes: the panel shows a preview flip");
        return;
      }
      if (s.neverSettle) {
        note("Settlement withheld");
        return;
      }
      settleTimer.current = window.setTimeout(() => {
        const winning = current.result ?? "heads";
        setPrevious({ ...closed, status: "settled", winningOptionId: winning });
        note(`Settled ${winning} after ${s.settleMs}ms`);
      }, s.settleMs);
    }, 100);
    return () => window.clearInterval(timer);
    // The timer reads everything through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const live: CoinFlipState = {
    buyInCredits: 1,
    startsAt: iso(round.startsAt),
    closesAt: iso(round.closesAt),
    startFace: round.startFace,
    sideBetId: counts.heads + counts.tails + counts.edge > 0 ? `lab-${round.startsAt}` : null,
    status: counts.heads + counts.tails + counts.edge > 0 ? "open" : "awaiting-stakes",
    winningOptionId: null,
    counts,
    myOption,
    result: noEarlyResult ? null : (round.result ?? null),
    previous: previous ?? undefined,
    model: { sameFaceProbability: 0.51, edgeProbability: 1 / 6000, note: "Coin lab" }
  };

  const onStake = async (optionId: Face) => {
    await new Promise((resolve) => window.setTimeout(resolve, 250));
    const nextCounts = { ...counts };
    if (myOption) nextCounts[myOption] = Math.max(0, nextCounts[myOption] - 1);
    nextCounts[optionId] += 1;
    setCounts(nextCounts);
    setMyOption(optionId);
    note(`Staked ${optionId}`);
    return { ...live, counts: nextCounts, myOption: optionId, sideBetId: `lab-${round.startsAt}`, status: "open" };
  };

  const closesIn = Math.max(0, round.closesAt - now);
  const derived = coinPhase(live, previous, closesIn, now);

  return (
    <div className="coin-lab">
      <header className="coin-lab-header">
        <h1>Coin lab</h1>
        <p className="muted">Dev only. A fake clock and server drive the real panel, so you can force a flip without waiting a minute.</p>
      </header>

      <div className="coin-lab-grid">
        <div>
          <CoinFlipPanel page live={live} onStake={onStake} />
        </div>

        <aside className="coin-lab-controls">
          <section>
            <h2>Round</h2>
            <div className="coin-lab-row">
              <button type="button" className="secondary-button" onClick={() => startRound(roundSeconds)}>
                New {roundSeconds}s round
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  setRound((r) => ({ ...r, closesAt: Math.min(r.closesAt, Date.now() + LOCK_MS) }));
                  note("Jumped to bets locked");
                }}
              >
                Lock now
              </button>
              <button
                type="button"
                className="primary-button"
                onClick={() => {
                  setRound((r) => ({ ...r, closesAt: Date.now() }));
                  roundRef.current = { ...roundRef.current, closesAt: Date.now() };
                }}
              >
                Close now
              </button>
            </div>
            <div className="coin-lab-row">
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  startRound(LOCK_MS / 1000 + 0.2);
                }}
              >
                Lock, then flip in 10s
              </button>
            </div>
            <label>
              Round length: {roundSeconds}s
              <input type="range" min={11} max={60} value={roundSeconds} onChange={(event) => setRoundSeconds(Number(event.target.value))} />
            </label>
            <label className="coin-lab-check">
              <input type="checkbox" checked={autoLoop} onChange={(event) => setAutoLoop(event.target.checked)} />
              Loop rounds automatically
            </label>
          </section>

          <section>
            <h2>Result</h2>
            <div className="coin-lab-chips" role="radiogroup" aria-label="Result">
              {(["heads", "tails", "edge", "odds", "no-stakes"] as ResultChoice[]).map((choice) => (
                <button
                  key={choice}
                  type="button"
                  role="radio"
                  aria-checked={result === choice}
                  className={result === choice ? "coin-lab-chip is-on" : "coin-lab-chip"}
                  onClick={() => setResult(choice)}
                >
                  {choice === "odds" ? "server odds" : choice === "no-stakes" ? "no stakes" : choice}
                </button>
              ))}
            </div>
            <label>
              Settlement {settleMs}ms after the close
              <input type="range" min={0} max={8000} step={100} value={settleMs} disabled={neverSettle} onChange={(event) => setSettleMs(Number(event.target.value))} />
            </label>
            <label className="coin-lab-check">
              <input type="checkbox" checked={neverSettle} onChange={(event) => setNeverSettle(event.target.checked)} />
              Never settle (tests the give-up path)
            </label>
            <label className="coin-lab-check">
              <input type="checkbox" checked={noEarlyResult} onChange={(event) => setNoEarlyResult(event.target.checked)} />
              Old server: no result until settlement
            </label>
          </section>

          <section>
            <h2>Starting face</h2>
            <div className="coin-lab-chips" role="radiogroup" aria-label="Starting face">
              {(["alternate", "heads", "tails"] as StartChoice[]).map((choice) => (
                <button
                  key={choice}
                  type="button"
                  role="radio"
                  aria-checked={startChoice === choice}
                  className={startChoice === choice ? "coin-lab-chip is-on" : "coin-lab-chip"}
                  onClick={() => setStartChoice(choice)}
                >
                  {choice}
                </button>
              ))}
            </div>
          </section>

          <section>
            <h2>Now</h2>
            <dl className="coin-lab-readout">
              <dt>Closes in</dt>
              <dd>{(closesIn / 1000).toFixed(1)}s</dd>
              <dt>Phase</dt>
              <dd>
                <code>{describe(derived.phase)}</code>
              </dd>
              <dt>Previous</dt>
              <dd>{previous ? `${previous.status}${previous.winningOptionId ? `, ${previous.winningOptionId}` : ""}` : "none"}</dd>
            </dl>
            <ol className="coin-lab-log">
              {log.map((line, index) => (
                <li key={`${index}-${line}`}>{line}</li>
              ))}
            </ol>
          </section>
        </aside>
      </div>

      <SceneOnly />
    </div>
  );
}

function describe(phase: CoinPhase) {
  switch (phase.kind) {
    case "rest":
      return `rest ${phase.face}`;
    case "lock":
      return `lock (start ${phase.face})`;
    case "wait":
      return `wait for result (start ${phase.face})`;
    case "land":
      return `land ${phase.face} (start ${phase.startFace})`;
  }
}

/** Set scene phases directly, without the panel's timing. */
function SceneOnly() {
  const [phase, setPhase] = useState<CoinPhase>({ kind: "rest", face: "heads" });
  const [sound, setSound] = useState(false);
  const counter = useRef(0);
  const id = () => `scene-${(counter.current += 1)}`;
  // Where the coin will be lying when the next phase starts.
  const start: Face = phase.face;

  return (
    <section className="coin-lab-scene">
      <h2>Scene only</h2>
      <p className="muted">Each button sets the coin's phase directly. Land plays a simulated flick from wherever the coin is lying; after landing it stays put.</p>
      <div className="coin-lab-row">
        <button type="button" className="secondary-button" onClick={() => setPhase({ kind: "rest", face: start })}>
          Rest
        </button>
        <button type="button" className="secondary-button" onClick={() => setPhase({ kind: "lock", id: id(), face: start === "edge" ? "heads" : start })}>
          Lock
        </button>
        <button type="button" className="secondary-button" onClick={() => setPhase({ kind: "wait", id: id(), face: start === "edge" ? "heads" : start })}>
          Wait
        </button>
      </div>
      <div className="coin-lab-row">
        {(["heads", "tails", "edge"] as Face[]).map((face) => (
          <button key={face} type="button" className="primary-button" onClick={() => setPhase({ kind: "land", id: id(), face, startFace: start })}>
            Land {face}
          </button>
        ))}
        <label className="coin-lab-check">
          <input
            type="checkbox"
            checked={sound}
            onChange={(event) => {
              if (event.target.checked) unlockAudio();
              setSound(event.target.checked);
            }}
          />
          Sound
        </label>
      </div>
      <p className="muted">
        Phase: <code>{describe(phase)}</code>
      </p>
      <div className="coin-lab-stage">
        <Suspense fallback={<div className="coin-canvas coin-canvas-loading" />}>
          <CoinScene phase={phase} sound={sound} />
        </Suspense>
      </div>
    </section>
  );
}

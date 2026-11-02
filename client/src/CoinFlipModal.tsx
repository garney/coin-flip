import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { Volume2, VolumeX } from "lucide-react";
import { api, type CoinFlipState } from "./api";
import { unlockAudio } from "./coin/audio";
import type { Face } from "./coin/motion";
import { LOCK_MS, coinPhase } from "./coin/phase";

const SOUND_KEY = "coin-flip-sound";


// three.js is large, so the 3D coin loads in its own chunk.
const CoinScene = lazy(() => import("./coin/CoinScene"));

export function CoinFlipPanel({
  page = false,
  live = null,
  onStake
}: {
  page?: boolean;
  live?: CoinFlipState | null;
  onStake?: (optionId: Face) => Promise<CoinFlipState>;
}) {
  const [open, setOpen] = useState(page);
  const [state, setState] = useState<CoinFlipState | null>(null);
  const [error, setError] = useState("");
  const [previous, setPrevious] = useState<CoinFlipState["previous"] | null>(null);
  // The result caption waits until the coin has actually landed.
  const [landedId, setLandedId] = useState<string | null>(null);
  const [sound, setSound] = useState(() => {
    try {
      return window.localStorage.getItem(SOUND_KEY) === "on";
    } catch {
      return false;
    }
  });
  const [caption, setCaption] = useState("Waiting for the window.");
  const [staking, setStaking] = useState<Face | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const picked = useRef<Face | null>(null);

  useEffect(() => {
    if (!live) return;
    setState((current) => {
      if (picked.current && live.myOption !== picked.current && live.status !== "settled" && live.startsAt === current?.startsAt) {
        return { ...live, myOption: picked.current };
      }
      picked.current = (live.myOption as Face | null) ?? (live.startsAt === current?.startsAt ? picked.current : null);
      return live;
    });
    if (live.previous) setPrevious(live.previous);
    setError("");
  }, [live]);


  useEffect(() => {
    if (!page && !open) return;
    const timer = window.setInterval(() => setNow(Date.now()), 200);
    return () => window.clearInterval(timer);
  }, [open, page]);

  async function stake(optionId: Face) {
    if (staking) return;
    setError("");
    setStaking(optionId);
    try {
      const next = onStake ? await onStake(optionId) : await api.stakeCoinFlip(optionId);
      picked.current = (next.myOption as Face | null) ?? optionId;
      setState(next);
      setCaption(`You picked ${optionId}. 1 credit.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Stake failed");
    } finally {
      setStaking(null);
    }
  }

  const closesIn = state ? Math.max(0, new Date(state.closesAt).getTime() - now) : 0;
  const betting = Boolean(state) && closesIn > LOCK_MS && state?.status !== "settled";
  const { phase, phaseCaption, resultCaption } = coinPhase(state, previous ?? null, closesIn, now);
  const landed = phase.kind === "land" && landedId === phase.id;
  const shownCaption = landed ? resultCaption : phaseCaption;

  const board = (
          <section className={page ? "coin-modal coin-page" : "coin-modal"} onClick={(event) => event.stopPropagation()}>
            <header className="coin-modal-header">
              <h2>Live coin flip</h2>
              <div className="coin-modal-actions">
                <button
                  type="button"
                  className="icon-button coin-sound-toggle"
                  aria-pressed={sound}
                  aria-label={sound ? "Turn coin sounds off" : "Turn coin sounds on"}
                  title={sound ? "Sound on" : "Sound off"}
                  onClick={() => {
                    const next = !sound;
                    // Clicking is what lets the browser play audio later.
                    if (next) unlockAudio();
                    setSound(next);
                    try {
                      window.localStorage.setItem(SOUND_KEY, next ? "on" : "off");
                    } catch {
                      // Private mode or blocked storage: the toggle still works for this visit.
                    }
                  }}
                >
                  {sound ? <Volume2 size={18} /> : <VolumeX size={18} />}
                </button>
                {page ? null : (
                  <button type="button" className="icon-button" onClick={() => setOpen(false)} aria-label="Close">
                    ×
                  </button>
                )}
              </div>
            </header>
            <Suspense fallback={<div className="coin-canvas coin-canvas-loading" aria-label="Loading coin" />}>
              <CoinScene phase={phase} sound={sound} onLanded={setLandedId} />
            </Suspense>
            <Countdown remainingMs={closesIn} />
            <p className="muted coin-caption" aria-live="polite">{shownCaption ?? caption}</p>
            <div className="coin-stakes">
              {(["heads", "tails", "edge"] as Face[]).map((face) => {
                const selected = state?.myOption === face;
                const busy = staking === face;
                return (
                  <button
                    key={face}
                    type="button"
                    className={selected ? "coin-choice is-selected" : "coin-choice"}
                    disabled={!betting || staking !== null}
                    onClick={() => void stake(face)}
                  >
                    {busy ? <span className="coin-choice-spinner" aria-label="Saving pick" /> : null}
                    <span>{face}</span>
                    <strong>{state?.counts[face] ?? 0}</strong>
                    {selected ? <em>Selected</em> : <em>1 credit</em>}
                  </button>
                );
              })}
            </div>
            <div className="coin-notes">
              <p className="muted">Stake is 1 credit. Bets lock with 10 seconds left. A coin flip is saved only after someone stakes.</p>
              <p className="muted">Starts {state?.startFace ?? "…"}. Same face about 51% (Diaconis). Edge about 1 in 6,000 (Murray and Teare).</p>
            </div>
            {!state?.sideBetId && !betting ? <p className="muted">No stakes this round, so nothing was recorded.</p> : null}
            {error ? <p className="form-error">{error}</p> : null}
          </section>
  );

  if (page) return board;

  return (
    <>
      <button className="secondary-button" type="button" onClick={() => setOpen(true)}>
        Coin flip
      </button>
      {open ? (
        <div className="modal-backdrop" onClick={() => setOpen(false)}>
          {board}
        </div>
      ) : null}
    </>
  );
}

function Countdown({ remainingMs }: { remainingMs: number }) {
  const totalSeconds = Math.ceil(remainingMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const locked = totalSeconds <= 10;

  return (
    <div className={`coin-countdown${locked ? " is-locked" : ""}`} aria-live="polite">
      <strong>
        {minutes}:{String(seconds).padStart(2, "0")}
      </strong>
      <span>{locked ? "Bets locked" : "Next flip"}</span>
    </div>
  );
}

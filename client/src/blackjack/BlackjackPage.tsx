import { useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import type { Group, Profile, PublicTable } from "../../../shared/types";
import { api } from "../api";
import { supabase } from "../supabase";
import { BlackjackTableView } from "./components/BlackjackTableView";
import { preloadCardAssets } from "./cardAssets";
import { clearActiveTable, readActiveTable, rejoinNotice, saveActiveTable } from "./session";
import "./blackjack.css";

type Props = {
  onExit: () => void;
};

function socketAck<T>(socket: Socket, event: string, payload?: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    socket.timeout(8000).emit(event, payload ?? {}, (err: Error | null, response: T) => {
      if (err) reject(err);
      else resolve(response);
    });
  });
}

function pickDefaultGroup(groups: Group[], profile: Profile | null, preferredGroupId: string) {
  const approved = groups.filter((g) => profile?.isAdmin || g.membershipStatus === "approved");
  const preferred = approved.find((group) => group.id === preferredGroupId);
  if (preferred) return preferred.id;
  const stationAlpha = approved.find(
    (group) => group.membershipStatus === "approved" && group.name.trim().toLowerCase() === "station alpha"
  );
  return stationAlpha?.id ?? approved[0]?.id ?? "";
}

export function BlackjackPage({ onExit }: Props) {
  const savedOnLoad = useRef(readActiveTable());
  const toasted = useRef(false);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [groupId, setGroupId] = useState(savedOnLoad.current?.groupId ?? "");
  const [lobby, setLobby] = useState<PublicTable[]>([]);
  const [table, setTable] = useState<PublicTable | null>(null);
  const [socketState, setSocketState] = useState<"off" | "live">("off");
  const [checkedIn, setCheckedIn] = useState(false);
  const [message, setMessage] = useState("");
  const [toast, setToast] = useState("");
  const [busy, setBusy] = useState(false);
  const [hostOpen, setHostOpen] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [hostTitle, setHostTitle] = useState("Friday night");
  const [hostBankroll, setHostBankroll] = useState("500");
  const [hostMin, setHostMin] = useState("1");
  const [hostMax, setHostMax] = useState("10");
  const [betAmount, setBetAmount] = useState("5");
  const socketRef = useRef<Socket | null>(null);
  const profileIdRef = useRef<string | null>(null);
  const tableIdRef = useRef<string | null>(null);
  const groupIdRef = useRef("");
  profileIdRef.current = profile?.id ?? null;
  tableIdRef.current = table?.id ?? null;
  groupIdRef.current = groupId;

  const approvedGroups = groups.filter((g) => profile?.isAdmin || g.membershipStatus === "approved");

  useEffect(() => {
    void preloadCardAssets().catch(() => undefined);
    void Promise.all([api.me(), api.groups()])
      .then(([me, nextGroups]) => {
        setProfile(me);
        setGroups(nextGroups);
        setGroupId((current) => pickDefaultGroup(nextGroups, me, current));
      })
      .catch((error) => setMessage(error instanceof Error ? error.message : "Could not load profile"));
  }, []);

  useEffect(() => {
    if (!table) return;
    saveActiveTable({ tableId: table.id, mode: table.mode, groupId: table.groupId });
    const notice = rejoinNotice(savedOnLoad.current, table);
    if (notice && !toasted.current) {
      toasted.current = true;
      setToast(notice);
    }
  }, [table]);

  useEffect(() => {
    if (!checkedIn || table) return;
    clearActiveTable();
    savedOnLoad.current = null;
  }, [checkedIn, table]);

  useEffect(() => {
    if (!profile || !groupId) return;
    let cancelled = false;
    setCheckedIn(false);

    void supabase.auth.getSession().then(({ data }) => {
      const token = data.session?.access_token;
      if (!token || cancelled) return;

      socketRef.current?.disconnect();
      const socket = io(window.location.origin, { path: "/socket.io", auth: { token } });
      socketRef.current = socket;

      socket.on("connect", () => {
        setSocketState("live");
        void socketAck(socket, "blackjack:join-group", { groupId })
          .catch((error) => setMessage(error instanceof Error ? error.message : "Could not join group lobby"))
          .finally(() => {
            if (!cancelled) setCheckedIn(true);
          });
      });
      socket.on("disconnect", () => setSocketState("off"));
      socket.on("blackjack:lobby", (rows: PublicTable[]) => setLobby(rows));
      socket.on("blackjack:state", (state: PublicTable) => {
        const pid = profileIdRef.current;
        const watchingId = tableIdRef.current;
        const relevant =
          state.groupId === groupIdRef.current &&
          (state.id === watchingId || state.dealerUserId === pid || (pid != null && state.seats.some((s) => s.userId === pid)));
        if (state.phase === "finished") {
          if (relevant) setTable(null);
          return;
        }
        if (relevant) setTable(state);
      });
      socket.on("blackjack:error", (payload: { message?: string }) => {
        if (payload?.message) setMessage(payload.message);
      });
      socket.on("blackjack:kicked", (payload: { message?: string }) => {
        clearActiveTable();
        savedOnLoad.current = null;
        setTable(null);
        setMessage(payload?.message || "You were removed from the table for inactivity");
      });
      socket.on("wallet:changed", (payload: { creditsBalance?: number }) => {
        if (typeof payload?.creditsBalance === "number") {
          setProfile((current) => (current ? { ...current, creditsBalance: payload.creditsBalance! } : current));
        } else {
          void api.me().then(setProfile).catch(() => undefined);
        }
      });
    });

    return () => {
      cancelled = true;
      socketRef.current?.disconnect();
      socketRef.current = null;
      setSocketState("off");
    };
  }, [profile?.id, groupId]);

  async function withBusy(action: () => Promise<void>) {
    setBusy(true);
    setMessage("");
    try {
      await action();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  const socket = socketRef.current;
  const socketReady = socketState === "live";
  const liveTables = lobby.filter((row) => row.mode === "live");
  const isHost = table?.dealerUserId === profile?.id;
  const seated = Boolean(table && profile && table.seats.some((seat) => seat.userId === profile.id));

  async function leaveTable() {
    if (!socket) return;
    const event = isHost && table?.mode === "live" ? "blackjack:end-table" : "blackjack:leave";
    const res = await socketAck<{ ok: boolean; error?: string }>(socket, event);
    if (!res.ok) throw new Error(res.error);
    clearActiveTable();
    savedOnLoad.current = null;
    setTable(null);
    setConfirmLeave(false);
  }

  return (
    <div className="blackjack-shell">
      <header className="bj-chrome">
        <div className="bj-brand">
          <button type="button" onClick={onExit}>
            SideBets
          </button>
          <span>Blackjack</span>
        </div>
        <div className="bj-brand">
          <span className="wallet-pill">{profile?.creditsBalance ?? 0} credits</span>
          {table ? (
            <button type="button" className="leave-table" disabled={!socketReady || busy} onClick={() => setConfirmLeave(true)}>
              Leave table
            </button>
          ) : null}
        </div>
      </header>

      {toast ? (
        <p className="bj-toast" role="status">
          {toast}
        </p>
      ) : null}
      {message ? <p className="bj-toast error">{message}</p> : null}

      {table && profile ? (
        <BlackjackTableView
          table={table}
          profile={profile}
          betAmount={betAmount}
          setBetAmount={setBetAmount}
          busy={busy}
          socketReady={socketReady}
          onBet={() =>
            void withBusy(async () => {
              if (!socket) return;
              const res = await socketAck<{ ok: boolean; error?: string }>(socket, "blackjack:bet", { amount: Number(betAmount) });
              if (!res.ok) throw new Error(res.error);
            })
          }
          onHit={() =>
            void withBusy(async () => {
              if (!socket) return;
              const res = await socketAck<{ ok: boolean; error?: string }>(socket, "blackjack:hit");
              if (!res.ok) throw new Error(res.error);
            })
          }
          onStand={() =>
            void withBusy(async () => {
              if (!socket) return;
              const res = await socketAck<{ ok: boolean; error?: string }>(socket, "blackjack:stand");
              if (!res.ok) throw new Error(res.error);
            })
          }
          onDeal={() =>
            void withBusy(async () => {
              if (!socket) return;
              const res = await socketAck<{ ok: boolean; error?: string }>(socket, "blackjack:deal");
              if (!res.ok) throw new Error(res.error);
            })
          }
          onStartBetting={() =>
            void withBusy(async () => {
              if (!socket) return;
              const res = await socketAck<{ ok: boolean; error?: string }>(socket, "blackjack:start-betting");
              if (!res.ok) throw new Error(res.error);
            })
          }
          onEndTable={() => setConfirmLeave(true)}
        />
      ) : (
        <div className="entry-screen">
          <section className="bj-modal" aria-label="Choose a table">
            <h2>Welcome to the table</h2>
            <p className="lede">Join an open game, or open a table for your group.</p>
            {approvedGroups.length > 1 ? (
              <label>
                Group
                <select value={groupId} onChange={(event) => setGroupId(event.target.value)}>
                  {approvedGroups.map((group) => (
                    <option key={group.id} value={group.id}>
                      {group.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {liveTables.length === 0 ? <p className="hint">No live table is open in this group.</p> : null}
            {liveTables.map((row) => (
              <article key={row.id} className="open-table">
                <div>
                  <strong>{row.title} is ready for you</strong>
                  <p className="hint">
                    {row.dealerName} is dealing · {row.seatedCount}/{row.maxSeats} seated · bankroll {row.dealerBankroll ?? 0} · limits {row.minBet}–{row.maxBet} · {row.phase}
                  </p>
                </div>
                <button
                  type="button"
                  className="primary"
                  disabled={!socket || busy}
                  onClick={() =>
                    void withBusy(async () => {
                      if (!socket) return;
                      const event = row.dealerUserId === profile?.id ? "blackjack:watch" : "blackjack:join";
                      const res = await socketAck<{ ok: boolean; error?: string; table?: PublicTable }>(socket, event, { tableId: row.id });
                      if (!res.ok) throw new Error(res.error);
                      if (res.table) setTable(res.table);
                    })
                  }
                >
                  {row.dealerUserId === profile?.id ? "Watch table" : "Join table"}
                </button>
              </article>
            ))}
            <div className="choice-grid">
              <article className="choice">
                <h3>Practice solo</h3>
                <p>Play a low-pressure round against the computer.</p>
                <button
                  type="button"
                  disabled={!socket || busy || !groupId}
                  onClick={() =>
                    void withBusy(async () => {
                      if (!socket) return;
                      const res = await socketAck<{ ok: boolean; error?: string; table?: PublicTable }>(socket, "blackjack:join-practice", { groupId });
                      if (!res.ok) throw new Error(res.error);
                      if (res.table) setTable(res.table);
                    })
                  }
                >
                  Start practice
                </button>
              </article>
              <article className="choice">
                <h3>Host a live table</h3>
                <p>Set the bankroll and limits, then invite your group.</p>
                <button type="button" onClick={() => setHostOpen(true)}>
                  Create table
                </button>
              </article>
            </div>
            <p className="reassurance">Your active table is saved automatically until you leave it or it closes.</p>
          </section>
        </div>
      )}

      {hostOpen ? (
        <div className="entry-screen" style={{ position: "fixed", inset: 0 }}>
          <form
            className="bj-modal"
            onSubmit={(event) => {
              event.preventDefault();
              void withBusy(async () => {
                if (!socket) return;
                const res = await socketAck<{ ok: boolean; error?: string; table?: PublicTable }>(socket, "blackjack:create-table", {
                  title: hostTitle,
                  bankroll: Number(hostBankroll),
                  minBet: Number(hostMin),
                  maxBet: Number(hostMax),
                  groupId
                });
                if (!res.ok) throw new Error(res.error);
                if (res.table) setTable(res.table);
                setHostOpen(false);
              });
            }}
          >
            <h2>Create table</h2>
            <div className="host-fields">
              <label>
                Table name
                <input value={hostTitle} onChange={(event) => setHostTitle(event.target.value)} />
              </label>
              <label>
                Dealer bankroll
                <input value={hostBankroll} onChange={(event) => setHostBankroll(event.target.value)} type="number" min={1} />
              </label>
              <label>
                Minimum bet
                <input value={hostMin} onChange={(event) => setHostMin(event.target.value)} type="number" min={1} />
              </label>
              <label>
                Maximum bet
                <input value={hostMax} onChange={(event) => setHostMax(event.target.value)} type="number" min={1} />
              </label>
            </div>
            <p className="hint">Bankroll must cover at least three times the maximum bet.</p>
            <button type="submit" className="primary" disabled={!socket || busy}>
              Open table
            </button>
            <button type="button" onClick={() => setHostOpen(false)}>
              Back
            </button>
          </form>
        </div>
      ) : null}

      {confirmLeave && table ? (
        <div className="entry-screen" style={{ position: "fixed", inset: 0 }}>
          <div className="confirm-modal" role="dialog" aria-modal="true" aria-labelledby="leave-title">
            <h2 id="leave-title">Leave table</h2>
            <p>
              {isHost && table.mode === "live"
                ? table.phase === "playing" || table.phase === "dealer"
                  ? "Finish this round before the table can close."
                  : "Closing returns the remaining bankroll to your wallet."
                : seated && (table.phase === "playing" || table.phase === "dealer")
                  ? "You can leave after this round finishes."
                  : "You will give up this seat."}
            </p>
            <div className="modal-actions">
            <button type="button" onClick={() => setConfirmLeave(false)}>
              Stay
            </button>
            <button
              type="button"
              className="danger"
              disabled={
                busy ||
                ((table.phase === "playing" || table.phase === "dealer") && (Boolean(isHost) || seated))
              }
              onClick={() => void withBusy(leaveTable)}
            >
              {isHost && table.mode === "live" ? "Close and refund" : "Leave seat"}
            </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

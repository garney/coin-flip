import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Bell, CheckCircle2, CircleDollarSign, Loader2, LogOut, MessageCircle, Plus, Search, Send, ShieldCheck, Trophy, UserCircle2, X } from "lucide-react";
import { io, type Socket } from "socket.io-client";
import type {
  AdminSummary,
  AdminUser,
  ChatMessage,
  CreditRequest,
  CreditTransaction,
  Group,
  GroupMember,
  Profile,
  RedemptionRequest,
  SideBet,
  SideBetDetail
} from "../../shared/types";
import { api } from "./api";
import { CoinFlipPanel } from "./CoinFlipModal";
import { supabase } from "./supabase";

type SessionState = "loading" | "signed-out" | "signed-in";
type AppView = "flip" | "side-bets" | "groups" | "admin";
type PendingSettlement = {
  bet: SideBet;
  optionId: string;
};

function getSideBetIdFromPath() {
  const match = window.location.pathname.match(/^\/side-bets\/([^/]+)$/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function pushSideBetPath(id: string) {
  window.history.pushState({}, "", `/side-bets/${encodeURIComponent(id)}`);
}

function pushSideBetListPath() {
  window.history.pushState({}, "", "/");
}

function pickDefaultGroupId(groups: Group[], profile: Profile | null, currentId: string | null) {
  if (groups.length === 0) return null;
  if (currentId && groups.some((group) => group.id === currentId)) return currentId;
  const manageable = groups.find((group) => profile?.isAdmin || group.isGroupAdmin);
  return manageable?.id ?? groups[0].id;
}

const defaultForm = {
  title: "Will volume exceed _M Yen on _ _",
  description: "Will volume exceed _M Yen on Tuesday _\nSide Bet closes 11:30 am _\nwill be settled 10 am the next day",
  sourceUrl: "https://mission-control-client.astro.space/login",
  buyInCredits: "",
  closesDate: "",
  closesTime: "11:30",
  options: "No\nYES",
  groupId: ""
};

export function App() {
  const [sessionState, setSessionState] = useState<SessionState>("loading");
  const [profile, setProfile] = useState<Profile | null>(null);
  const [sideBets, setSideBets] = useState<SideBet[]>([]);
  const [sideBetsLoading, setSideBetsLoading] = useState(false);
  const [selectedSideBetId, setSelectedSideBetId] = useState<string | null>(null);
  const [routeSideBetId, setRouteSideBetId] = useState<string | null>(() => getSideBetIdFromPath());
  const [selectedSideBet, setSelectedSideBet] = useState<SideBetDetail | null>(null);
  const [selectedSideBetLoading, setSelectedSideBetLoading] = useState(false);
  const [transactions, setTransactions] = useState<CreditTransaction[]>([]);
  const [redemptions, setRedemptions] = useState<RedemptionRequest[]>([]);
  const [creditRequests, setCreditRequests] = useState<CreditRequest[]>([]);
  const [adminSummary, setAdminSummary] = useState<AdminSummary | null>(null);
  const [adminUsers, setAdminUsers] = useState<AdminUser[]>([]);
  const [adminTransactions, setAdminTransactions] = useState<CreditTransaction[]>([]);
  const [adminRedemptions, setAdminRedemptions] = useState<RedemptionRequest[]>([]);
  const [adminCreditRequests, setAdminCreditRequests] = useState<CreditRequest[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [groupMembers, setGroupMembers] = useState<GroupMember[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [groupUserId, setGroupUserId] = useState("");
  const [groupForm, setGroupForm] = useState({ name: "", visibility: "private" as "public" | "private", logoUrl: "" });
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("open");
  const [form, setForm] = useState(defaultForm);
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [pendingSettlement, setPendingSettlement] = useState<PendingSettlement | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatUnreadCount, setChatUnreadCount] = useState(0);
  const [chatDraft, setChatDraft] = useState("");
  const [chatBusy, setChatBusy] = useState(false);
  const [sideBetComments, setSideBetComments] = useState<ChatMessage[]>([]);
  const [sideBetCommentDraft, setSideBetCommentDraft] = useState("");
  const [sideBetCommentBusy, setSideBetCommentBusy] = useState(false);
  const [view, setView] = useState<AppView>("flip");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const chatOpenRef = useRef(false);

  const activeBets = useMemo(() => sideBets.filter((bet) => bet.status === "open").length, [sideBets]);
  const creatableGroups = useMemo(() => {
    if (!profile) return [];
    if (profile.isAdmin) return groups;
    return groups.filter((group) => group.membershipStatus === "approved");
  }, [groups, profile]);
  const activeSideBetId = routeSideBetId ?? selectedSideBetId;

  const refreshSideBetList = useCallback(async () => {
    setSideBets(await api.sideBets(search, status));
  }, [search, status]);

  const refreshSelectedSideBet = useCallback(async () => {
    if (!activeSideBetId) return;
    setSelectedSideBet(await api.sideBet(activeSideBetId));
  }, [activeSideBetId]);

  const refreshWalletData = useCallback(async () => {
    const [me, wallet, walletRedemptions, walletCreditRequests] = await Promise.all([api.me(), api.transactions(), api.redemptions(), api.creditRequests()]);
    setProfile(me);
    setTransactions(wallet);
    setRedemptions(walletRedemptions);
    setCreditRequests(walletCreditRequests);
  }, []);

  const refreshGroups = useCallback(async (preferredGroupId?: string | null) => {
    const [nextGroups, me] = await Promise.all([api.groups(), api.me()]);
    setProfile(me);
    setGroups(nextGroups);
    setSelectedGroupId((current) => pickDefaultGroupId(nextGroups, me, preferredGroupId ?? current));
    return nextGroups;
  }, []);

  const refreshAdminData = useCallback(async () => {
    const [summary, users, adminTx, redemptionQueue, creditRequestQueue] = await Promise.all([
      api.adminSummary(),
      api.adminUsers(),
      api.adminTransactions(),
      api.adminRedemptions(),
      api.adminCreditRequests()
    ]);
    setAdminSummary(summary);
    setAdminUsers(users);
    setAdminTransactions(adminTx);
    setAdminRedemptions(redemptionQueue);
    setAdminCreditRequests(creditRequestQueue);
  }, []);

  const refreshData = useCallback(async () => {
    setSideBetsLoading(true);
    try {
      const [me, bets, wallet, walletRedemptions, walletCreditRequests, nextGroups] = await Promise.all([
        api.me(),
        api.sideBets(search, status),
        api.transactions(),
        api.redemptions(),
        api.creditRequests(),
        api.groups()
      ]);
      setProfile(me);
      setSideBets(bets);
      setTransactions(wallet);
      setRedemptions(walletRedemptions);
      setCreditRequests(walletCreditRequests);
      setGroups(nextGroups);
      setSelectedGroupId((current) => pickDefaultGroupId(nextGroups, me, current));

      if (me.isAdmin || me.isGroupAdmin) {
        await refreshAdminData();
      }
    } finally {
      setSideBetsLoading(false);
    }
  }, [refreshAdminData, search, status]);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSessionState(data.session ? "signed-in" : "signed-out");
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      setSessionState(session ? "signed-in" : "signed-out");
    });

    return () => listener.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    function syncRoute() {
      const nextSideBetId = getSideBetIdFromPath();
      setRouteSideBetId(nextSideBetId);
      if (nextSideBetId) {
        setSelectedSideBetId(null);
      }
      if (nextSideBetId) {
        setView("side-bets");
      }
    }

    window.addEventListener("popstate", syncRoute);
    return () => window.removeEventListener("popstate", syncRoute);
  }, []);

  useEffect(() => {
    if (sessionState !== "signed-in") return;
    refreshData().catch((error) => setMessage(error.message));
  }, [sessionState, refreshData]);

  useEffect(() => {
    const selectedGroup = groups.find((group) => group.id === selectedGroupId);
    if (sessionState !== "signed-in" || !selectedGroup || (!profile?.isAdmin && !selectedGroup.isGroupAdmin)) {
      setGroupMembers([]);
      return;
    }

    api.groupMembers(selectedGroup.id).then(setGroupMembers).catch((error) => setMessage(error.message));
  }, [groups, profile?.isAdmin, profile?.isGroupAdmin, selectedGroupId, sessionState]);

  useEffect(() => {
    if (view !== "groups" || !profile || groups.length === 0) return;
    setSelectedGroupId((current) => pickDefaultGroupId(groups, profile, current));
  }, [groups, profile, view]);

  useEffect(() => {
    if (sessionState !== "signed-in") return;

    if (!activeSideBetId) {
      setSelectedSideBet(null);
      setSelectedSideBetLoading(false);
      return;
    }

    let cancelled = false;
    setSelectedSideBetLoading(true);
    api
      .sideBet(activeSideBetId)
      .then((bet) => {
        if (!cancelled) {
          setSelectedSideBet(bet);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setSelectedSideBet(null);
          setMessage(error instanceof Error ? error.message : "Could not load side bet");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setSelectedSideBetLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeSideBetId, sessionState]);

  useEffect(() => {
    if (profile && !profile.isAdmin && !profile.isGroupAdmin && view === "admin") {
      setView("side-bets");
    }
  }, [profile, view]);

  useEffect(() => {
    if (!createModalOpen && !pendingSettlement) return;

    function closeOnEscape(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") {
        setCreateModalOpen(false);
        setPendingSettlement(null);
      }
    }

    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [createModalOpen, pendingSettlement]);

  useEffect(() => {
    if (sessionState !== "signed-in") return;
    api
      .chatMessages("general")
      .then((messages) => {
        setChatMessages(messages);
        setChatUnreadCount(0);
      })
      .catch((error) => setMessage(error.message));
  }, [sessionState]);

  useEffect(() => {
    chatOpenRef.current = chatOpen;
    if (chatOpen) {
      setChatUnreadCount(0);
    }
  }, [chatOpen]);

  useEffect(() => {
    if (sessionState !== "signed-in" || !activeSideBetId) {
      setSideBetComments([]);
      setSideBetCommentDraft("");
      return;
    }

    api
      .chatMessages("side_bet", activeSideBetId)
      .then((comments) => setSideBetComments(sortNewestFirst(comments)))
      .catch((error) => setMessage(error.message));
  }, [activeSideBetId, sessionState]);

  useEffect(() => {
    let socket: Socket | null = null;

    async function connectSocket() {
      const { data } = await supabase.auth.getSession();
      if (!data.session?.access_token) return;

      socket = io("/", { auth: { token: data.session.access_token } });
      if (activeSideBetId) {
        socket.emit("side-bet:watch", { betId: activeSideBetId });
        socket.emit("chat:watch", { sideBetId: activeSideBetId });
      }

      socket.on("side-bet:changed", (payload: { betId?: string }) => {
        refreshSideBetList().catch((error) => setMessage(error.message));
        if (payload.betId && payload.betId === activeSideBetId) {
          refreshSelectedSideBet().catch((error) => setMessage(error.message));
        }
      });

      socket.on("wallet:changed", () => {
        refreshWalletData().catch((error) => setMessage(error.message));
      });

      socket.on("admin:changed", () => {
        if (profile?.isAdmin) {
          refreshAdminData().catch((error) => setMessage(error.message));
        }
      });
      socket.on("chat:message", (message: ChatMessage) => {
        if (message.room === "side_bet") {
          setSideBetComments((current) => {
            if (message.sideBetId !== activeSideBetId || current.some((candidate) => candidate.id === message.id)) return current;
            return [message, ...current].slice(0, 50);
          });
          return;
        }

        setChatMessages((current) => {
          if (current.some((candidate) => candidate.id === message.id)) return current;
          setChatUnreadCount((unread) => (chatOpenRef.current ? 0 : unread + 1));
          return [...current, message].slice(-50);
        });
      });
    }

    if (sessionState === "signed-in") {
      connectSocket();
    }

    return () => {
      if (socket && activeSideBetId) {
        socket.emit("side-bet:unwatch", { betId: activeSideBetId });
        socket.emit("chat:unwatch", { sideBetId: activeSideBetId });
      }
      socket?.disconnect();
    };
  }, [profile?.isAdmin, refreshAdminData, refreshSelectedSideBet, refreshSideBetList, refreshWalletData, activeSideBetId, sessionState]);

  async function signIn() {
    await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.origin }
    });
  }

  async function signOut() {
    await supabase.auth.signOut();
    setProfile(null);
    setSideBets([]);
    setSideBetsLoading(false);
    setSelectedSideBetId(null);
    setSelectedSideBet(null);
    setSideBetComments([]);
    setSideBetCommentDraft("");
    setTransactions([]);
    setRedemptions([]);
    setCreditRequests([]);
    setAdminSummary(null);
    setAdminUsers([]);
    setAdminRedemptions([]);
    setAdminCreditRequests([]);
    setGroups([]);
    setGroupMembers([]);
    setSelectedGroupId(null);
    setGroupUserId("");
    setGroupForm({ name: "", visibility: "private", logoUrl: "" });
    setChatOpen(false);
    setChatMessages([]);
    setChatUnreadCount(0);
    setChatDraft("");
    setView("side-bets");
    setSessionState("signed-out");
  }

  async function withAction(action: () => Promise<unknown>, success: string) {
    setBusy(true);
    setMessage("");
    try {
      await action();
      await refreshData();
      setMessage(success);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  async function withGroupAction(action: () => Promise<unknown>, success: string) {
    setBusy(true);
    setMessage("");
    try {
      const result = await action();
      const preferredGroupId = typeof result === "string" ? result : null;
      const nextGroups = await refreshGroups(preferredGroupId);
      const me = await api.me();
      setProfile(me);
      const nextGroupId = pickDefaultGroupId(nextGroups, me, preferredGroupId ?? selectedGroupId);
      if (nextGroupId) {
        const selectedGroup = nextGroups.find((group) => group.id === nextGroupId);
        if (me.isAdmin || selectedGroup?.isGroupAdmin) {
          setGroupMembers(await api.groupMembers(nextGroupId));
        }
      }
      if (me.isAdmin || me.isGroupAdmin) {
        await refreshAdminData();
      }
      setMessage(success);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  async function createGroup(event: FormEvent) {
    event.preventDefault();
    await withGroupAction(async () => {
      const created = await api.createGroup({
        name: groupForm.name.trim(),
        visibility: groupForm.visibility,
        logoUrl: groupForm.logoUrl.trim() || null
      });
      setGroupForm({ name: "", visibility: "private", logoUrl: "" });
      return created.id;
    }, "Group created");
  }

  function openSideBetPage(id: string) {
    pushSideBetPath(id);
    setRouteSideBetId(id);
    setSelectedSideBetId(null);
    setMessage("");
  }

  function closeSideBetPage() {
    if (getSideBetIdFromPath()) {
      pushSideBetListPath();
    }
    setRouteSideBetId(null);
    setSelectedSideBet(null);
    setSelectedSideBetLoading(false);
  }

  function closeSideBetModal() {
    setSelectedSideBetId(null);
    setSelectedSideBet(null);
    setSelectedSideBetLoading(false);
  }

  function openCreateModal() {
    setForm((current) => {
      const currentGroupValid = creatableGroups.some((group) => group.id === current.groupId);
      const defaultGroupId = creatableGroups.length === 1 ? creatableGroups[0].id : currentGroupValid ? current.groupId : creatableGroups[0]?.id ?? "";
      return { ...current, groupId: defaultGroupId };
    });
    setCreateModalOpen(true);
  }

  async function createBet(event: FormEvent) {
    event.preventDefault();
    await withAction(async () => {
      if (!form.buyInCredits || !form.closesDate || !form.closesTime) {
        throw new Error("Add a buy-in amount, close date, and close time before creating the side bet");
      }
      if (creatableGroups.length > 1 && !form.groupId) {
        throw new Error("Select which group this side bet is for");
      }

      const now = new Date();
      const closesAt = new Date(`${form.closesDate}T${form.closesTime}`);
      if (Number.isNaN(closesAt.getTime())) {
        throw new Error("Close date or time is invalid");
      }

      await api.createSideBet({
        title: form.title,
        description: form.description,
        sourceUrl: form.sourceUrl || null,
        buyInCredits: Number(form.buyInCredits),
        houseFeePercent: 0,
        startsAt: now.toISOString(),
        closesAt: closesAt.toISOString(),
        options: form.options
          .split("\n")
          .map((option) => option.trim())
          .filter(Boolean),
        ...(form.groupId ? { groupId: form.groupId } : {})
      });
      setCreateModalOpen(false);
    }, "Side bet created");
  }

  async function sendChatMessage(event: FormEvent) {
    event.preventDefault();
    const body = chatDraft.trim();
    if (!body) return;

    setChatBusy(true);
    setMessage("");
    try {
      const sent = await api.createChatMessage({ room: "general", body });
      setChatMessages((current) => (current.some((message) => message.id === sent.id) ? current : [...current, sent].slice(-50)));
      setChatDraft("");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not send chat message");
    } finally {
      setChatBusy(false);
    }
  }

  async function sendSideBetComment(event: FormEvent) {
    event.preventDefault();
    const body = sideBetCommentDraft.trim();
    if (!body || !activeSideBetId) return;

    setSideBetCommentBusy(true);
    setMessage("");
    try {
      const sent = await api.createChatMessage({ room: "side_bet", sideBetId: activeSideBetId, body });
      setSideBetComments((current) => (current.some((comment) => comment.id === sent.id) ? current : [sent, ...current].slice(0, 50)));
      setSideBetCommentDraft("");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not add comment");
    } finally {
      setSideBetCommentBusy(false);
    }
  }

  function sortNewestFirst(messages: ChatMessage[]) {
    return [...messages].sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
  }

  if (sessionState === "loading") {
    return <main className="center-screen">Loading SideBet...</main>;
  }

  if (sessionState === "signed-out") {
    return (
      <main className="auth-screen">
        <section className="auth-panel">
          <img className="auth-logo" src="/assets/sidebets.png" alt="SideBet" />
          <h1 className="sr-only">SideBet</h1>
          <p>Create trusted prediction pools, buy in with credits, and settle results when the outcome is known.</p>
          <button className="primary-button" onClick={signIn}>
            <UserCircle2 size={18} />
            Continue with Google
          </button>
          <span className="setup-note">Google SSO is handled by Supabase Auth.</span>
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <div className="brand-row">
            <img className="brand-logo" src="/assets/sidebets.png" alt="Coin flip" />
          </div>
          {/* <span className="muted">Single-port app: web, API, and sockets together.</span> */}
        </div>
        <div className="topbar-actions">
          <div className="view-switch" aria-label="View switcher">
            <button
              className={view === "flip" ? "active" : ""}
              type="button"
              onClick={() => setView("flip")}
            >
              Flip
            </button>
            <button
              className={view === "side-bets" ? "active" : ""}
              type="button"
              onClick={() => {
                setView("side-bets");
                if (routeSideBetId) {
                  closeSideBetPage();
                }
              }}
            >
              Side bets
            </button>
            <button
              className={view === "groups" ? "active" : ""}
              type="button"
              onClick={() => {
                if (routeSideBetId) {
                  closeSideBetPage();
                }
                setView("groups");
              }}
            >
              Groups
            </button>
            {profile?.isAdmin || profile?.isGroupAdmin ? (
              <button
                className={view === "admin" ? "active" : ""}
                type="button"
                onClick={() => {
                  if (routeSideBetId) {
                    closeSideBetPage();
                  }
                  setView("admin");
                }}
              >
                <ShieldCheck size={15} />
                Admin
              </button>
            ) : null}
          </div>
          <span className="balance">
            <CircleDollarSign size={17} />
            {profile?.creditsBalance.toFixed(2) ?? "0.00"} credits
          </span>
          <button className="icon-button" onClick={signOut} aria-label="Sign out">
            <LogOut size={18} />
          </button>
        </div>
      </header>

      {message ? <div className="toast">{message}</div> : null}

      {view === "flip" ? <CoinFlipPanel page /> : null}

      {view === "side-bets" ? (
        <>
          {routeSideBetId ? (
            <SideBetPage
              bet={selectedSideBet}
              loading={selectedSideBetLoading}
              busy={busy}
              onBack={closeSideBetPage}
              onAction={withAction}
              onSettleRequest={setPendingSettlement}
              comments={sideBetComments}
              commentDraft={sideBetCommentDraft}
              commentsBusy={sideBetCommentBusy}
              currentUserId={profile?.id ?? ""}
              onCommentDraftChange={setSideBetCommentDraft}
              onCommentSubmit={sendSideBetComment}
              canSettle={profile?.id === selectedSideBet?.managerId || Boolean(profile?.isAdmin)}
              canEdit={profile?.id === selectedSideBet?.managerId}
              canRectify={Boolean(profile?.isAdmin)}
            />
          ) : null}
          {!routeSideBetId ? (
            <SideBetListView
              activeBets={activeBets}
              sideBets={sideBets}
              loading={sideBetsLoading}
              status={status}
              search={search}
              busy={busy}
              profile={profile}
              transactions={transactions}
              redemptions={redemptions}
              creditRequests={creditRequests}
              onSearchChange={setSearch}
              onStatusChange={setStatus}
              onCreate={openCreateModal}
              onView={openSideBetPage}
              onAction={withAction}
              onSettleRequest={setPendingSettlement}
            />
          ) : null}
          {createModalOpen ? (
            <CreateSideBetModal
              form={form}
              creatableGroups={creatableGroups}
              busy={busy}
              onClose={() => setCreateModalOpen(false)}
              onSubmit={createBet}
              onChange={setForm}
            />
          ) : null}
          {selectedSideBetId ? (
            <SideBetModal
              bet={selectedSideBet}
              loading={selectedSideBetLoading}
              busy={busy}
              onClose={closeSideBetModal}
              onAction={withAction}
              onSettleRequest={setPendingSettlement}
              comments={sideBetComments}
              commentDraft={sideBetCommentDraft}
              commentsBusy={sideBetCommentBusy}
              currentUserId={profile?.id ?? ""}
              onCommentDraftChange={setSideBetCommentDraft}
              onCommentSubmit={sendSideBetComment}
              canSettle={profile?.id === selectedSideBet?.managerId || Boolean(profile?.isAdmin)}
              canEdit={profile?.id === selectedSideBet?.managerId}
              canRectify={Boolean(profile?.isAdmin)}
            />
          ) : null}
          {pendingSettlement ? (
            <SettleConfirmationModal
              settlement={pendingSettlement}
              busy={busy}
              onClose={() => setPendingSettlement(null)}
              onConfirm={async () => {
                await withAction(
                  () => api.settleSideBet(pendingSettlement.bet.id, pendingSettlement.optionId),
                  `Side bet settled with ${pendingSettlement.bet.options.find((option) => option.id === pendingSettlement.optionId)?.label ?? "selected result"}`
                );
                setPendingSettlement(null);
              }}
            />
          ) : null}
        </>
      ) : view === "groups" ? (
        <GroupsView
          groups={groups}
          members={groupMembers}
          users={adminUsers}
          selectedGroupId={selectedGroupId}
          groupUserId={groupUserId}
          busy={busy}
          isMainAdmin={Boolean(profile?.isAdmin)}
          groupForm={groupForm}
          onSelectGroup={setSelectedGroupId}
          onGroupFormChange={setGroupForm}
          onGroupUserIdChange={setGroupUserId}
          onCreateGroup={createGroup}
          onDeleteGroup={(groupId) => withGroupAction(() => api.deleteGroup(groupId), "Group deleted")}
          onJoin={(groupId) => withGroupAction(() => api.joinGroup(groupId), "Group request submitted")}
          onApprove={(groupId, userId) => withGroupAction(() => api.reviewGroupMember(groupId, userId, { status: "approved" }), "Group member approved")}
          onReject={(groupId, userId) => withGroupAction(() => api.reviewGroupMember(groupId, userId, { status: "rejected" }), "Group member rejected")}
          onSetAdmin={(groupId, userId, isGroupAdmin) =>
            withGroupAction(() => api.setGroupAdmin(groupId, userId, { isGroupAdmin }), isGroupAdmin ? "Group admin granted" : "Group admin removed")
          }
          onAddMember={(groupId, userId) => withGroupAction(() => api.addGroupMember(groupId, { userId, status: "approved" }), "User added to group")}
          onRemoveMember={(groupId, userId) => withGroupAction(() => api.removeGroupMember(groupId, userId), "User removed from group")}
        />
      ) : profile?.isAdmin || profile?.isGroupAdmin ? (
        <AdminCentre
          summary={adminSummary}
          users={adminUsers}
          transactions={adminTransactions}
          redemptions={adminRedemptions}
          creditRequests={adminCreditRequests}
          busy={busy}
          onAction={withAction}
          onOpenGroups={() => {
            if (routeSideBetId) {
              closeSideBetPage();
            }
            setView("groups");
          }}
        />
      ) : null}
      <ChatWidget
        open={chatOpen}
        messages={chatMessages}
        unreadCount={chatUnreadCount}
        draft={chatDraft}
        busy={chatBusy}
        currentUserId={profile?.id ?? ""}
        onToggle={() => {
          setChatOpen((current) => {
            const next = !current;
            if (next) {
              setChatUnreadCount(0);
            }
            return next;
          });
        }}
        onClose={() => setChatOpen(false)}
        onDraftChange={setChatDraft}
        onSubmit={sendChatMessage}
      />
    </main>
  );
}

function ChatWidget({
  open,
  messages,
  unreadCount,
  draft,
  busy,
  currentUserId,
  onToggle,
  onClose,
  onDraftChange,
  onSubmit
}: {
  open: boolean;
  messages: ChatMessage[];
  unreadCount: number;
  draft: string;
  busy: boolean;
  currentUserId: string;
  onToggle: () => void;
  onClose: () => void;
  onDraftChange: (draft: string) => void;
  onSubmit: (event: FormEvent) => Promise<void>;
}) {
  return (
    <div className={open ? "chat-widget open" : "chat-widget"}>
      {open ? (
        <section className="chat-panel" aria-label="General chat">
          <div className="chat-header">
            <div>
              <strong>General chat</strong>
              <span>{messages.length} recent messages</span>
            </div>
            <button className="icon-button" type="button" onClick={onClose} aria-label="Close chat">
              <X size={18} />
            </button>
          </div>
          <div className="chat-messages">
            {messages.map((message) => {
              const mine = message.userId === currentUserId;
              return (
                <article className={mine ? "chat-message mine" : "chat-message"} key={message.id}>
                  <div>
                    <strong>{mine ? "You" : message.userName}</strong>
                    <span>{new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                  </div>
                  <p>{message.body}</p>
                </article>
              );
            })}
            {messages.length === 0 ? <p className="empty-state">No chat yet. Start the gloating.</p> : null}
          </div>
          <form className="chat-composer" onSubmit={onSubmit}>
            <textarea
              value={draft}
              rows={2}
              maxLength={1000}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || event.shiftKey || busy || !draft.trim()) return;

                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }}
              onChange={(event) => onDraftChange(event.target.value)}
              placeholder="Say something..."
            />
            <button className="icon-button" type="submit" disabled={busy || !draft.trim()} aria-label="Send message">
              <Send size={18} />
            </button>
          </form>
        </section>
      ) : null}
      <button className="chat-launcher" type="button" onClick={onToggle} aria-label={open ? "Close chat" : "Open chat"}>
        <MessageCircle size={23} />
        {unreadCount > 0 ? <span>{unreadCount}</span> : null}
      </button>
    </div>
  );
}

function SideBetListView({
  activeBets,
  sideBets,
  loading,
  status,
  search,
  busy,
  profile,
  transactions,
  redemptions,
  creditRequests,
  onSearchChange,
  onStatusChange,
  onCreate,
  onView,
  onAction,
  onSettleRequest
}: {
  activeBets: number;
  sideBets: SideBet[];
  loading: boolean;
  status: string;
  search: string;
  busy: boolean;
  profile: Profile | null;
  transactions: CreditTransaction[];
  redemptions: RedemptionRequest[];
  creditRequests: CreditRequest[];
  onSearchChange: (search: string) => void;
  onStatusChange: (status: string) => void;
  onCreate: () => void;
  onView: (id: string) => void;
  onAction: (action: () => Promise<unknown>, success: string) => Promise<void>;
  onSettleRequest: (settlement: PendingSettlement) => void;
}) {
  return (
    <>
      <section className="metrics">
        <Metric icon={<Bell size={18} />} label="Open bets" value={loading ? "…" : activeBets.toString()} />
        <Metric icon={<Trophy size={18} />} label="Total bets" value={loading ? "…" : sideBets.length.toString()} />
        <Metric icon={<CircleDollarSign size={18} />} label="Wallet" value={`${profile?.creditsBalance.toFixed(2) ?? "0.00"} cr`} />
        <Metric icon={<CheckCircle2 size={18} />} label="Fee" value="0%" />
      </section>

      <section className="workspace">
        <aside className="filters">
          <label className="search-box">
            <Search size={17} />
            <input value={search} onChange={(event) => onSearchChange(event.target.value)} placeholder="Search side bets" />
          </label>
          <label>
            Status
            <select value={status} onChange={(event) => onStatusChange(event.target.value)}>
              <option value="all">All</option>
              <option value="open">Open</option>
              <option value="settled">Settled</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </label>
          <p className="muted">Credits are added by admins from the admin centre.</p>
        </aside>

        <div className="main-column">
          <section className="bet-list" aria-label="Side bets" aria-busy={loading}>
            <div className="section-heading">
              <h2>{status === "all" ? "All Side Bets" : `${status[0].toUpperCase()}${status.slice(1)} Side Bets`}</h2>
              <span>{loading ? "Loading..." : `${sideBets.length} visible`}</span>
            </div>
            {loading ? (
              <div className="bet-list-loading">
                <LoadingSpinner label="Loading side bets..." size={28} />
              </div>
            ) : (
              <div className="table">
                <div className="table-row table-head">
                  <span>Bet</span>
                  <span>Buy-in</span>
                  <span>Pot</span>
                  <span>Closes</span>
                  <span>Action</span>
                </div>
                {sideBets.map((bet) => (
                  <article className="table-row" key={bet.id}>
                    <div>
                      <div className="bet-title-row">
                        <strong>{bet.title}</strong>
                        <div className="bet-title-actions">
                          <button className="text-button" type="button" onClick={() => onView(bet.id)}>
                            View
                          </button>
                        </div>
                      </div>
                      <p>{bet.description}</p>
                      <div className="bet-meta">
                        <span className="muted">Manager: {bet.managerName}</span>
                        {bet.groupName ? (
                          <span className="bet-group-pill">
                            {bet.groupName}
                            {bet.isPrivate ? " · private" : ""}
                          </span>
                        ) : null}
                      </div>
                      {bet.currentUserEntry ? <ChoiceLabel label={bet.currentUserEntry.optionLabel} compact /> : null}
                    </div>
                    <span>{bet.buyInCredits} cr</span>
                    <span>{bet.potCredits.toFixed(2)} cr</span>
                    <span>{new Date(bet.closesAt).toLocaleString()}</span>
                    <BetActions
                      bet={bet}
                      busy={busy}
                      onAction={onAction}
                      canSettle={profile?.id === bet.managerId || Boolean(profile?.isAdmin)}
                      onSettleRequest={onSettleRequest}
                    />
                  </article>
                ))}
                {sideBets.length === 0 ? <div className="empty-state">No side bets match this view.</div> : null}
              </div>
            )}
          </section>
        </div>

        <aside className="create-panel">
          <section className="create-entry">
            <div className="section-heading">
              <h2>Create</h2>
              <Plus size={18} />
            </div>
            <button className="primary-button" type="button" onClick={onCreate}>
              Create side bet
            </button>
          </section>

          <Wallet transactions={transactions} redemptions={redemptions} creditRequests={creditRequests} busy={busy} onAction={onAction} />
        </aside>
      </section>
    </>
  );
}

function SideBetPage({
  bet,
  loading,
  busy,
  comments,
  commentDraft,
  commentsBusy,
  currentUserId,
  canSettle,
  canEdit,
  canRectify,
  onBack,
  onAction,
  onCommentDraftChange,
  onCommentSubmit,
  onSettleRequest
}: {
  bet: SideBetDetail | null;
  loading: boolean;
  busy: boolean;
  comments: ChatMessage[];
  commentDraft: string;
  commentsBusy: boolean;
  currentUserId: string;
  canSettle: boolean;
  canEdit: boolean;
  canRectify: boolean;
  onBack: () => void;
  onAction: (action: () => Promise<unknown>, success: string) => Promise<void>;
  onCommentDraftChange: (draft: string) => void;
  onCommentSubmit: (event: FormEvent) => Promise<void>;
  onSettleRequest: (settlement: PendingSettlement) => void;
}) {
  return (
    <section className="side-bet-page">
      <button className="text-button back-button" type="button" onClick={onBack}>
        Back to side bets
      </button>
      <SideBetFocusPanel
        bet={bet}
        loading={loading}
        busy={busy}
        comments={comments}
        commentDraft={commentDraft}
        commentsBusy={commentsBusy}
        currentUserId={currentUserId}
        canSettle={canSettle}
        canEdit={canEdit}
        canRectify={canRectify}
        onAction={onAction}
        onCommentDraftChange={onCommentDraftChange}
        onCommentSubmit={onCommentSubmit}
        onSettleRequest={onSettleRequest}
      />
    </section>
  );
}

function GroupsView({
  groups,
  members,
  users,
  selectedGroupId,
  groupUserId,
  busy,
  isMainAdmin,
  groupForm,
  onSelectGroup,
  onGroupFormChange,
  onGroupUserIdChange,
  onCreateGroup,
  onDeleteGroup,
  onJoin,
  onApprove,
  onReject,
  onSetAdmin,
  onAddMember,
  onRemoveMember
}: {
  groups: Group[];
  members: GroupMember[];
  users: AdminUser[];
  selectedGroupId: string | null;
  groupUserId: string;
  busy: boolean;
  isMainAdmin: boolean;
  groupForm: { name: string; visibility: "public" | "private"; logoUrl: string };
  onSelectGroup: (id: string) => void;
  onGroupFormChange: (form: { name: string; visibility: "public" | "private"; logoUrl: string }) => void;
  onGroupUserIdChange: (id: string) => void;
  onCreateGroup: (event: FormEvent) => Promise<void>;
  onDeleteGroup: (groupId: string) => Promise<void>;
  onJoin: (groupId: string) => Promise<void>;
  onApprove: (groupId: string, userId: string) => Promise<void>;
  onReject: (groupId: string, userId: string) => Promise<void>;
  onSetAdmin: (groupId: string, userId: string, isGroupAdmin: boolean) => Promise<void>;
  onAddMember: (groupId: string, userId: string) => Promise<void>;
  onRemoveMember: (groupId: string, userId: string) => Promise<void>;
}) {
  const selectedGroup = groups.find((group) => group.id === selectedGroupId) ?? groups[0] ?? null;
  const canManageSelected = Boolean(selectedGroup?.isGroupAdmin || isMainAdmin);
  const canManageAny = isMainAdmin || groups.some((group) => group.isGroupAdmin);
  const manageableGroups = isMainAdmin ? groups : groups.filter((group) => group.isGroupAdmin);

  return (
    <section className="groups-view">
      <section className="group-list">
        <div className="section-heading">
          <h2>Groups</h2>
          <span>{groups.length} visible</span>
        </div>
        {canManageAny ? <p className="muted group-admin-hint">Select a group to manage members, approvals, and admins.</p> : null}
        <form className="group-create-form" onSubmit={onCreateGroup}>
          <label>
            Group name
            <input value={groupForm.name} onChange={(event) => onGroupFormChange({ ...groupForm, name: event.target.value })} />
          </label>
          <label>
            Logo URL
            <input value={groupForm.logoUrl} onChange={(event) => onGroupFormChange({ ...groupForm, logoUrl: event.target.value })} />
          </label>
          <label>
            Visibility
            <select value={groupForm.visibility} onChange={(event) => onGroupFormChange({ ...groupForm, visibility: event.target.value as "public" | "private" })}>
              <option value="private">Private</option>
              <option value="public">Public</option>
            </select>
          </label>
          <button className="primary-button" disabled={busy || !groupForm.name.trim()}>
            Create group
          </button>
        </form>
        {groups.map((group) => (
          <article
            className={group.id === selectedGroup?.id ? "group-row selected" : "group-row"}
            key={group.id}
            role="button"
            tabIndex={0}
            onClick={() => onSelectGroup(group.id)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelectGroup(group.id);
              }
            }}
          >
            {group.logoUrl ? <img className="group-logo" src={group.logoUrl} alt="" /> : <span className="group-logo fallback">{group.name.slice(0, 2).toUpperCase()}</span>}
            <div className="group-row-title">
              <strong>{group.name}</strong>
              {group.isGroupAdmin || isMainAdmin ? <span className="admin-pill">Manage</span> : null}
            </div>
            <span>{group.visibility}</span>
            <span>{group.memberCount} members</span>
            <strong>{group.membershipStatus === "none" ? "Not joined" : group.membershipStatus}</strong>
            {group.membershipStatus === "none" || group.membershipStatus === "rejected" ? (
              <button
                className="primary-button"
                disabled={busy}
                onClick={(event) => {
                  event.stopPropagation();
                  onJoin(group.id);
                }}
              >
                {group.visibility === "private" ? "Request access" : "Join"}
              </button>
            ) : null}
          </article>
        ))}
        {groups.length === 0 ? (
          <p className="empty-state">
            Groups are not set up yet. Run <code>supabase/migrations/0005_groups.sql</code> and <code>0006_group_logo_and_delete.sql</code> in Supabase.
          </p>
        ) : null}
      </section>

      {canManageAny && selectedGroup && canManageSelected ? (
        <section className="group-admin-panel">
          <div className="section-heading">
            <h2>{selectedGroup.name} Members</h2>
            <span>{isMainAdmin ? "Main admin" : "Group admin"}</span>
          </div>
          <button className="text-button danger group-delete-button" type="button" disabled={busy} onClick={() => onDeleteGroup(selectedGroup.id)}>
            Delete group
          </button>
          <form
            className="group-add-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (groupUserId) {
                onAddMember(selectedGroup.id, groupUserId);
              }
            }}
          >
            <label>
              Add user
              <select value={groupUserId} onChange={(event) => onGroupUserIdChange(event.target.value)}>
                <option value="">Select user</option>
                {users.map((user) => (
                  <option value={user.id} key={user.id}>
                    {user.displayName} {user.email ? `(${user.email})` : ""}
                  </option>
                ))}
              </select>
            </label>
            <button className="primary-button" disabled={busy || !groupUserId}>
              Add to group
            </button>
          </form>
          <div className="group-member-list">
            {members.map((member) => (
              <article className="group-member-row" key={`${member.groupId}-${member.userId}`}>
                <div>
                  <strong>{member.userName}</strong>
                  <span>{member.userEmail ?? "No email"}</span>
                </div>
                <span>{member.status}</span>
                <span>{member.isGroupAdmin ? "Group admin" : "Member"}</span>
                <div className="group-member-actions">
                  {member.status === "pending" ? (
                    <>
                      <button className="text-button" disabled={busy} onClick={() => onApprove(member.groupId, member.userId)}>
                        Approve
                      </button>
                      <button className="text-button danger" disabled={busy} onClick={() => onReject(member.groupId, member.userId)}>
                        Reject
                      </button>
                    </>
                  ) : null}
                  {member.status === "approved" ? (
                    <button className="text-button" disabled={busy} onClick={() => onSetAdmin(member.groupId, member.userId, !member.isGroupAdmin)}>
                      {member.isGroupAdmin ? "Remove admin" : "Make admin"}
                    </button>
                  ) : null}
                  <button className="text-button danger" disabled={busy} onClick={() => onRemoveMember(member.groupId, member.userId)}>
                    Kick
                  </button>
                </div>
              </article>
            ))}
            {members.length === 0 ? <p className="muted">No members loaded.</p> : null}
          </div>
        </section>
      ) : canManageAny ? (
        <section className="group-admin-panel group-admin-placeholder">
          <div className="section-heading">
            <h2>Group management</h2>
            <span>{isMainAdmin ? "Main admin" : "Group admin"}</span>
          </div>
          <p className="muted">Select a group on the left to manage members and access requests.</p>
          {manageableGroups.length > 0 ? (
            <div className="group-quick-picks">
              {manageableGroups.map((group) => (
                <button className="text-button" key={group.id} type="button" onClick={() => onSelectGroup(group.id)}>
                  {group.name}
                </button>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}
    </section>
  );
}

function Metric({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="metric">
      {icon}
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function LoadingSpinner({ label = "Loading...", size = 22 }: { label?: string; size?: number }) {
  return (
    <div className="loading-spinner" role="status" aria-live="polite" aria-busy="true">
      <Loader2 size={size} className="loading-spinner-icon" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

function BusyButtonLabel({ busy, idleLabel, busyLabel }: { busy: boolean; idleLabel: string; busyLabel?: string }) {
  if (!busy) return <>{idleLabel}</>;
  return (
    <span className="busy-button-label">
      <Loader2 size={15} className="loading-spinner-icon" aria-hidden="true" />
      {busyLabel ?? idleLabel}
    </span>
  );
}

function CreateSideBetModal({
  form,
  creatableGroups,
  busy,
  onClose,
  onSubmit,
  onChange
}: {
  form: typeof defaultForm;
  creatableGroups: Group[];
  busy: boolean;
  onClose: () => void;
  onSubmit: (event: FormEvent) => Promise<void>;
  onChange: (form: typeof defaultForm) => void;
}) {
  const selectedGroup = creatableGroups.find((group) => group.id === form.groupId) ?? null;
  const requiresGroupSelection = creatableGroups.length > 1;

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div className="modal-panel" role="dialog" aria-modal="true" aria-label="Create side bet" onClick={(event) => event.stopPropagation()}>
        <button className="icon-button modal-close" type="button" onClick={onClose} aria-label="Close create side bet">
          <X size={18} />
        </button>
        <form className="side-bet-create-form" onSubmit={onSubmit}>
          <div className="section-heading">
            <h2>Create Side Bet</h2>
            <span>Draft details</span>
          </div>
          {creatableGroups.length === 0 ? (
            <p className="muted">Join a group before creating a side bet.</p>
          ) : requiresGroupSelection ? (
            <label>
              Group
              <select value={form.groupId} onChange={(event) => onChange({ ...form, groupId: event.target.value })} required>
                <option value="">Select group</option>
                {creatableGroups.map((group) => (
                  <option value={group.id} key={group.id}>
                    {group.name}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <p className="muted">
              Group: <strong>{selectedGroup?.name ?? creatableGroups[0]?.name}</strong>
            </p>
          )}
          <label>
            Title
            <input value={form.title} onChange={(event) => onChange({ ...form, title: event.target.value })} />
          </label>
          <label>
            What is the bet about?
            <textarea value={form.description} onChange={(event) => onChange({ ...form, description: event.target.value })} />
          </label>
          <label>
            Source URL
            <input value={form.sourceUrl} onChange={(event) => onChange({ ...form, sourceUrl: event.target.value })} />
          </label>
          <div className="split-fields">
            <label>
              Buy-in
              <input
                type="number"
                min="1"
                value={form.buyInCredits}
                onChange={(event) => onChange({ ...form, buyInCredits: event.target.value })}
                placeholder="Credits"
              />
            </label>
            <label>
              Close date
              <input type="date" value={form.closesDate} onChange={(event) => onChange({ ...form, closesDate: event.target.value })} />
            </label>
          </div>
          <label>
            Close time
            <input type="time" value={form.closesTime} onChange={(event) => onChange({ ...form, closesTime: event.target.value })} />
          </label>
          <label>
            Options
            <textarea value={form.options} onChange={(event) => onChange({ ...form, options: event.target.value })} />
          </label>
          <button
            className="primary-button"
            disabled={busy || creatableGroups.length === 0 || !form.buyInCredits || !form.closesDate || !form.closesTime || (requiresGroupSelection && !form.groupId)}
          >
            <BusyButtonLabel busy={busy} idleLabel="Create side bet" busyLabel="Creating..." />
          </button>
        </form>
      </div>
    </div>
  );
}

function SettleConfirmationModal({
  settlement,
  busy,
  onClose,
  onConfirm
}: {
  settlement: PendingSettlement;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const selectedOption = settlement.bet.options.find((option) => option.id === settlement.optionId);

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div className="confirm-modal" role="dialog" aria-modal="true" aria-label="Confirm side bet settlement" onClick={(event) => event.stopPropagation()}>
        <button className="icon-button modal-close" type="button" onClick={onClose} aria-label="Close settlement confirmation">
          <X size={18} />
        </button>
        <section className="settlement-confirmation">
          <div className="section-heading">
            <h2>Confirm Settlement</h2>
            <span>{settlement.bet.participantCount} guesses</span>
          </div>
          <p className="detail-copy">{settlement.bet.title}</p>
          <div className="selected-result">
            <span>Selected result</span>
            <strong>{selectedOption?.label ?? "Unknown option"}</strong>
          </div>
          <p className="muted">
            This will settle the side bet with the selected result, distribute the pot to matching guesses, and mark the side bet as settled.
          </p>
          <div className="confirm-actions">
            <button className="text-button" type="button" disabled={busy} onClick={onClose}>
              Cancel
            </button>
            <button className="primary-button" type="button" disabled={busy || !selectedOption} onClick={onConfirm}>
              <BusyButtonLabel
                busy={busy}
                idleLabel={`Settle with ${selectedOption?.label ?? "selected result"}`}
                busyLabel="Settling..."
              />
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}

function SideBetModal({
  bet,
  loading,
  busy,
  comments,
  commentDraft,
  commentsBusy,
  currentUserId,
  canSettle,
  canEdit,
  canRectify,
  onClose,
  onAction,
  onCommentDraftChange,
  onCommentSubmit,
  onSettleRequest
}: {
  bet: SideBetDetail | null;
  loading: boolean;
  busy: boolean;
  comments: ChatMessage[];
  commentDraft: string;
  commentsBusy: boolean;
  currentUserId: string;
  canSettle: boolean;
  canEdit: boolean;
  canRectify: boolean;
  onClose: () => void;
  onAction: (action: () => Promise<unknown>, success: string) => Promise<void>;
  onCommentDraftChange: (draft: string) => void;
  onCommentSubmit: (event: FormEvent) => Promise<void>;
  onSettleRequest: (settlement: PendingSettlement) => void;
}) {
  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div className="modal-panel" role="dialog" aria-modal="true" aria-label={bet ? `${bet.title} details` : "Side bet details"} onClick={(event) => event.stopPropagation()}>
        <button className="icon-button modal-close" type="button" onClick={onClose} aria-label="Close side bet details">
          <X size={18} />
        </button>
        <SideBetFocusPanel
          bet={bet}
          loading={loading}
          busy={busy}
          comments={comments}
          commentDraft={commentDraft}
          commentsBusy={commentsBusy}
          currentUserId={currentUserId}
          canSettle={canSettle}
          canEdit={canEdit}
          canRectify={canRectify}
          onAction={onAction}
          onCommentDraftChange={onCommentDraftChange}
          onCommentSubmit={onCommentSubmit}
          onSettleRequest={onSettleRequest}
        />
      </div>
    </div>
  );
}

function SideBetFocusPanel({
  bet,
  loading,
  busy,
  comments,
  commentDraft,
  commentsBusy,
  currentUserId,
  canSettle,
  canEdit,
  canRectify,
  onAction,
  onCommentDraftChange,
  onCommentSubmit,
  onSettleRequest
}: {
  bet: SideBetDetail | null;
  loading: boolean;
  busy: boolean;
  comments: ChatMessage[];
  commentDraft: string;
  commentsBusy: boolean;
  currentUserId: string;
  canSettle: boolean;
  canEdit: boolean;
  canRectify: boolean;
  onAction: (action: () => Promise<unknown>, success: string) => Promise<void>;
  onCommentDraftChange: (draft: string) => void;
  onCommentSubmit: (event: FormEvent) => Promise<void>;
  onSettleRequest: (settlement: PendingSettlement) => void;
}) {
  const optionStats = useMemo(() => {
    if (!bet) return [];

    return bet.options.map((option) => {
      const entries = bet.entries.filter((entry) => entry.optionId === option.id);
      const stakeCredits = entries.reduce((total, entry) => total + entry.stakeCredits, 0);
      return {
        ...option,
        entries,
        stakeCredits,
        percent: bet.potCredits > 0 ? (stakeCredits / bet.potCredits) * 100 : 0
      };
    });
  }, [bet]);

  if (loading) {
    return (
      <section className="side-bet-focus side-bet-loading" aria-label="Loading side bet">
        <LoadingSpinner label="Loading side bet..." size={28} />
      </section>
    );
  }

  if (!bet) {
    return <section className="side-bet-focus empty-state">No side bet selected.</section>;
  }

  const winningOption = bet.options.find((option) => option.id === bet.winningOptionId);

  return (
    <section className={busy ? "side-bet-focus is-busy" : "side-bet-focus"} aria-label={`${bet.title} details`} aria-busy={busy}>
      {busy ? (
        <div className="side-bet-busy-overlay" aria-hidden="true">
          <LoadingSpinner label="Updating..." size={24} />
        </div>
      ) : null}
      <div className="section-heading">
        <div>
          <h2>{bet.title}</h2>
          <span>
            {bet.status} · Manager: {bet.managerName}
          </span>
        </div>
        <span>{bet.participantCount} guesses</span>
      </div>
      {bet.currentUserEntry ? <ChoiceLabel label={bet.currentUserEntry.optionLabel} /> : null}

      <p className="detail-copy">{bet.description}</p>
      {bet.sourceUrl ? (
        <a className="source-link" href={bet.sourceUrl} target="_blank" rel="noreferrer">
          Source
        </a>
      ) : null}

      <div className="detail-metrics">
        <Metric icon={<CircleDollarSign size={18} />} label="Buy-in" value={`${bet.buyInCredits.toFixed(2)} cr`} />
        <Metric icon={<Trophy size={18} />} label="Pot" value={`${bet.potCredits.toFixed(2)} cr`} />
        <Metric icon={<CheckCircle2 size={18} />} label="Fee" value={`${bet.houseFeePercent}%`} />
      </div>

      <div className="detail-times">
        <span>Starts {new Date(bet.startsAt).toLocaleString()}</span>
        <span>Closes {new Date(bet.closesAt).toLocaleString()}</span>
        {bet.settlesAt ? <span>Settled {new Date(bet.settlesAt).toLocaleString()}</span> : null}
      </div>

      <section className="option-breakdown">
        <div className="section-heading">
          <h2>Options</h2>
          {winningOption ? <span>Winner: {winningOption.label}</span> : null}
        </div>
        {optionStats.map((option) => (
          <article className="option-row" key={option.id}>
            <div>
              <strong>{option.label}</strong>
              <span>
                {option.entries.length} guesses · {option.stakeCredits.toFixed(2)} cr
              </span>
            </div>
            <div className="option-bar" aria-hidden="true">
              <span style={{ width: `${option.percent}%` }} />
            </div>
          </article>
        ))}
      </section>

      <section className="guess-list">
        <div className="section-heading">
          <h2>Guesses</h2>
          <span>{bet.entries.length} total</span>
        </div>
        {bet.entries.map((entry) => (
          <article className="guess-row" key={entry.id}>
            <div>
              <strong>{entry.userName}</strong>
              <span>{entry.userEmail ?? "No email"}</span>
            </div>
            <div>
              <strong>{entry.optionLabel}</strong>
              <span>{new Date(entry.createdAt).toLocaleString()}</span>
            </div>
            <strong>{entry.stakeCredits.toFixed(2)} cr</strong>
          </article>
        ))}
        {bet.entries.length === 0 ? <p className="muted">No guesses yet.</p> : null}
      </section>

      <SideBetComments
        comments={comments}
        draft={commentDraft}
        busy={commentsBusy}
        currentUserId={currentUserId}
        onDraftChange={onCommentDraftChange}
        onSubmit={onCommentSubmit}
      />

      {canEdit && bet.status === "open" ? <EditSideBetForm bet={bet} busy={busy} onAction={onAction} /> : null}
      <BetActions bet={bet} busy={busy} onAction={onAction} canSettle={canSettle} onSettleRequest={onSettleRequest} />
      {canRectify && bet.status === "settled" ? <RectifySettlementForm bet={bet} busy={busy} onAction={onAction} /> : null}
    </section>
  );
}

function EditSideBetForm({
  bet,
  busy,
  onAction
}: {
  bet: SideBetDetail;
  busy: boolean;
  onAction: (action: () => Promise<unknown>, success: string) => Promise<void>;
}) {
  const [editForm, setEditForm] = useState(() => sideBetToEditForm(bet));
  const hasEntries = bet.entries.length > 0;

  useEffect(() => {
    setEditForm(sideBetToEditForm(bet));
  }, [bet]);

  async function updateSideBet(event: FormEvent) {
    event.preventDefault();
    await onAction(
      () =>
        api.updateSideBet(bet.id, {
          title: editForm.title,
          description: editForm.description,
          sourceUrl: editForm.sourceUrl || null,
          buyInCredits: Number(editForm.buyInCredits),
          closesAt: new Date(editForm.closesAt).toISOString(),
          options: editForm.options
            .split("\n")
            .map((option) => option.trim())
            .filter(Boolean)
        }),
      "Side bet updated"
    );
  }

  return (
    <form className="side-bet-edit-form" onSubmit={updateSideBet}>
      <div className="section-heading">
        <h2>Edit Side Bet</h2>
        <span>Creator only</span>
      </div>
      <label>
        Title
        <input value={editForm.title} onChange={(event) => setEditForm({ ...editForm, title: event.target.value })} />
      </label>
      <label>
        What is the bet about?
        <textarea value={editForm.description} onChange={(event) => setEditForm({ ...editForm, description: event.target.value })} />
      </label>
      <label>
        Source URL
        <input value={editForm.sourceUrl} onChange={(event) => setEditForm({ ...editForm, sourceUrl: event.target.value })} />
      </label>
      <div className="split-fields">
        <label>
          Buy-in
          <input
            type="number"
            min="1"
            value={editForm.buyInCredits}
            disabled={hasEntries}
            onChange={(event) => setEditForm({ ...editForm, buyInCredits: Number(event.target.value) })}
          />
        </label>
        <label>
          Closes
          <input type="datetime-local" value={editForm.closesAt} onChange={(event) => setEditForm({ ...editForm, closesAt: event.target.value })} />
        </label>
      </div>
      <label>
        Options
        <textarea value={editForm.options} disabled={hasEntries} onChange={(event) => setEditForm({ ...editForm, options: event.target.value })} />
      </label>
      {hasEntries ? <p className="muted">Buy-in and options are locked because users have already joined.</p> : null}
      <button className="primary-button" disabled={busy}>
        <BusyButtonLabel busy={busy} idleLabel="Save side bet" busyLabel="Saving..." />
      </button>
    </form>
  );
}

function sideBetToEditForm(bet: SideBetDetail) {
  return {
    title: bet.title,
    description: bet.description,
    sourceUrl: bet.sourceUrl ?? "",
    buyInCredits: bet.buyInCredits,
    closesAt: toDatetimeLocalValue(bet.closesAt),
    options: bet.options.map((option) => option.label).join("\n")
  };
}

function toDatetimeLocalValue(value: string) {
  const date = new Date(value);
  const offsetMs = date.getTimezoneOffset() * 60 * 1000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

function isClosedForEntries(bet: SideBet) {
  return bet.status !== "open" || new Date(bet.closesAt).getTime() <= Date.now();
}

function ChoiceLabel({ label, compact = false }: { label: string; compact?: boolean }) {
  return (
    <span className={compact ? "choice-label compact" : "choice-label"}>
      Your choice <strong>{label}</strong>
    </span>
  );
}

function SideBetComments({
  comments,
  draft,
  busy,
  currentUserId,
  onDraftChange,
  onSubmit
}: {
  comments: ChatMessage[];
  draft: string;
  busy: boolean;
  currentUserId: string;
  onDraftChange: (draft: string) => void;
  onSubmit: (event: FormEvent) => Promise<void>;
}) {
  return (
    <section className="side-bet-comments">
      <div className="section-heading">
        <h2>Comments</h2>
        <span>{comments.length} recent</span>
      </div>
      <form className="comment-composer" onSubmit={onSubmit}>
        <textarea
          value={draft}
          rows={3}
          maxLength={1000}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey || busy || !draft.trim()) return;

            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }}
          onChange={(event) => onDraftChange(event.target.value)}
          placeholder="Add a comment..."
        />
        <button className="primary-button" disabled={busy || !draft.trim()}>
          {busy ? <BusyButtonLabel busy idleLabel="Comment" busyLabel="Sending..." /> : (
            <>
              <Send size={16} />
              Comment
            </>
          )}
        </button>
      </form>
      <div className="comment-list">
        {comments.map((comment) => {
          const mine = comment.userId === currentUserId;
          return (
            <article className={mine ? "comment-row mine" : "comment-row"} key={comment.id}>
              <div>
                <strong>{mine ? "You" : comment.userName}</strong>
                <span>{new Date(comment.createdAt).toLocaleString()}</span>
              </div>
              <p>{comment.body}</p>
            </article>
          );
        })}
        {comments.length === 0 ? <p className="muted">No comments yet.</p> : null}
      </div>
    </section>
  );
}

function RectifySettlementForm({
  bet,
  busy,
  onAction
}: {
  bet: SideBetDetail;
  busy: boolean;
  onAction: (action: () => Promise<unknown>, success: string) => Promise<void>;
}) {
  const [correctedOptionId, setCorrectedOptionId] = useState(bet.winningOptionId ?? bet.options[0]?.id ?? "");

  useEffect(() => {
    setCorrectedOptionId(bet.winningOptionId ?? bet.options[0]?.id ?? "");
  }, [bet.id, bet.options, bet.winningOptionId]);

  async function rectifySettlement(event: FormEvent) {
    event.preventDefault();
    await onAction(() => api.rectifySideBet(bet.id, correctedOptionId), "Side bet settlement rectified");
  }

  return (
    <form className="rectification-form" onSubmit={rectifySettlement}>
      <div className="section-heading">
        <h2>Rectify Settlement</h2>
        <span>Admin only</span>
      </div>
      <label>
        Correct winning option
        <select value={correctedOptionId} onChange={(event) => setCorrectedOptionId(event.target.value)}>
          {bet.options.map((option) => (
            <option value={option.id} key={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <button className="primary-button" disabled={busy || !correctedOptionId || correctedOptionId === bet.winningOptionId}>
        <BusyButtonLabel busy={busy} idleLabel="Rectify settlement" busyLabel="Rectifying..." />
      </button>
    </form>
  );
}

function BetActions({
  bet,
  busy,
  canSettle,
  onAction,
  onSettleRequest
}: {
  bet: SideBet;
  busy: boolean;
  canSettle: boolean;
  onAction: (action: () => Promise<unknown>, success: string) => Promise<void>;
  onSettleRequest: (settlement: PendingSettlement) => void;
}) {
  const [optionId, setOptionId] = useState(bet.currentUserEntry?.optionId ?? bet.options[0]?.id ?? "");
  const entriesClosed = isClosedForEntries(bet);
  const selectedOption = bet.options.find((option) => option.id === optionId);

  useEffect(() => {
    setOptionId(bet.currentUserEntry?.optionId ?? bet.options[0]?.id ?? "");
  }, [bet.id, bet.currentUserEntry?.optionId, bet.options]);

  if (bet.status === "settled") {
    const winner = bet.options.find((option) => option.id === bet.winningOptionId);
    return <span className="status settled">{winner?.label ?? "Settled"}</span>;
  }

  if (entriesClosed) {
    return (
      <div className="row-actions">
        {bet.currentUserEntry ? <ChoiceLabel label={bet.currentUserEntry.optionLabel} /> : <span className="status closed">Closed</span>}
        {canSettle ? (
          <>
            <select value={optionId} onChange={(event) => setOptionId(event.target.value)} aria-label="Settlement result">
              {bet.options.map((option) => (
                <option value={option.id} key={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
            <button className="text-button" disabled={busy || !optionId} onClick={() => onSettleRequest({ bet, optionId })}>
              <BusyButtonLabel busy={busy} idleLabel="Settle" />
            </button>
          </>
        ) : null}
      </div>
    );
  }

  return (
    <div className="row-actions">
      <select value={optionId} onChange={(event) => setOptionId(event.target.value)} disabled={busy}>
        {bet.options.map((option) => (
          <option value={option.id} key={option.id}>
            {option.label}
          </option>
        ))}
      </select>
      <button
        disabled={busy || bet.status !== "open" || !optionId || optionId === bet.currentUserEntry?.optionId}
        onClick={() =>
          onAction(
            () => api.joinSideBet(bet.id, optionId),
            bet.currentUserEntry ? `Choice changed to ${selectedOption?.label ?? "selected option"}` : "Joined side bet"
          )
        }
      >
        <BusyButtonLabel busy={busy} idleLabel={bet.currentUserEntry ? "Change" : "Join"} />
      </button>
      {canSettle ? (
        <button className="text-button" disabled={busy || !optionId} onClick={() => onSettleRequest({ bet, optionId })}>
          <BusyButtonLabel busy={busy} idleLabel="Settle" />
        </button>
      ) : null}
    </div>
  );
}

function Wallet({
  transactions,
  redemptions,
  creditRequests,
  busy,
  onAction
}: {
  transactions: CreditTransaction[];
  redemptions: RedemptionRequest[];
  creditRequests: CreditRequest[];
  busy: boolean;
  onAction: (action: () => Promise<unknown>, success: string) => Promise<void>;
}) {
  const [requestAmount, setRequestAmount] = useState(10);
  const [requestReason, setRequestReason] = useState("");
  const [redeemAmount, setRedeemAmount] = useState(1);
  const [claimDetails, setClaimDetails] = useState("");

  async function submitCreditRequest(event: FormEvent) {
    event.preventDefault();
    await onAction(
      () =>
        api.createCreditRequest({
          amountCredits: Number(requestAmount),
          requestReason
        }),
      "Credit request submitted"
    );
    setRequestReason("");
  }

  async function requestRedemption(event: FormEvent) {
    event.preventDefault();
    await onAction(
      () =>
        api.createRedemption({
          amountCredits: Number(redeemAmount),
          claimDetails
        }),
      "Redemption requested"
    );
    setClaimDetails("");
  }

  return (
    <section className="wallet">
      <div className="section-heading">
        <h2>Wallet</h2>
        <span>Latest</span>
      </div>
      <form className="credit-request-form" onSubmit={submitCreditRequest}>
        <div className="section-heading">
          <h2>Request Credits</h2>
          <span>Admin approved</span>
        </div>
        <label>
          Credits to request
          <input min="1" max="10000" type="number" value={requestAmount} onChange={(event) => setRequestAmount(Number(event.target.value))} />
        </label>
        <label>
          Reason
          <textarea
            value={requestReason}
            onChange={(event) => setRequestReason(event.target.value)}
            placeholder="Why do you need credits added?"
          />
        </label>
        <button className="primary-button" disabled={busy || !requestReason.trim()}>
          Request credits
        </button>
      </form>
      <form className="redemption-form" onSubmit={requestRedemption}>
        <div className="section-heading">
          <h2>Redeem Credits</h2>
          <span>Admin reviewed</span>
        </div>
        <label>
          Credits to redeem
          <input min="1" max="10000" type="number" value={redeemAmount} onChange={(event) => setRedeemAmount(Number(event.target.value))} />
        </label>
        <label>
          Claim details
          <textarea
            value={claimDetails}
            onChange={(event) => setClaimDetails(event.target.value)}
            placeholder="How should an admin settle this redemption?"
          />
        </label>
        <button className="primary-button" disabled={busy || !claimDetails.trim()}>
          Request redemption
        </button>
      </form>
      {creditRequests.slice(0, 3).map((creditRequest) => (
        <div className="transaction" key={creditRequest.id}>
          <span>Credit request {creditRequest.status}</span>
          <strong>{creditRequest.amountCredits.toFixed(2)} cr</strong>
        </div>
      ))}
      {redemptions.slice(0, 3).map((redemption) => (
        <div className="transaction" key={redemption.id}>
          <span>Redeem {redemption.status}</span>
          <strong>{redemption.amountCredits.toFixed(2)} cr</strong>
        </div>
      ))}
      {transactions.slice(0, 5).map((transaction) => (
        <div className="transaction" key={transaction.id}>
          <span>{transaction.description}</span>
          <strong className={transaction.amountCredits >= 0 ? "positive" : "negative"}>{transaction.amountCredits.toFixed(2)} cr</strong>
        </div>
      ))}
      {transactions.length === 0 ? <p className="muted">No credit transactions yet.</p> : null}
    </section>
  );
}

function AdminCentre({
  summary,
  users,
  transactions,
  redemptions,
  creditRequests,
  busy,
  onAction,
  onOpenGroups
}: {
  summary: AdminSummary | null;
  users: AdminUser[];
  transactions: CreditTransaction[];
  redemptions: RedemptionRequest[];
  creditRequests: CreditRequest[];
  busy: boolean;
  onAction: (action: () => Promise<unknown>, success: string) => Promise<void>;
  onOpenGroups: () => void;
}) {
  const [creditUserId, setCreditUserId] = useState("");
  const [creditAmount, setCreditAmount] = useState(10);
  const [creditDescription, setCreditDescription] = useState("Admin credit top-up");
  const selectedUserId = creditUserId || users[0]?.id || "";

  async function addCredits(event: FormEvent) {
    event.preventDefault();
    if (!selectedUserId) return;

    await onAction(
      () =>
        api.adminAddCredits({
          userId: selectedUserId,
          amountCredits: Number(creditAmount),
          description: creditDescription
        }),
      "Credits added"
    );
  }

  async function reviewRedemption(id: string, status: "approved" | "rejected") {
    await onAction(() => api.adminReviewRedemption(id, { status }), status === "approved" ? "Redemption approved" : "Redemption rejected");
  }

  async function reviewCreditRequest(id: string, status: "approved" | "rejected") {
    await onAction(
      () => api.adminReviewCreditRequest(id, { status }),
      status === "approved" ? "Credit request approved" : "Credit request rejected"
    );
  }

  return (
    <section className="admin-centre">
      <div className="section-heading">
        <h2>Admin Centre</h2>
        <span>Transactions and platform view</span>
      </div>
      <section className="admin-groups-link">
        <div>
          <strong>Group management</strong>
          <p className="muted">Create groups, approve members, and assign group admins from the Groups screen.</p>
        </div>
        <button className="primary-button" type="button" onClick={onOpenGroups}>
          Open Groups
        </button>
      </section>
      <div className="admin-grid">
        <Metric icon={<UserCircle2 size={18} />} label="Users" value={String(summary?.totalUsers ?? 0)} />
        <Metric icon={<Trophy size={18} />} label="Open bets" value={String(summary?.openBets ?? 0)} />
        <Metric icon={<CircleDollarSign size={18} />} label="Credits" value={`${summary?.totalCredits.toFixed(2) ?? "0.00"} cr`} />
      </div>
      <form className="credit-adjustment" onSubmit={addCredits}>
        <div className="section-heading">
          <h2>Add Credits</h2>
          <span>Admin only</span>
        </div>
        <label>
          User
          <select value={selectedUserId} onChange={(event) => setCreditUserId(event.target.value)}>
            {users.map((user) => (
              <option value={user.id} key={user.id}>
                {user.displayName} {user.email ? `(${user.email})` : ""} - {user.creditsBalance.toFixed(2)} cr
              </option>
            ))}
          </select>
        </label>
        <div className="split-fields">
          <label>
            Credits
            <input min="1" max="10000" type="number" value={creditAmount} onChange={(event) => setCreditAmount(Number(event.target.value))} />
          </label>
          <label>
            Reason
            <input value={creditDescription} onChange={(event) => setCreditDescription(event.target.value)} />
          </label>
        </div>
        <button className="primary-button" disabled={busy || !selectedUserId}>
          Add credits
        </button>
      </form>
      <section className="credit-request-queue">
        <div className="section-heading">
          <h2>Credit Requests</h2>
          <span>{creditRequests.filter((creditRequest) => creditRequest.status === "pending").length} pending</span>
        </div>
        {creditRequests.slice(0, 8).map((creditRequest) => (
          <article className="credit-request-item" key={creditRequest.id}>
            <div>
              <strong>
                {creditRequest.userName} requests {creditRequest.amountCredits.toFixed(2)} cr
              </strong>
              <p>{creditRequest.requestReason}</p>
              <span className={`status ${creditRequest.status}`}>{creditRequest.status}</span>
            </div>
            {creditRequest.status === "pending" ? (
              <div className="row-actions">
                <button disabled={busy} onClick={() => reviewCreditRequest(creditRequest.id, "approved")}>
                  Approve
                </button>
                <button className="text-button danger" disabled={busy} onClick={() => reviewCreditRequest(creditRequest.id, "rejected")}>
                  Reject
                </button>
              </div>
            ) : null}
          </article>
        ))}
        {creditRequests.length === 0 ? <p className="muted">No credit requests yet.</p> : null}
      </section>
      <section className="redemption-queue">
        <div className="section-heading">
          <h2>Redemptions</h2>
          <span>{redemptions.filter((redemption) => redemption.status === "pending").length} pending</span>
        </div>
        {redemptions.slice(0, 8).map((redemption) => (
          <article className="redemption-item" key={redemption.id}>
            <div>
              <strong>
                {redemption.userName} wants {redemption.amountCredits.toFixed(2)} cr
              </strong>
              <p>{redemption.claimDetails}</p>
              <span className={`status ${redemption.status}`}>{redemption.status}</span>
            </div>
            {redemption.status === "pending" ? (
              <div className="row-actions">
                <button disabled={busy} onClick={() => reviewRedemption(redemption.id, "approved")}>
                  Approve
                </button>
                <button className="text-button danger" disabled={busy} onClick={() => reviewRedemption(redemption.id, "rejected")}>
                  Reject
                </button>
              </div>
            ) : null}
          </article>
        ))}
        {redemptions.length === 0 ? <p className="muted">No redemption requests yet.</p> : null}
      </section>
      <div className="admin-table">
        {transactions.slice(0, 8).map((transaction) => (
          <div className="transaction" key={transaction.id}>
            <span>{transaction.kind}: {transaction.description}</span>
            <strong>{transaction.amountCredits.toFixed(2)} cr</strong>
          </div>
        ))}
      </div>
    </section>
  );
}

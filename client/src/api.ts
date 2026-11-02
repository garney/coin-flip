import type {
  AdminSummary,
  AdminUser,
  ChatMessage,
  CreditRequest,
  CreditRequestStatus,
  CreditTransaction,
  Group,
  GroupMember,
  Profile,
  RedemptionRequest,
  RedemptionStatus,
  SideBet,
  SideBetDetail
} from "../../shared/types";
import { supabase } from "./supabase";

async function getAccessToken() {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token;
}

export async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = await getAccessToken();
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers ?? {}),
      ...(token ? { authorization: `Bearer ${token}` } : {})
    }
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
    throw new Error(formatApiError(body?.error, response.status));
  }

  return response.json() as Promise<T>;
}

function formatApiError(error: unknown, status: number) {
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    if ("message" in error && typeof error.message === "string") return error.message;
    try {
      return JSON.stringify(error);
    } catch {
      return `Request failed with ${status}`;
    }
  }
  return `Request failed with ${status}`;
}

export const api = {
  me: () => apiFetch<Profile>("/me"),
  chatMessages: (room: "general" | "side_bet" = "general", sideBetId?: string) =>
    apiFetch<ChatMessage[]>(
      `/chat/messages?room=${encodeURIComponent(room)}${sideBetId ? `&sideBetId=${encodeURIComponent(sideBetId)}` : ""}`
    ),
  createChatMessage: (payload: { body: string; room?: "general" | "side_bet"; sideBetId?: string | null }) =>
    apiFetch<ChatMessage>("/chat/messages", {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  groups: () => apiFetch<Group[]>("/groups"),
  createGroup: (payload: { name: string; visibility: "public" | "private"; logoUrl?: string | null }) =>
    apiFetch<Group>("/groups", {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  deleteGroup: (id: string) =>
    apiFetch<{ ok: true }>(`/groups/${id}`, {
      method: "DELETE"
    }),
  joinGroup: (id: string) =>
    apiFetch<{ ok: true; status: Group["membershipStatus"] }>(`/groups/${id}/join`, {
      method: "POST"
    }),
  groupMembers: (id: string) => apiFetch<GroupMember[]>(`/groups/${id}/members`),
  addGroupMember: (id: string, payload: { userId: string; status?: "pending" | "approved"; isGroupAdmin?: boolean }) =>
    apiFetch<GroupMember>(`/groups/${id}/members`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  reviewGroupMember: (groupId: string, userId: string, payload: { status: "approved" | "rejected" }) =>
    apiFetch<GroupMember>(`/groups/${groupId}/members/${userId}`, {
      method: "PATCH",
      body: JSON.stringify(payload)
    }),
  setGroupAdmin: (groupId: string, userId: string, payload: { isGroupAdmin: boolean }) =>
    apiFetch<GroupMember>(`/groups/${groupId}/members/${userId}/admin`, {
      method: "PATCH",
      body: JSON.stringify(payload)
    }),
  removeGroupMember: (groupId: string, userId: string) =>
    apiFetch<{ ok: true }>(`/groups/${groupId}/members/${userId}`, {
      method: "DELETE"
    }),
  sideBets: (search: string, status: string) =>
    apiFetch<SideBet[]>(`/side-bets?search=${encodeURIComponent(search)}&status=${encodeURIComponent(status)}`),
  sideBet: (id: string) => apiFetch<SideBetDetail>(`/side-bets/${id}`),
  createSideBet: (payload: unknown) =>
    apiFetch<SideBet>("/side-bets", {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  updateSideBet: (id: string, payload: unknown) =>
    apiFetch<SideBetDetail>(`/side-bets/${id}`, {
      method: "PATCH",
      body: JSON.stringify(payload)
    }),
  joinSideBet: (id: string, optionId: string) =>
    apiFetch<{ ok: true }>(`/side-bets/${id}/join`, {
      method: "POST",
      body: JSON.stringify({ optionId })
    }),
  settleSideBet: (id: string, winningOptionId: string) =>
    apiFetch<{ ok: true; winners: number; payoutCredits: number; feeCredits: number }>(`/side-bets/${id}/settle`, {
      method: "POST",
      body: JSON.stringify({ winningOptionId })
  }),
  rectifySideBet: (id: string, winningOptionId: string) =>
    apiFetch<{
      ok: true;
      previousWinnerCount: number;
      correctedWinnerCount: number;
      previousPayoutCredits: number;
      correctedPayoutCredits: number;
      feeCredits: number;
    }>(`/admin/side-bets/${id}/rectify`, {
      method: "POST",
      body: JSON.stringify({ winningOptionId })
    }),
  transactions: () => apiFetch<CreditTransaction[]>("/wallet/transactions"),
  redemptions: () => apiFetch<RedemptionRequest[]>("/wallet/redemptions"),
  creditRequests: () => apiFetch<CreditRequest[]>("/wallet/credit-requests"),
  createRedemption: (payload: { amountCredits: number; claimDetails: string }) =>
    apiFetch<RedemptionRequest>("/wallet/redemptions", {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  createCreditRequest: (payload: { amountCredits: number; requestReason: string }) =>
    apiFetch<CreditRequest>("/wallet/credit-requests", {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  adminSummary: () => apiFetch<AdminSummary>("/admin/summary"),
  adminUsers: () => apiFetch<AdminUser[]>("/admin/users"),
  adminTransactions: () => apiFetch<CreditTransaction[]>("/admin/transactions"),
  adminAddCredits: (payload: { userId: string; amountCredits: number; description: string }) =>
    apiFetch<{ ok: true; creditsBalance: number }>("/admin/credits", {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  adminRedemptions: () => apiFetch<RedemptionRequest[]>("/admin/redemptions"),
  adminCreditRequests: () => apiFetch<CreditRequest[]>("/admin/credit-requests"),
  adminReviewRedemption: (id: string, payload: { status: Exclude<RedemptionStatus, "pending">; adminNote?: string }) =>
    apiFetch<RedemptionRequest>(`/admin/redemptions/${id}`, {
      method: "PATCH",
      body: JSON.stringify(payload)
    }),
  adminReviewCreditRequest: (id: string, payload: { status: Exclude<CreditRequestStatus, "pending">; adminNote?: string }) =>
    apiFetch<CreditRequest>(`/admin/credit-requests/${id}`, {
      method: "PATCH",
      body: JSON.stringify(payload)
    }),
  coinFlip: () => apiFetch<CoinFlipState>("/coin-flip"),
  stakeCoinFlip: (optionId: "heads" | "tails" | "edge") =>
    apiFetch<CoinFlipState>("/coin-flip/stake", {
      method: "POST",
      body: JSON.stringify({ optionId })
    })
};

export type CoinFlipState = {
  buyInCredits: number;
  startsAt: string;
  closesAt: string;
  startFace: "heads" | "tails";
  sideBetId: string | null;
  status: string;
  winningOptionId: "heads" | "tails" | "edge" | null;
  counts: { heads: number; tails: number; edge: number };
  myOption: string | null;
  /** This window's result, revealed once bets lock so the flip can start right at the close. */
  result?: "heads" | "tails" | "edge" | null;
  /** The window that just closed. Missing on stake replies. */
  previous?: {
    startsAt: string;
    closesAt: string;
    startFace: "heads" | "tails";
    sideBetId: string | null;
    status: string;
    winningOptionId: "heads" | "tails" | "edge" | null;
    result?: "heads" | "tails" | "edge";
  };
  model: { sameFaceProbability: number; edgeProbability: number; note: string };
};

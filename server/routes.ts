import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import type {
  AdminSummary,
  AdminUser,
  BetOption,
  ChatMessage,
  ChatRoom,
  CreditRequest,
  CreditRequestStatus,
  CreditTransaction,
  Group,
  GroupMember,
  RedemptionRequest,
  RedemptionStatus
} from "../shared/types.js";
import { requireAdmin, requireAuth, requireCreditAdmin, type AuthedRequest } from "./auth.js";
import { mapSideBet, mapSideBetDetail } from "./mappers.js";
import { getCoinFlipState, stakeCoinFlip } from "./coinFlip.js";
import { supabaseAdmin } from "./supabase.js";

const createBetSchema = z.object({
  title: z.string().min(5).max(140),
  description: z.string().min(10).max(1200),
  sourceUrl: z.string().url().nullable().optional(),
  buyInCredits: z.number().positive().max(100000),
  houseFeePercent: z.number().min(0).max(100).default(0),
  startsAt: z.string().datetime(),
  closesAt: z.string().datetime(),
  options: z.array(z.string().min(1).max(80)).min(2).max(12),
  groupId: z.string().uuid().optional()
});

const updateBetSchema = z.object({
  title: z.string().min(5).max(140),
  description: z.string().min(10).max(1200),
  sourceUrl: z.string().url().nullable().optional(),
  buyInCredits: z.number().positive().max(100000),
  closesAt: z.string().datetime(),
  options: z.array(z.string().min(1).max(80)).min(2).max(12)
});

const joinBetSchema = z.object({
  optionId: z.string().min(1)
});

const settleBetSchema = z.object({
  winningOptionId: z.string().min(1)
});

const rectifySettlementSchema = z.object({
  winningOptionId: z.string().min(1)
});

const adminCreditAdjustmentSchema = z.object({
  userId: z.string().uuid(),
  amountCredits: z.number().positive().max(10000),
  description: z.string().min(3).max(180).default("Admin credit adjustment")
});

const createRedemptionSchema = z.object({
  amountCredits: z.number().positive().max(10000),
  claimDetails: z.string().min(3).max(1000)
});

const updateRedemptionSchema = z.object({
  status: z.enum(["approved", "rejected"]),
  adminNote: z.string().max(1000).optional()
});

const createCreditRequestSchema = z.object({
  amountCredits: z.number().positive().max(10000),
  requestReason: z.string().min(3).max(1000)
});

const updateCreditRequestSchema = z.object({
  status: z.enum(["approved", "rejected"]),
  adminNote: z.string().max(1000).optional()
});

const chatMessageSchema = z.object({
  room: z.enum(["general", "side_bet"]).default("general"),
  sideBetId: z.string().uuid().nullable().optional(),
  body: z.string().trim().min(1).max(1000)
});

const reviewMembershipSchema = z.object({
  status: z.enum(["approved", "rejected"])
});

const groupAdminSchema = z.object({
  isGroupAdmin: z.boolean()
});

const addGroupMemberSchema = z.object({
  userId: z.string().uuid(),
  status: z.enum(["pending", "approved"]).default("approved"),
  isGroupAdmin: z.boolean().default(false)
});

const createGroupSchema = z.object({
  name: z.string().min(3).max(80),
  visibility: z.enum(["public", "private"]).default("private"),
  logoUrl: z.string().url().nullable().optional()
});

const STATION_ALPHA_GROUP_NAME = "Station Alpha";

type RealtimeNotifier = {
  sideBetChanged: (betId: string, reason: string) => Promise<void>;
  walletChanged: (userIds: string | string[], reason: string, detail?: { creditsBalance: number; transaction: unknown }) => Promise<void>;
  coinFlipChanged: () => Promise<void>;
  adminChanged: (reason: string) => Promise<void>;
  chatMessage: (message: ChatMessage) => Promise<void>;
};

export function createApiRouter(realtime: RealtimeNotifier) {
  const router = Router();

  router.get("/health", (_req, res) => {
    res.json({ ok: true, service: "side-bets" });
  });

  router.get("/me", requireAuth, async (req, res) => {
    const user = (req as AuthedRequest).user;
    const { data, error } = await supabaseAdmin
      .from("profiles")
      .select("id, display_name, email, avatar_url, credits_balance")
      .eq("id", user.id)
      .single();

    if (error) {
      if (isMissingRedemptionTable(error)) {
        res.json([]);
        return;
      }
      res.status(500).json({ error: error.message });
      return;
    }

    res.json({
      id: data.id,
      displayName: data.display_name,
      email: data.email,
      avatarUrl: data.avatar_url,
      creditsBalance: Number(data.credits_balance),
      isAdmin: user.isAdmin,
      isGroupAdmin: user.isGroupAdmin
    });
  });

  router.get("/chat/messages", requireAuth, async (req, res) => {
    const room = String(req.query.room ?? "general") as ChatRoom;
    const sideBetId = typeof req.query.sideBetId === "string" ? req.query.sideBetId : null;

    if (room !== "general" && room !== "side_bet") {
      res.status(400).json({ error: "Invalid chat room" });
      return;
    }

    let query = supabaseAdmin
      .from("chat_messages")
      .select("*, profiles!chat_messages_user_id_fkey(display_name, email)")
      .eq("room", room)
      .order("created_at", { ascending: false })
      .limit(50);

    if (room === "side_bet") {
      if (!sideBetId) {
        res.status(400).json({ error: "sideBetId is required for coin flip chat" });
        return;
      }
      if (!(await canViewSideBet(sideBetId, (req as AuthedRequest).user))) {
        res.status(403).json({ error: "You do not have access to this coin flip" });
        return;
      }
      query = query.eq("side_bet_id", sideBetId);
    } else {
      query = query.is("side_bet_id", null);
    }

    const { data, error } = await query;
    if (error) {
      if (isMissingChatMessagesTable(error)) {
        res.json([]);
        return;
      }
      res.status(500).json({ error: error.message });
      return;
    }

    res.json(data.map(mapChatMessage).reverse());
  });

  router.post("/chat/messages", requireAuth, async (req, res) => {
    const parsed = chatMessageSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const user = (req as AuthedRequest).user;
    const room = parsed.data.room;
    const sideBetId = room === "side_bet" ? parsed.data.sideBetId : null;

    if (room === "side_bet" && !sideBetId) {
      res.status(400).json({ error: "sideBetId is required for coin flip chat" });
      return;
    }
    if (sideBetId && !(await canViewSideBet(sideBetId, user))) {
      res.status(403).json({ error: "You do not have access to this coin flip" });
      return;
    }

    const { data, error } = await supabaseAdmin
      .from("chat_messages")
      .insert({
        room,
        side_bet_id: sideBetId,
        user_id: user.id,
        body: parsed.data.body
      })
      .select("*, profiles!chat_messages_user_id_fkey(display_name, email)")
      .single();

    if (error) {
      if (isMissingChatMessagesTable(error)) {
        res.status(503).json({ error: "Chat messages are not set up yet. Run supabase/migrations/0004_chat_messages.sql." });
        return;
      }
      res.status(500).json({ error: error.message });
      return;
    }

    const message = mapChatMessage(data);
    await realtime.chatMessage(message);
    res.status(201).json(message);
  });

  router.get("/groups", requireAuth, async (req, res) => {
    const user = (req as AuthedRequest).user;
    const { data, error } = await supabaseAdmin
      .from("groups")
      .select("*, group_memberships(user_id, status, is_group_admin)")
      .order("name", { ascending: true });

    if (error) {
      if (isMissingGroupsTable(error)) {
        res.json([]);
        return;
      }
      res.status(500).json({ error: error.message });
      return;
    }

    res.json(data.map((group) => mapGroup(group, user.id)));
  });

  router.post("/groups", requireAuth, async (req, res) => {
    const parsed = createGroupSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const user = (req as AuthedRequest).user;
    const { data: group, error } = await supabaseAdmin
      .from("groups")
      .insert({
        name: parsed.data.name,
        visibility: parsed.data.visibility,
        logo_url: parsed.data.logoUrl ?? null
      })
      .select("*")
      .single();

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    const { error: membershipError } = await supabaseAdmin.from("group_memberships").insert({
      group_id: group.id,
      user_id: user.id,
      status: "approved",
      is_group_admin: true,
      reviewed_by: user.id,
      reviewed_at: new Date().toISOString()
    });

    if (membershipError) {
      res.status(500).json({ error: membershipError.message });
      return;
    }

    await realtime.adminChanged("groups");
    res.status(201).json(mapGroup({ ...group, group_memberships: [{ user_id: user.id, status: "approved", is_group_admin: true }] }, user.id));
  });

  router.delete("/groups/:id", requireAuth, async (req, res) => {
    const user = (req as AuthedRequest).user;
    if (!(await canManageGroup(req.params.id, user))) {
      res.status(403).json({ error: "Group admin access required" });
      return;
    }

    const { error } = await supabaseAdmin.from("groups").delete().eq("id", req.params.id);
    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    await realtime.adminChanged("groups");
    res.json({ ok: true });
  });

  router.post("/groups/:id/join", requireAuth, async (req, res) => {
    const user = (req as AuthedRequest).user;
    const { data: group, error: groupError } = await supabaseAdmin.from("groups").select("*").eq("id", req.params.id).single();

    if (groupError || !group) {
      res.status(404).json({ error: "Group not found" });
      return;
    }

    const status = group.visibility === "private" ? "pending" : "approved";
    const { error } = await supabaseAdmin.from("group_memberships").upsert(
      {
        group_id: group.id,
        user_id: user.id,
        status,
        reviewed_at: status === "approved" ? new Date().toISOString() : null
      },
      { onConflict: "group_id,user_id" }
    );

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    await realtime.adminChanged("groups");
    res.status(201).json({ ok: true, status });
  });

  router.get("/groups/:id/members", requireAuth, async (req, res) => {
    const user = (req as AuthedRequest).user;
    if (!(await canManageGroup(req.params.id, user))) {
      res.status(403).json({ error: "Group admin access required" });
      return;
    }

    const { data, error } = await supabaseAdmin
      .from("group_memberships")
      .select("*, profiles!group_memberships_user_id_fkey(display_name, email)")
      .eq("group_id", req.params.id)
      .order("created_at", { ascending: false });

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    res.json(data.map(mapGroupMember));
  });

  router.post("/groups/:id/members", requireAuth, async (req, res) => {
    const parsed = addGroupMemberSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const user = (req as AuthedRequest).user;
    if (!(await canManageGroup(req.params.id, user))) {
      res.status(403).json({ error: "Group admin access required" });
      return;
    }

    const { data, error } = await supabaseAdmin
      .from("group_memberships")
      .upsert(
        {
          group_id: req.params.id,
          user_id: parsed.data.userId,
          status: parsed.data.status,
          is_group_admin: parsed.data.isGroupAdmin,
          reviewed_by: user.id,
          reviewed_at: new Date().toISOString()
        },
        { onConflict: "group_id,user_id" }
      )
      .select("*, profiles!group_memberships_user_id_fkey(display_name, email)")
      .single();

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    await realtime.adminChanged("groups");
    res.status(201).json(mapGroupMember(data));
  });

  router.patch("/groups/:id/members/:userId", requireAuth, async (req, res) => {
    const parsed = reviewMembershipSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const user = (req as AuthedRequest).user;
    if (!(await canManageGroup(req.params.id, user))) {
      res.status(403).json({ error: "Group admin access required" });
      return;
    }

    const { data, error } = await supabaseAdmin
      .from("group_memberships")
      .update({
        status: parsed.data.status,
        reviewed_by: user.id,
        reviewed_at: new Date().toISOString()
      })
      .eq("group_id", req.params.id)
      .eq("user_id", req.params.userId)
      .select("*, profiles!group_memberships_user_id_fkey(display_name, email)")
      .single();

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    await realtime.adminChanged("groups");
    res.json(mapGroupMember(data));
  });

  router.patch("/groups/:id/members/:userId/admin", requireAuth, async (req, res) => {
    const parsed = groupAdminSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const user = (req as AuthedRequest).user;
    if (!(await canManageGroup(req.params.id, user))) {
      res.status(403).json({ error: "Group admin access required" });
      return;
    }

    const { data, error } = await supabaseAdmin
      .from("group_memberships")
      .update({ is_group_admin: parsed.data.isGroupAdmin })
      .eq("group_id", req.params.id)
      .eq("user_id", req.params.userId)
      .select("*, profiles!group_memberships_user_id_fkey(display_name, email)")
      .single();

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    await realtime.adminChanged("groups");
    res.json(mapGroupMember(data));
  });

  router.delete("/groups/:id/members/:userId", requireAuth, async (req, res) => {
    const user = (req as AuthedRequest).user;
    if (!(await canManageGroup(req.params.id, user))) {
      res.status(403).json({ error: "Group admin access required" });
      return;
    }

    const { error } = await supabaseAdmin
      .from("group_memberships")
      .delete()
      .eq("group_id", req.params.id)
      .eq("user_id", req.params.userId);

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    await realtime.adminChanged("groups");
    res.json({ ok: true });
  });

  router.get("/side-bets", requireAuth, async (req, res) => {
    const user = (req as AuthedRequest).user;
    const search = String(req.query.search ?? "").trim();
    const status = String(req.query.status ?? "all");

    let query = supabaseAdmin
      .from("side_bets")
      .select("*, profiles!side_bets_manager_id_fkey(display_name), groups(name, visibility), bet_entries(id, side_bet_id, user_id, option_id, stake_credits, created_at)")
      .order("created_at", { ascending: false });

    if (search) {
      query = query.or(`title.ilike.%${search}%,description.ilike.%${search}%`);
    }

    if (status !== "all") {
      query = query.eq("status", status);
    }

    const { data, error } = await query;
    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    const visibleRows = [];
    for (const row of data) {
      if (await canViewGroup(row.group_id ?? null, user)) {
        visibleRows.push(row);
      }
    }

    res.json(visibleRows.map((row) => mapSideBet(row, user.id)));
  });

  router.get("/side-bets/:id", requireAuth, async (req, res) => {
    const { data, error } = await supabaseAdmin
      .from("side_bets")
      .select("*, profiles!side_bets_manager_id_fkey(display_name), groups(name, visibility), bet_entries(*, profiles!bet_entries_user_id_fkey(display_name, email))")
      .eq("id", req.params.id)
      .order("created_at", { referencedTable: "bet_entries", ascending: false })
      .single();

    if (error || !data) {
      res.status(404).json({ error: "Coin flip not found" });
      return;
    }

    const user = (req as AuthedRequest).user;
    if (!(await canViewGroup(data.group_id ?? null, user))) {
      res.status(403).json({ error: "You do not have access to this coin flip" });
      return;
    }
    res.json(mapSideBetDetail(data, user.id));
  });

  router.post("/side-bets", requireAuth, async (req, res) => {
    const parsed = createBetSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const user = (req as AuthedRequest).user;
    const options: BetOption[] = parsed.data.options.map((label) => ({ id: randomUUID(), label }));
    let groupId: string;
    try {
      groupId = await resolveCreateBetGroupId(parsed.data.groupId, user);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Select a group for this coin flip" });
      return;
    }

    const { data, error } = await supabaseAdmin
      .from("side_bets")
      .insert({
        manager_id: user.id,
        group_id: groupId,
        title: parsed.data.title,
        description: parsed.data.description,
        source_url: parsed.data.sourceUrl ?? null,
        buy_in_credits: parsed.data.buyInCredits,
        house_fee_percent: parsed.data.houseFeePercent,
        starts_at: parsed.data.startsAt,
        closes_at: parsed.data.closesAt,
        options
      })
      .select("*, profiles!side_bets_manager_id_fkey(display_name), groups(name, visibility), bet_entries(id, side_bet_id, user_id, option_id, stake_credits, created_at)")
      .single();

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    await realtime.sideBetChanged(data.id, "created");
    await realtime.adminChanged("side-bets");
    res.status(201).json(mapSideBet(data, user.id));
  });

  router.patch("/side-bets/:id", requireAuth, async (req, res) => {
    const parsed = updateBetSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const user = (req as AuthedRequest).user;
    const { data: bet, error: betError } = await supabaseAdmin
      .from("side_bets")
      .select("*, bet_entries(id)")
      .eq("id", req.params.id)
      .single();

    if (betError || !bet) {
      res.status(404).json({ error: "Coin flip not found" });
      return;
    }

    if (bet.manager_id !== user.id) {
      res.status(403).json({ error: "Only the coin flip creator can edit this coin flip" });
      return;
    }
    if (!(await canViewGroup(bet.group_id ?? null, user))) {
      res.status(403).json({ error: "You do not have access to this coin flip" });
      return;
    }

    if (bet.status !== "open") {
      res.status(409).json({ error: "Only open coin flips can be edited" });
      return;
    }

    if (new Date(parsed.data.closesAt).getTime() <= new Date(bet.starts_at).getTime()) {
      res.status(400).json({ error: "Close time must be after the start time" });
      return;
    }

    const hasEntries = (bet.bet_entries ?? []).length > 0;
    const currentOptions = bet.options as BetOption[];
    const nextOptions: BetOption[] = parsed.data.options.map((label) => ({ id: randomUUID(), label }));
    const currentOptionLabels = currentOptions.map((option) => option.label);
    const optionLabelsChanged = JSON.stringify(currentOptionLabels) !== JSON.stringify(parsed.data.options);
    const buyInChanged = Number(bet.buy_in_credits) !== parsed.data.buyInCredits;

    if (hasEntries && (optionLabelsChanged || buyInChanged)) {
      res.status(409).json({ error: "Buy-in and options cannot be changed after users have joined" });
      return;
    }

    const { data: updated, error: updateError } = await supabaseAdmin
      .from("side_bets")
      .update({
        title: parsed.data.title,
        description: parsed.data.description,
        source_url: parsed.data.sourceUrl ?? null,
        buy_in_credits: parsed.data.buyInCredits,
        closes_at: parsed.data.closesAt,
        options: hasEntries ? currentOptions : nextOptions
      })
      .eq("id", bet.id)
      .select("*, profiles!side_bets_manager_id_fkey(display_name), groups(name, visibility), bet_entries(*, profiles!bet_entries_user_id_fkey(display_name, email))")
      .order("created_at", { referencedTable: "bet_entries", ascending: false })
      .single();

    if (updateError) {
      res.status(500).json({ error: updateError.message });
      return;
    }

    await realtime.sideBetChanged(bet.id, "updated");
    res.json(mapSideBetDetail(updated, user.id));
  });

  router.post("/side-bets/:id/join", requireAuth, async (req, res) => {
    const parsed = joinBetSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const user = (req as AuthedRequest).user;
    const { data: bet, error: betError } = await supabaseAdmin.from("side_bets").select("*").eq("id", req.params.id).single();
    if (betError || !bet) {
      res.status(404).json({ error: "Coin flip not found" });
      return;
    }
    if (!(await canViewGroup(bet.group_id ?? null, user))) {
      res.status(403).json({ error: "You do not have access to this coin flip" });
      return;
    }

    if (bet.status !== "open" || new Date(bet.closes_at).getTime() <= Date.now()) {
      res.status(409).json({ error: "This coin flip is not open for entries" });
      return;
    }

    const option = (bet.options as BetOption[]).find((candidate) => candidate.id === parsed.data.optionId);
    if (!option) {
      res.status(400).json({ error: "Invalid option" });
      return;
    }

    const { data: existingEntry, error: existingEntryError } = await supabaseAdmin
      .from("bet_entries")
      .select("*")
      .eq("side_bet_id", bet.id)
      .eq("user_id", user.id)
      .maybeSingle();

    if (existingEntryError) {
      res.status(500).json({ error: existingEntryError.message });
      return;
    }

    if (existingEntry) {
      if (existingEntry.option_id !== option.id) {
        const { error: updateEntryError } = await supabaseAdmin.from("bet_entries").update({ option_id: option.id }).eq("id", existingEntry.id);

        if (updateEntryError) {
          res.status(500).json({ error: updateEntryError.message });
          return;
        }

        await realtime.sideBetChanged(bet.id, "entry-changed");
      }

      res.json({ ok: true, changed: existingEntry.option_id !== option.id });
      return;
    }

    const { data: profile, error: profileError } = await supabaseAdmin
      .from("profiles")
      .select("credits_balance")
      .eq("id", user.id)
      .single();
    if (profileError || !profile) {
      res.status(404).json({ error: "Profile not found" });
      return;
    }

    const buyIn = Number(bet.buy_in_credits);
    if (Number(profile.credits_balance) < buyIn) {
      res.status(402).json({ error: "Not enough credits" });
      return;
    }

    const { error: entryError } = await supabaseAdmin.from("bet_entries").insert({
      side_bet_id: bet.id,
      user_id: user.id,
      option_id: option.id,
      stake_credits: buyIn
    });

    if (entryError) {
      res.status(409).json({ error: entryError.message });
      return;
    }

    await supabaseAdmin
      .from("profiles")
      .update({ credits_balance: Number(profile.credits_balance) - buyIn })
      .eq("id", user.id);
    await supabaseAdmin.from("credit_transactions").insert({
      user_id: user.id,
      amount_credits: -buyIn,
      kind: "buy_in",
      description: `Buy-in for ${bet.title}`,
      side_bet_id: bet.id,
      created_by: user.id
    });

    await realtime.sideBetChanged(bet.id, "joined");
    await realtime.walletChanged(user.id, "buy-in");
    await realtime.adminChanged("transactions");
    res.status(201).json({ ok: true });
  });

  router.post("/side-bets/:id/settle", requireAuth, async (req, res) => {
    const parsed = settleBetSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const user = (req as AuthedRequest).user;
    const { data: bet, error: betError } = await supabaseAdmin.from("side_bets").select("*").eq("id", req.params.id).single();
    if (betError || !bet) {
      res.status(404).json({ error: "Coin flip not found" });
      return;
    }
    if (!(await canViewGroup(bet.group_id ?? null, user))) {
      res.status(403).json({ error: "You do not have access to this coin flip" });
      return;
    }

    if (bet.manager_id !== user.id && !user.isAdmin) {
      res.status(403).json({ error: "Only the manager or an admin can settle this coin flip" });
      return;
    }

    const entriesResponse = await supabaseAdmin.from("bet_entries").select("*").eq("side_bet_id", bet.id);
    if (entriesResponse.error) {
      res.status(500).json({ error: entriesResponse.error.message });
      return;
    }

    const entries = entriesResponse.data;
    const winners = entries.filter((entry) => entry.option_id === parsed.data.winningOptionId);
    const pot = entries.reduce((total, entry) => total + Number(entry.stake_credits), 0);
    const fee = pot * (Number(bet.house_fee_percent) / 100);
    const payout = winners.length > 0 ? (pot - fee) / winners.length : 0;

    for (const winner of winners) {
      const { data: profile } = await supabaseAdmin
        .from("profiles")
        .select("credits_balance")
        .eq("id", winner.user_id)
        .single();
      if (profile) {
        await supabaseAdmin
          .from("profiles")
          .update({ credits_balance: Number(profile.credits_balance) + payout })
          .eq("id", winner.user_id);
        await supabaseAdmin.from("credit_transactions").insert({
          user_id: winner.user_id,
          amount_credits: payout,
          kind: "payout",
          description: `Payout for ${bet.title}`,
          side_bet_id: bet.id,
          created_by: user.id
        });
      }
    }

    const { error: updateError } = await supabaseAdmin
      .from("side_bets")
      .update({
        status: "settled",
        winning_option_id: parsed.data.winningOptionId,
        settles_at: new Date().toISOString()
      })
      .eq("id", bet.id);

    if (updateError) {
      res.status(500).json({ error: updateError.message });
      return;
    }

    await realtime.sideBetChanged(bet.id, "settled");
    await realtime.walletChanged(
      winners.map((winner) => winner.user_id),
      "settlement"
    );
    await realtime.adminChanged("transactions");
    res.json({ ok: true, winners: winners.length, payoutCredits: payout, feeCredits: fee });
  });

  router.post("/admin/side-bets/:id/rectify", requireAuth, requireAdmin, async (req, res) => {
    const parsed = rectifySettlementSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const admin = (req as AuthedRequest).user;
    const { data: bet, error: betError } = await supabaseAdmin.from("side_bets").select("*").eq("id", req.params.id).single();
    if (betError || !bet) {
      res.status(404).json({ error: "Coin flip not found" });
      return;
    }

    if (bet.status !== "settled" || !bet.winning_option_id) {
      res.status(409).json({ error: "Only settled coin flips can be rectified" });
      return;
    }

    const options = bet.options as BetOption[];
    const correctedOption = options.find((option) => option.id === parsed.data.winningOptionId);
    if (!correctedOption) {
      res.status(400).json({ error: "Invalid corrected winning option" });
      return;
    }

    if (bet.winning_option_id === parsed.data.winningOptionId) {
      res.status(409).json({ error: "This option is already marked as the winner" });
      return;
    }

    const entriesResponse = await supabaseAdmin.from("bet_entries").select("*").eq("side_bet_id", bet.id);
    if (entriesResponse.error) {
      res.status(500).json({ error: entriesResponse.error.message });
      return;
    }

    const entries = entriesResponse.data;
    const pot = entries.reduce((total, entry) => total + Number(entry.stake_credits), 0);
    const fee = pot * (Number(bet.house_fee_percent) / 100);
    const distributablePot = pot - fee;
    const previousWinners = entries.filter((entry) => entry.option_id === bet.winning_option_id);
    const correctedWinners = entries.filter((entry) => entry.option_id === parsed.data.winningOptionId);
    const previousPayout = previousWinners.length > 0 ? distributablePot / previousWinners.length : 0;
    const correctedPayout = correctedWinners.length > 0 ? distributablePot / correctedWinners.length : 0;
    const deltas = new Map<string, number>();

    for (const winner of previousWinners) {
      deltas.set(winner.user_id, (deltas.get(winner.user_id) ?? 0) - previousPayout);
    }

    for (const winner of correctedWinners) {
      deltas.set(winner.user_id, (deltas.get(winner.user_id) ?? 0) + correctedPayout);
    }

    const payableDeltas = [...deltas.entries()].filter(([, amount]) => Math.abs(amount) > 0.0001);
    const affectedUserIds = payableDeltas.map(([userId]) => userId);
    if (affectedUserIds.length > 0) {
      const { data: profiles, error: profilesError } = await supabaseAdmin
        .from("profiles")
        .select("id, credits_balance")
        .in("id", affectedUserIds);

      if (profilesError || !profiles) {
        res.status(500).json({ error: profilesError?.message ?? "Could not load affected profiles" });
        return;
      }

      const balances = new Map(profiles.map((profile) => [profile.id, Number(profile.credits_balance)]));
      for (const [userId, delta] of payableDeltas) {
        const currentBalance = balances.get(userId);
        if (currentBalance === undefined) {
          res.status(404).json({ error: "Affected user profile not found" });
          return;
        }

        if (currentBalance + delta < 0) {
          res.status(409).json({
            error: "Cannot rectify automatically because a previous winner no longer has enough credits to reverse their payout"
          });
          return;
        }
      }

      for (const [userId, delta] of payableDeltas) {
        const nextBalance = (balances.get(userId) ?? 0) + delta;
        const { error: balanceError } = await supabaseAdmin.from("profiles").update({ credits_balance: nextBalance }).eq("id", userId);
        if (balanceError) {
          res.status(500).json({ error: balanceError.message });
          return;
        }

        const { error: transactionError } = await supabaseAdmin.from("credit_transactions").insert({
          user_id: userId,
          amount_credits: delta,
          kind: "adjustment",
          description: delta < 0 ? `Settlement rectification reversal for ${bet.title}` : `Settlement rectification payout for ${bet.title}`,
          side_bet_id: bet.id,
          created_by: admin.id
        });

        if (transactionError) {
          res.status(500).json({ error: transactionError.message });
          return;
        }
      }
    }

    const { error: updateError } = await supabaseAdmin
      .from("side_bets")
      .update({
        winning_option_id: parsed.data.winningOptionId,
        settles_at: new Date().toISOString()
      })
      .eq("id", bet.id);

    if (updateError) {
      res.status(500).json({ error: updateError.message });
      return;
    }

    await realtime.sideBetChanged(bet.id, "rectified");
    if (affectedUserIds.length > 0) {
      await realtime.walletChanged(affectedUserIds, "settlement-rectified");
    }
    await realtime.adminChanged("transactions");
    res.json({
      ok: true,
      previousWinnerCount: previousWinners.length,
      correctedWinnerCount: correctedWinners.length,
      previousPayoutCredits: previousPayout,
      correctedPayoutCredits: correctedPayout,
      feeCredits: fee
    });
  });

  router.get("/wallet/transactions", requireAuth, async (req, res) => {
    const user = (req as AuthedRequest).user;
    const { data, error } = await supabaseAdmin
      .from("credit_transactions")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    res.json(data.map(mapTransaction));
  });

  router.get("/wallet/redemptions", requireAuth, async (req, res) => {
    const user = (req as AuthedRequest).user;
    const { data, error } = await supabaseAdmin
      .from("redemption_requests")
      .select("*, profiles!redemption_requests_user_id_fkey(display_name, email)")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(25);

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    res.json(data.map(mapRedemptionRequest));
  });

  router.get("/wallet/credit-requests", requireAuth, async (req, res) => {
    const user = (req as AuthedRequest).user;
    const { data, error } = await supabaseAdmin
      .from("credit_requests")
      .select("*, profiles!credit_requests_user_id_fkey(display_name, email)")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(25);

    if (error) {
      if (isMissingCreditRequestTable(error)) {
        res.json([]);
        return;
      }
      res.status(500).json({ error: error.message });
      return;
    }

    res.json(data.map(mapCreditRequest));
  });

  router.post("/wallet/redemptions", requireAuth, async (req, res) => {
    const parsed = createRedemptionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const user = (req as AuthedRequest).user;
    const { data: profile, error: profileError } = await supabaseAdmin
      .from("profiles")
      .select("credits_balance")
      .eq("id", user.id)
      .single();

    if (profileError || !profile) {
      res.status(404).json({ error: "Profile not found" });
      return;
    }

    const amount = parsed.data.amountCredits;
    const currentBalance = Number(profile.credits_balance);
    if (currentBalance < amount) {
      res.status(402).json({ error: "Not enough credits to redeem" });
      return;
    }

    const nextBalance = currentBalance - amount;
    const { error: balanceError } = await supabaseAdmin
      .from("profiles")
      .update({ credits_balance: nextBalance })
      .eq("id", user.id);

    if (balanceError) {
      res.status(500).json({ error: balanceError.message });
      return;
    }

    const { data: redemption, error: redemptionError } = await supabaseAdmin
      .from("redemption_requests")
      .insert({
        user_id: user.id,
        amount_credits: amount,
        claim_details: parsed.data.claimDetails
      })
      .select("*, profiles!redemption_requests_user_id_fkey(display_name, email)")
      .single();

    if (redemptionError) {
      await supabaseAdmin.from("profiles").update({ credits_balance: currentBalance }).eq("id", user.id);
      if (isMissingRedemptionTable(redemptionError)) {
        res.status(503).json({ error: "Redemption requests are not set up yet. Run supabase/migrations/0002_redemption_requests.sql." });
        return;
      }
      res.status(500).json({ error: redemptionError.message });
      return;
    }

    const { error: transactionError } = await supabaseAdmin.from("credit_transactions").insert({
      user_id: user.id,
      amount_credits: -amount,
      kind: "withdrawal",
      description: "Redemption request",
      created_by: user.id
    });

    if (transactionError) {
      res.status(500).json({ error: transactionError.message });
      return;
    }

    await realtime.walletChanged(user.id, "redemption-requested");
    await realtime.adminChanged("redemptions");
    res.status(201).json(mapRedemptionRequest(redemption));
  });

  router.post("/wallet/credit-requests", requireAuth, async (req, res) => {
    const parsed = createCreditRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const user = (req as AuthedRequest).user;
    const { data, error } = await supabaseAdmin
      .from("credit_requests")
      .insert({
        user_id: user.id,
        amount_credits: parsed.data.amountCredits,
        request_reason: parsed.data.requestReason
      })
      .select("*, profiles!credit_requests_user_id_fkey(display_name, email)")
      .single();

    if (error) {
      if (isMissingCreditRequestTable(error)) {
        res.status(503).json({ error: "Credit requests are not set up yet. Run supabase/migrations/0003_credit_requests.sql." });
        return;
      }
      res.status(500).json({ error: error.message });
      return;
    }

    await realtime.adminChanged("credit-requests");
    res.status(201).json(mapCreditRequest(data));
  });

  router.get("/admin/summary", requireAuth, requireCreditAdmin, async (_req, res) => {
    const [profiles, bets, openBets, transactions] = await Promise.all([
      supabaseAdmin.from("profiles").select("credits_balance", { count: "exact" }),
      supabaseAdmin.from("side_bets").select("id", { count: "exact", head: true }),
      supabaseAdmin.from("side_bets").select("id", { count: "exact", head: true }).eq("status", "open"),
      supabaseAdmin.from("credit_transactions").select("id", { count: "exact", head: true })
    ]);

    const summary: AdminSummary = {
      totalUsers: profiles.count ?? profiles.data?.length ?? 0,
      totalBets: bets.count ?? 0,
      openBets: openBets.count ?? 0,
      totalCredits: (profiles.data ?? []).reduce((total, profile) => total + Number(profile.credits_balance), 0),
      totalTransactions: transactions.count ?? 0
    };

    res.json(summary);
  });

  router.get("/admin/users", requireAuth, requireCreditAdmin, async (_req, res) => {
    const { data, error } = await supabaseAdmin
      .from("profiles")
      .select("id, display_name, email, credits_balance")
      .order("display_name", { ascending: true });

    if (error) {
      if (isMissingRedemptionTable(error)) {
        res.json([]);
        return;
      }
      res.status(500).json({ error: error.message });
      return;
    }

    const users: AdminUser[] = data.map((profile) => ({
      id: profile.id,
      displayName: profile.display_name,
      email: profile.email,
      creditsBalance: Number(profile.credits_balance)
    }));

    res.json(users);
  });

  router.post("/admin/credits", requireAuth, requireCreditAdmin, async (req, res) => {
    const parsed = adminCreditAdjustmentSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const admin = (req as AuthedRequest).user;
    const { data: profile, error: profileError } = await supabaseAdmin
      .from("profiles")
      .select("credits_balance")
      .eq("id", parsed.data.userId)
      .single();

    if (profileError || !profile) {
      res.status(404).json({ error: "User profile not found" });
      return;
    }

    const nextBalance = Number(profile.credits_balance) + parsed.data.amountCredits;
    const { error: updateError } = await supabaseAdmin
      .from("profiles")
      .update({ credits_balance: nextBalance })
      .eq("id", parsed.data.userId);

    if (updateError) {
      res.status(500).json({ error: updateError.message });
      return;
    }

    const { error: transactionError } = await supabaseAdmin.from("credit_transactions").insert({
      user_id: parsed.data.userId,
      amount_credits: parsed.data.amountCredits,
      kind: "adjustment",
      description: parsed.data.description,
      created_by: admin.id
    });

    if (transactionError) {
      res.status(500).json({ error: transactionError.message });
      return;
    }

    await realtime.walletChanged(parsed.data.userId, "admin-credit-adjustment");
    await realtime.adminChanged("credits");
    res.status(201).json({ ok: true, creditsBalance: nextBalance });
  });

  router.get("/admin/transactions", requireAuth, requireCreditAdmin, async (_req, res) => {
    const { data, error } = await supabaseAdmin
      .from("credit_transactions")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }
    res.json(data.map(mapTransaction));
  });

  router.get("/admin/redemptions", requireAuth, requireCreditAdmin, async (_req, res) => {
    const { data, error } = await supabaseAdmin
      .from("redemption_requests")
      .select("*, profiles!redemption_requests_user_id_fkey(display_name, email)")
      .order("created_at", { ascending: false })
      .limit(100);

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    res.json(data.map(mapRedemptionRequest));
  });

  router.get("/admin/credit-requests", requireAuth, requireCreditAdmin, async (_req, res) => {
    const { data, error } = await supabaseAdmin
      .from("credit_requests")
      .select("*, profiles!credit_requests_user_id_fkey(display_name, email)")
      .order("created_at", { ascending: false })
      .limit(100);

    if (error) {
      if (isMissingCreditRequestTable(error)) {
        res.json([]);
        return;
      }
      res.status(500).json({ error: error.message });
      return;
    }

    res.json(data.map(mapCreditRequest));
  });

  router.patch("/admin/redemptions/:id", requireAuth, requireCreditAdmin, async (req, res) => {
    const parsed = updateRedemptionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const admin = (req as AuthedRequest).user;
    const { data: redemption, error: redemptionError } = await supabaseAdmin
      .from("redemption_requests")
      .select("*")
      .eq("id", req.params.id)
      .single();

    if (redemptionError || !redemption) {
      if (redemptionError && isMissingRedemptionTable(redemptionError)) {
        res.status(503).json({ error: "Redemption requests are not set up yet. Run supabase/migrations/0002_redemption_requests.sql." });
        return;
      }
      res.status(404).json({ error: "Redemption request not found" });
      return;
    }

    if (redemption.status !== "pending") {
      res.status(409).json({ error: "This redemption request has already been reviewed" });
      return;
    }

    if (parsed.data.status === "rejected") {
      const { data: profile, error: profileError } = await supabaseAdmin
        .from("profiles")
        .select("credits_balance")
        .eq("id", redemption.user_id)
        .single();

      if (profileError || !profile) {
        res.status(404).json({ error: "User profile not found" });
        return;
      }

      const refund = Number(redemption.amount_credits);
      const { error: refundError } = await supabaseAdmin
        .from("profiles")
        .update({ credits_balance: Number(profile.credits_balance) + refund })
        .eq("id", redemption.user_id);

      if (refundError) {
        res.status(500).json({ error: refundError.message });
        return;
      }

      await supabaseAdmin.from("credit_transactions").insert({
        user_id: redemption.user_id,
        amount_credits: refund,
        kind: "adjustment",
        description: "Rejected redemption refund",
        created_by: admin.id
      });
    }

    const { data: updated, error: updateError } = await supabaseAdmin
      .from("redemption_requests")
      .update({
        status: parsed.data.status,
        admin_note: parsed.data.adminNote ?? null,
        reviewed_by: admin.id,
        reviewed_at: new Date().toISOString()
      })
      .eq("id", redemption.id)
      .select("*, profiles!redemption_requests_user_id_fkey(display_name, email)")
      .single();

    if (updateError) {
      res.status(500).json({ error: updateError.message });
      return;
    }

    if (parsed.data.status === "rejected") {
      await realtime.walletChanged(redemption.user_id, "redemption-refunded");
    }
    await realtime.adminChanged("redemptions");
    res.json(mapRedemptionRequest(updated));
  });

  router.patch("/admin/credit-requests/:id", requireAuth, requireCreditAdmin, async (req, res) => {
    const parsed = updateCreditRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const admin = (req as AuthedRequest).user;
    const { data: creditRequest, error: requestError } = await supabaseAdmin
      .from("credit_requests")
      .select("*")
      .eq("id", req.params.id)
      .single();

    if (requestError || !creditRequest) {
      if (requestError && isMissingCreditRequestTable(requestError)) {
        res.status(503).json({ error: "Credit requests are not set up yet. Run supabase/migrations/0003_credit_requests.sql." });
        return;
      }
      res.status(404).json({ error: "Credit request not found" });
      return;
    }

    if (creditRequest.status !== "pending") {
      res.status(409).json({ error: "This credit request has already been reviewed" });
      return;
    }

    if (parsed.data.status === "approved") {
      const { data: profile, error: profileError } = await supabaseAdmin
        .from("profiles")
        .select("credits_balance")
        .eq("id", creditRequest.user_id)
        .single();

      if (profileError || !profile) {
        res.status(404).json({ error: "User profile not found" });
        return;
      }

      const amount = Number(creditRequest.amount_credits);
      const { error: balanceError } = await supabaseAdmin
        .from("profiles")
        .update({ credits_balance: Number(profile.credits_balance) + amount })
        .eq("id", creditRequest.user_id);

      if (balanceError) {
        res.status(500).json({ error: balanceError.message });
        return;
      }

      const { error: transactionError } = await supabaseAdmin.from("credit_transactions").insert({
        user_id: creditRequest.user_id,
        amount_credits: amount,
        kind: "adjustment",
        description: "Approved credit request",
        created_by: admin.id
      });

      if (transactionError) {
        res.status(500).json({ error: transactionError.message });
        return;
      }
    }

    const { data: updated, error: updateError } = await supabaseAdmin
      .from("credit_requests")
      .update({
        status: parsed.data.status,
        admin_note: parsed.data.adminNote ?? null,
        reviewed_by: admin.id,
        reviewed_at: new Date().toISOString()
      })
      .eq("id", creditRequest.id)
      .select("*, profiles!credit_requests_user_id_fkey(display_name, email)")
      .single();

    if (updateError) {
      res.status(500).json({ error: updateError.message });
      return;
    }

    if (parsed.data.status === "approved") {
      await realtime.walletChanged(creditRequest.user_id, "credit-request-approved");
    }
    await realtime.adminChanged("credit-requests");
    res.json(mapCreditRequest(updated));
  });

  router.get("/coin-flip", requireAuth, async (req, res) => {
    try {
      res.json(await getCoinFlipState((req as AuthedRequest).user.id));
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Coin flip unavailable" });
    }
  });

  router.post("/coin-flip/stake", requireAuth, async (req, res) => {
    const optionId = req.body?.optionId;
    if (optionId !== "heads" && optionId !== "tails" && optionId !== "edge") {
      res.status(400).json({ error: "Pick heads, tails, or edge" });
      return;
    }
    try {
      res.json(await stakeCoinFlip((req as AuthedRequest).user.id, optionId, realtime));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Stake failed";
      const status = message === "Not enough credits" ? 402 : 400;
      res.status(status).json({ error: message });
    }
  });

  return router;
}

function mapRedemptionRequest(row: {
  id: string;
  user_id: string;
  amount_credits: string | number;
  status: RedemptionStatus;
  claim_details: string;
  admin_note: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
  profiles?: { display_name: string; email: string | null } | null;
}): RedemptionRequest {
  return {
    id: row.id,
    userId: row.user_id,
    userName: row.profiles?.display_name ?? "Unknown user",
    userEmail: row.profiles?.email ?? null,
    amountCredits: Number(row.amount_credits),
    status: row.status,
    claimDetails: row.claim_details,
    adminNote: row.admin_note,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    createdAt: row.created_at
  };
}

function mapCreditRequest(row: {
  id: string;
  user_id: string;
  amount_credits: string | number;
  status: CreditRequestStatus;
  request_reason: string;
  admin_note: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
  profiles?: { display_name: string; email: string | null } | null;
}): CreditRequest {
  return {
    id: row.id,
    userId: row.user_id,
    userName: row.profiles?.display_name ?? "Unknown user",
    userEmail: row.profiles?.email ?? null,
    amountCredits: Number(row.amount_credits),
    status: row.status,
    requestReason: row.request_reason,
    adminNote: row.admin_note,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    createdAt: row.created_at
  };
}

function mapChatMessage(row: {
  id: string;
  room: ChatRoom;
  side_bet_id: string | null;
  user_id: string;
  body: string;
  created_at: string;
  profiles?: { display_name: string; email: string | null } | null;
}): ChatMessage {
  return {
    id: row.id,
    room: row.room,
    sideBetId: row.side_bet_id,
    userId: row.user_id,
    userName: row.profiles?.display_name ?? "Unknown user",
    userEmail: row.profiles?.email ?? null,
    body: row.body,
    createdAt: row.created_at
  };
}

function mapGroup(row: {
  id: string;
  name: string;
  logo_url?: string | null;
  visibility: Group["visibility"];
  created_at: string;
  group_memberships?: { user_id: string; status: Group["membershipStatus"]; is_group_admin: boolean }[];
}, currentUserId: string): Group {
  const memberships = row.group_memberships ?? [];
  const currentMembership = memberships.find((membership) => membership.user_id === currentUserId);
  return {
    id: row.id,
    name: row.name,
    logoUrl: row.logo_url ?? null,
    visibility: row.visibility,
    memberCount: memberships.filter((membership) => membership.status === "approved").length,
    membershipStatus: currentMembership?.status ?? "none",
    isGroupAdmin: Boolean(currentMembership?.is_group_admin && currentMembership.status === "approved"),
    createdAt: row.created_at
  };
}

function mapGroupMember(row: {
  group_id: string;
  user_id: string;
  status: GroupMember["status"];
  is_group_admin: boolean;
  created_at: string;
  reviewed_at: string | null;
  profiles?: { display_name: string; email: string | null } | null;
}): GroupMember {
  return {
    groupId: row.group_id,
    userId: row.user_id,
    userName: row.profiles?.display_name ?? "Unknown user",
    userEmail: row.profiles?.email ?? null,
    status: row.status,
    isGroupAdmin: row.is_group_admin,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at
  };
}

async function getStationAlphaGroupId() {
  const { data, error } = await supabaseAdmin.from("groups").select("id").eq("name", STATION_ALPHA_GROUP_NAME).single();
  if (error || !data) {
    throw new Error("Station Alpha group is not set up. Run supabase/migrations/0005_groups.sql.");
  }
  return data.id as string;
}

async function canViewSideBet(sideBetId: string, user: AuthedRequest["user"]) {
  const { data, error } = await supabaseAdmin.from("side_bets").select("group_id").eq("id", sideBetId).single();
  if (error || !data) return false;
  return canViewGroup(data.group_id ?? null, user);
}

async function getCreatableGroupIds(user: AuthedRequest["user"]) {
  if (user.isAdmin) {
    const { data, error } = await supabaseAdmin.from("groups").select("id").order("name", { ascending: true });
    if (error) {
      throw new Error("Groups are not set up yet. Run supabase/migrations/0005_groups.sql.");
    }
    return (data ?? []).map((row) => row.id as string);
  }

  const { data, error } = await supabaseAdmin
    .from("group_memberships")
    .select("group_id")
    .eq("user_id", user.id)
    .eq("status", "approved")
    .order("group_id", { ascending: true });

  if (error) {
    throw new Error("Groups are not set up yet. Run supabase/migrations/0005_groups.sql.");
  }

  return (data ?? []).map((row) => row.group_id as string);
}

async function canCreateBetInGroup(groupId: string, user: AuthedRequest["user"]) {
  if (user.isAdmin) return true;

  const { data } = await supabaseAdmin
    .from("group_memberships")
    .select("user_id")
    .eq("group_id", groupId)
    .eq("user_id", user.id)
    .eq("status", "approved")
    .maybeSingle();

  return Boolean(data);
}

async function resolveCreateBetGroupId(groupId: string | undefined, user: AuthedRequest["user"]) {
  if (groupId) {
    if (!(await canCreateBetInGroup(groupId, user))) {
      throw new Error("You do not have permission to create coin flips in this group");
    }
    return groupId;
  }

  const creatableGroupIds = await getCreatableGroupIds(user);
  if (creatableGroupIds.length === 1) {
    return creatableGroupIds[0];
  }
  if (creatableGroupIds.length === 0) {
    const stationAlphaGroupId = await getStationAlphaGroupId();
    if (await canCreateBetInGroup(stationAlphaGroupId, user)) {
      return stationAlphaGroupId;
    }
    throw new Error("Join a group before creating a coin flip");
  }

  throw new Error("Select a group for this coin flip");
}

async function canViewGroup(groupId: string | null, user: AuthedRequest["user"]) {
  if (!groupId || user.isAdmin) return true;
  const { data: group } = await supabaseAdmin.from("groups").select("visibility").eq("id", groupId).single();
  if (group?.visibility === "public") return true;
  const { data: membership } = await supabaseAdmin
    .from("group_memberships")
    .select("status")
    .eq("group_id", groupId)
    .eq("user_id", user.id)
    .eq("status", "approved")
    .maybeSingle();
  return Boolean(membership);
}

async function canManageGroup(groupId: string, user: AuthedRequest["user"]) {
  if (user.isAdmin) return true;
  const { data } = await supabaseAdmin
    .from("group_memberships")
    .select("user_id")
    .eq("group_id", groupId)
    .eq("user_id", user.id)
    .eq("status", "approved")
    .eq("is_group_admin", true)
    .maybeSingle();
  return Boolean(data);
}

function isMissingRedemptionTable(error: { code?: string; message?: string }) {
  return (
    error.code === "42P01" ||
    error.message?.includes("redemption_requests") ||
    error.message?.includes("schema cache") ||
    false
  );
}

function isMissingGroupsTable(error: { code?: string; message?: string }) {
  return error.code === "42P01" || error.message?.includes("groups") || error.message?.includes("schema cache") || false;
}

function isMissingCreditRequestTable(error: { code?: string; message?: string }) {
  return (
    error.code === "42P01" ||
    error.message?.includes("credit_requests") ||
    error.message?.includes("schema cache") ||
    false
  );
}

function isMissingChatMessagesTable(error: { code?: string; message?: string }) {
  return (
    error.code === "42P01" ||
    error.message?.includes("chat_messages") ||
    error.message?.includes("schema cache") ||
    false
  );
}

function mapTransaction(row: {
  id: string;
  user_id: string;
  amount_credits: string | number;
  kind: CreditTransaction["kind"];
  description: string;
  side_bet_id: string | null;
  created_at: string;
}): CreditTransaction {
  return {
    id: row.id,
    userId: row.user_id,
    amountCredits: Number(row.amount_credits),
    kind: row.kind,
    description: row.description,
    sideBetId: row.side_bet_id,
    createdAt: row.created_at
  };
}

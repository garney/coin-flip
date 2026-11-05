import type { Server } from "socket.io";
import { supabaseAdmin } from "../supabase.js";
import type { BlackjackTableManager } from "./tableManager.js";

export function registerBlackjackSockets(io: Server, tables: BlackjackTableManager) {
  io.on("connection", (socket) => {
    const userId = socket.data.userId as string;
    const displayName = (socket.data.displayName as string) || "Player";
    const isPlatformAdmin = Boolean(socket.data.isAdmin);

    socket.on("blackjack:join-group", (payload, ack?: (r: unknown) => void) => {
      const groupId = payload?.groupId ? String(payload.groupId) : "";
      if (!groupId) {
        ack?.({ ok: false, error: "Missing groupId" });
        return;
      }
      tables.joinLobby(socket.id, groupId, io);
      socket.data.blackjackGroupId = groupId;
      socket.emit("blackjack:lobby", tables.listLobby(groupId));
      const mine = tables.getTableForUser(userId);
      if (mine && mine.groupId === groupId) {
        tables.watchTable(mine.id, socket.id, io);
        socket.emit("blackjack:state", mine);
      }
      ack?.({ ok: true, lobby: tables.listLobby(groupId) });
    });

    socket.on("blackjack:watch", (payload, ack?: (r: unknown) => void) => {
      const tableId = payload?.tableId ? String(payload.tableId) : null;
      if (!tableId) {
        ack?.({ ok: false, error: "Missing tableId" });
        return;
      }
      tables.watchTable(tableId, socket.id, io);
      const table = tables.getPublicTable(tableId);
      if (table) socket.emit("blackjack:state", table);
      ack?.({ ok: Boolean(table), table });
    });

    socket.on("blackjack:create-table", async (payload, ack?: (r: unknown) => void) => {
      try {
        const table = await tables.createLiveTable(
          userId,
          displayName,
          {
            title: String(payload?.title ?? "My table"),
            minBet: Number(payload?.minBet ?? 5),
            maxBet: Number(payload?.maxBet ?? 50),
            bankroll: Number(payload?.bankroll ?? 500),
            groupId: String(payload?.groupId ?? "")
          },
          isPlatformAdmin
        );
        tables.watchTable(table.id, socket.id, io);
        ack?.({ ok: true, table });
      } catch (error) {
        ack?.({ ok: false, error: error instanceof Error ? error.message : "Failed" });
      }
    });

    socket.on("blackjack:join-practice", async (payload, ack?: (r: unknown) => void) => {
      try {
        const groupId = String(payload?.groupId ?? socket.data.blackjackGroupId ?? "");
        const table = await tables.joinPractice(userId, displayName, groupId, isPlatformAdmin);
        tables.watchTable(table.id, socket.id, io);
        ack?.({ ok: true, table });
      } catch (error) {
        ack?.({ ok: false, error: error instanceof Error ? error.message : "Failed" });
      }
    });

    socket.on("blackjack:join", async (payload, ack?: (r: unknown) => void) => {
      try {
        const table = await tables.joinTable(userId, displayName, String(payload?.tableId), isPlatformAdmin);
        tables.watchTable(table.id, socket.id, io);
        ack?.({ ok: true, table });
      } catch (error) {
        ack?.({ ok: false, error: error instanceof Error ? error.message : "Failed" });
      }
    });

    socket.on("blackjack:leave", (_payload, ack?: (r: unknown) => void) => {
      try {
        tables.leaveTable(userId);
        ack?.({ ok: true });
      } catch (error) {
        ack?.({ ok: false, error: error instanceof Error ? error.message : "Failed" });
      }
    });

    socket.on("blackjack:leave-host", (_payload, ack?: (r: unknown) => void) => {
      try {
        tables.leaveHost(userId);
        ack?.({ ok: true });
      } catch (error) {
        ack?.({ ok: false, error: error instanceof Error ? error.message : "Failed" });
      }
    });

    socket.on("blackjack:end-table", async (_payload, ack?: (r: unknown) => void) => {
      try {
        await tables.endTable(userId);
        ack?.({ ok: true });
      } catch (error) {
        ack?.({ ok: false, error: error instanceof Error ? error.message : "Failed" });
      }
    });

    socket.on("blackjack:start-betting", (_payload, ack?: (r: unknown) => void) => {
      try {
        tables.startBetting(userId);
        ack?.({ ok: true });
      } catch (error) {
        ack?.({ ok: false, error: error instanceof Error ? error.message : "Failed" });
      }
    });

    socket.on("blackjack:bet", async (payload, ack?: (r: unknown) => void) => {
      try {
        await tables.placeBet(userId, Number(payload?.amount));
        ack?.({ ok: true });
      } catch (error) {
        ack?.({ ok: false, error: error instanceof Error ? error.message : "Failed" });
      }
    });

    socket.on("blackjack:deal", async (_payload, ack?: (r: unknown) => void) => {
      try {
        await tables.dealRound(userId);
        ack?.({ ok: true });
      } catch (error) {
        ack?.({ ok: false, error: error instanceof Error ? error.message : "Failed" });
      }
    });

    socket.on("blackjack:hit", (_payload, ack?: (r: unknown) => void) => {
      try {
        tables.hit(userId);
        ack?.({ ok: true });
      } catch (error) {
        ack?.({ ok: false, error: error instanceof Error ? error.message : "Failed" });
      }
    });

    socket.on("blackjack:stand", (_payload, ack?: (r: unknown) => void) => {
      try {
        tables.stand(userId);
        ack?.({ ok: true });
      } catch (error) {
        ack?.({ ok: false, error: error instanceof Error ? error.message : "Failed" });
      }
    });
  });
}

export async function enrichSocketUser(socket: import("socket.io").Socket, userId: string) {
  const { data } = await supabaseAdmin.from("profiles").select("display_name").eq("id", userId).maybeSingle();
  socket.data.displayName = data?.display_name?.trim() || "Player";
}

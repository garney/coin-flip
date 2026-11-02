import type { Server as HttpServer } from "node:http";
import { Server } from "socket.io";
import { getCoinFlipState, type CoinOutcome } from "./coinFlip.js";
import { config } from "./config.js";
import { supabaseAdmin, supabaseAuth } from "./supabase.js";

export function createSocketServer(
  httpServer: HttpServer,
  stake: (userId: string, optionId: CoinOutcome) => Promise<Awaited<ReturnType<typeof getCoinFlipState>>>
) {
  const io = new Server(httpServer, {
    cors: {
      origin: true,
      credentials: true
    }
  });

  io.use(async (socket, next) => {
    const token = socket.handshake.auth.token;
    if (typeof token !== "string") {
      next(new Error("Missing auth token"));
      return;
    }

    const { data, error } = await supabaseAuth.auth.getUser(token);
    if (error || !data.user) {
      next(new Error("Invalid auth token"));
      return;
    }

    const { data: adminRow } = await supabaseAdmin.from("admin_users").select("user_id").eq("user_id", data.user.id).maybeSingle();

    socket.data.userId = data.user.id;
    socket.data.isAdmin = Boolean(adminRow) || config.adminUserIds.has(data.user.id);
    next();
  });

  io.on("connection", (socket) => {
    socket.join("side-bets");
    socket.join("coin-flip");
    socket.join("chat:general");
    socket.join(`user:${socket.data.userId}`);
    void getCoinFlipState(socket.data.userId)
      .then((state) => socket.emit("coin-flip:state", state))
      .catch((error) => console.error("Coin flip state failed", error));
    if (socket.data.isAdmin) {
      socket.join("admin");
    }

    socket.on("coin-flip:stake", async (payload: { optionId?: unknown }, ack?: (result: unknown) => void) => {
      if (typeof ack !== "function") return;
      const optionId = payload?.optionId;
      if (optionId !== "heads" && optionId !== "tails" && optionId !== "edge") {
        ack({ ok: false, error: "Pick heads, tails, or edge" });
        return;
      }
      try {
        const state = await stake(socket.data.userId, optionId);
        ack({ ok: true, state });
      } catch (error) {
        ack({ ok: false, error: error instanceof Error ? error.message : "Stake failed" });
      }
    });

    socket.on("side-bet:watch", (payload: { betId?: unknown }) => {
      if (typeof payload.betId !== "string") return;
      socket.join(`side-bet:${payload.betId}`);
    });

    socket.on("side-bet:unwatch", (payload: { betId?: unknown }) => {
      if (typeof payload.betId !== "string") return;
      socket.leave(`side-bet:${payload.betId}`);
    });

    socket.on("chat:watch", (payload: { sideBetId?: string }) => {
      if (typeof payload?.sideBetId === "string") {
        socket.join(`chat:side-bet:${payload.sideBetId}`);
      }
    });

    socket.on("chat:unwatch", (payload: { sideBetId?: string }) => {
      if (typeof payload?.sideBetId === "string") {
        socket.leave(`chat:side-bet:${payload.sideBetId}`);
      }
    });

    socket.emit("connected", { userId: socket.data.userId, isAdmin: socket.data.isAdmin });
  });

  return io;
}

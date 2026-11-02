import path from "node:path";
import http from "node:http";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import { getCoinFlipState, settleDueCoinFlips, stakeCoinFlip } from "./coinFlip.js";
import { createApiRouter } from "./routes.js";
import { assertServerConfig, config } from "./config.js";
import { createSocketServer } from "./socket.js";
import type { ChatMessage } from "../shared/types.js";

assertServerConfig();

const app = express();
const server = http.createServer(app);
const io = createSocketServer(server, (userId, optionId) => stakeCoinFlip(userId, optionId, realtime));

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "1mb" }));

const realtime = {
  async sideBetChanged(betId: string, reason: string) {
    io.to("side-bets").to(`side-bet:${betId}`).emit("side-bet:changed", { betId, reason });
  },
  async walletChanged(userIds: string | string[], reason: string, detail?: { creditsBalance: number; transaction: unknown }) {
    const ids = Array.isArray(userIds) ? userIds : [userIds];
    for (const userId of [...new Set(ids)]) {
      io.to(`user:${userId}`).emit("wallet:changed", detail ? { reason, ...detail } : { reason });
    }
  },
  async coinFlipChanged() {
    const state = await getCoinFlipState("");
    io.to("coin-flip").emit("coin-flip:state", { ...state, myOption: null });
  },
  async adminChanged(reason: string) {
    io.to("admin").emit("admin:changed", { reason });
  },
  async chatMessage(message: ChatMessage) {
    if (message.room === "side_bet" && message.sideBetId) {
      io.to(`chat:side-bet:${message.sideBetId}`).emit("chat:message", message);
      return;
    }

    io.to("chat:general").emit("chat:message", message);
  }
};

app.use("/api", createApiRouter(realtime));

if (config.nodeEnv === "production") {
  const clientDist = path.resolve(process.cwd(), "client/dist");
  app.use(express.static(clientDist));
  app.get("*", (_req, res) => res.sendFile(path.join(clientDist, "index.html")));
} else {
  const { createServer } = await import("vite");
  const vite = await createServer({
    server: { middlewareMode: true },
    appType: "spa",
    root: path.resolve(process.cwd(), "client")
  });
  // Dev-only coin test bench. Production serves client/dist, which never contains it.
  app.get(/^\/dev\/coin$/, (_req, res) => res.redirect("/dev/coin/"));
  app.use(vite.middlewares);
}

server.listen(config.port, "0.0.0.0", () => {
  console.log(`Coin flip listening on http://0.0.0.0:${config.port}`);
});

let publishedCoinFlip = "";
setInterval(() => {
  void (async () => {
    await settleDueCoinFlips(realtime);
    const state = await getCoinFlipState("");
    const signature = `${state.startsAt}|${state.status}|${state.sideBetId}|${state.winningOptionId}|${state.counts.heads}|${state.counts.tails}|${state.counts.edge}|${state.previous.winningOptionId}|${state.result}`;
    if (signature === publishedCoinFlip) return;
    publishedCoinFlip = signature;
    io.to("coin-flip").emit("coin-flip:state", { ...state, myOption: null });
  })().catch((error) => {
    console.error("Coin flip settlement failed", error);
  });
}, 2000);

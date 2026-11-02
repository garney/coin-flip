import path from "node:path";
import http from "node:http";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import { settleDueCoinFlips } from "./coinFlip.js";
import { createApiRouter } from "./routes.js";
import { assertServerConfig, config } from "./config.js";
import { createSocketServer } from "./socket.js";
import type { ChatMessage } from "../shared/types.js";

assertServerConfig();

const app = express();
const server = http.createServer(app);
const io = createSocketServer(server);

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "1mb" }));

const realtime = {
  async sideBetChanged(betId: string, reason: string) {
    io.to("side-bets").to(`side-bet:${betId}`).emit("side-bet:changed", { betId, reason });
  },
  async walletChanged(userIds: string | string[], reason: string) {
    const ids = Array.isArray(userIds) ? userIds : [userIds];
    for (const userId of [...new Set(ids)]) {
      io.to(`user:${userId}`).emit("wallet:changed", { reason });
    }
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
  app.use(vite.middlewares);
}

server.listen(config.port, () => {
  console.log(`Side Bets listening on http://localhost:${config.port}`);
});

setInterval(() => {
  void settleDueCoinFlips(realtime).catch((error) => {
    console.error("Coin flip settlement failed", error);
  });
}, 2000);

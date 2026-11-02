import type { NextFunction, Request, Response } from "express";
import { config } from "./config.js";
import { supabaseAdmin, supabaseAuth } from "./supabase.js";

export type AuthedRequest = Request & {
  user: {
    id: string;
    email: string | null;
    displayName: string;
    avatarUrl: string | null;
    isAdmin: boolean;
    isGroupAdmin: boolean;
  };
};

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.header("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;

  if (!token) {
    res.status(401).json({ error: "Missing bearer token" });
    return;
  }

  const { data, error } = await supabaseAuth.auth.getUser(token);
  if (error || !data.user) {
    res.status(401).json({ error: "Invalid or expired token" });
    return;
  }

  const user = data.user;
  const metadata = user.user_metadata ?? {};
  const displayName =
    typeof metadata.full_name === "string"
      ? metadata.full_name
      : typeof metadata.name === "string"
        ? metadata.name
        : user.email?.split("@")[0] ?? "Side bettor";
  const avatarUrl = typeof metadata.avatar_url === "string" ? metadata.avatar_url : null;

  await supabaseAdmin.from("profiles").upsert(
    {
      id: user.id,
      display_name: displayName,
      email: user.email ?? null,
      avatar_url: avatarUrl
    },
    { onConflict: "id" }
  );

  const { data: adminRow } = await supabaseAdmin
    .from("admin_users")
    .select("user_id")
    .eq("user_id", user.id)
    .maybeSingle();
  const { data: groupAdminRow } = await supabaseAdmin
    .from("group_memberships")
    .select("user_id")
    .eq("user_id", user.id)
    .eq("status", "approved")
    .eq("is_group_admin", true)
    .maybeSingle();

  (req as AuthedRequest).user = {
    id: user.id,
    email: user.email ?? null,
    displayName,
    avatarUrl,
    isAdmin: Boolean(adminRow) || config.adminUserIds.has(user.id),
    isGroupAdmin: Boolean(groupAdminRow)
  };
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!(req as AuthedRequest).user?.isAdmin) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  next();
}

export function requireCreditAdmin(req: Request, res: Response, next: NextFunction) {
  const user = (req as AuthedRequest).user;
  if (!user?.isAdmin && !user?.isGroupAdmin) {
    res.status(403).json({ error: "Admin or group admin access required" });
    return;
  }
  next();
}

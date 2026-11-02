import "dotenv/config";

export const config = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: Number(process.env.PORT ?? 4123),
  supabaseUrl: process.env.SUPABASE_URL ?? "",
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY ?? "",
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  adminUserIds: new Set(
    (process.env.ADMIN_USER_IDS ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean)
  )
};

export function assertServerConfig() {
  const missing = [
    ["SUPABASE_URL", config.supabaseUrl],
    ["SUPABASE_ANON_KEY", config.supabaseAnonKey],
    ["SUPABASE_SERVICE_ROLE_KEY", config.supabaseServiceRoleKey]
  ].filter(([, value]) => !value);

  if (missing.length > 0) {
    throw new Error(`Missing required environment values: ${missing.map(([key]) => key).join(", ")}`);
  }
}

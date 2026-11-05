import { supabaseAdmin } from "./supabase.js";

export async function isApprovedGroupMember(userId: string, groupId: string, isPlatformAdmin: boolean) {
  if (isPlatformAdmin) return true;
  const { data, error } = await supabaseAdmin
    .from("group_memberships")
    .select("status")
    .eq("group_id", groupId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) return false;
  return data?.status === "approved";
}

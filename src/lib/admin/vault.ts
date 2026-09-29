import "server-only";
import crypto from "crypto";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service-role";
import { hasSupabaseAdminEnv } from "@/lib/supabase/env";
import { isPanelDemo } from "@/lib/admin/demo";

// AES-256-GCM at-rest encryption for vault secrets. The key lives only on the
// server (ADMIN_VAULT_KEY, 32 bytes base64). Step-up access tokens are signed
// with an HMAC derived from the same key. Without the key (or admin env) the
// vault reports itself unconfigured and the UI degrades gracefully.

const KEY_B64 = process.env.ADMIN_VAULT_KEY ?? "";
const STEP_UP_TTL_MS = 12 * 60 * 1000; // 12 minutes
const TABLE = "admin_vault_entries";

export function isVaultConfigured(): boolean {
  if (isPanelDemo()) return true;
  if (!hasSupabaseAdminEnv() || !KEY_B64) return false;
  try {
    return getKey().length === 32;
  } catch {
    return false;
  }
}

function getKey(): Buffer {
  const key = Buffer.from(KEY_B64, "base64");
  if (key.length !== 32) {
    throw new Error("ADMIN_VAULT_KEY must be 32 bytes encoded as base64");
  }
  return key;
}

export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

export function decryptSecret(payload: string): string {
  const raw = Buffer.from(payload, "base64");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const enc = raw.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}

// — Step-up token: HMAC(userId.exp), kept in an httpOnly cookie after the email
//   OTP succeeds, so writes within the unlock window don't re-prompt. —

export const STEP_UP_COOKIE = "toptik_vault_stepup";
export const STEP_UP_MAX_AGE = STEP_UP_TTL_MS / 1000;

export function issueStepUpToken(userId: string): string {
  const body = `${userId}.${Date.now() + STEP_UP_TTL_MS}`;
  const sig = crypto.createHmac("sha256", getKey()).update(body).digest("base64url");
  return `${Buffer.from(body).toString("base64url")}.${sig}`;
}

export function verifyStepUpToken(token: string | undefined, userId: string): boolean {
  if (!token) return false;
  const [b64, sig] = token.split(".");
  if (!b64 || !sig) return false;
  const body = Buffer.from(b64, "base64url").toString("utf8");
  const expected = crypto.createHmac("sha256", getKey()).update(body).digest("base64url");
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return false;
  const [uid, expStr] = body.split(".");
  return uid === userId && Number(expStr) > Date.now();
}

// — Data —

export type VaultEntry = {
  id: string;
  label: string;
  username: string;
  url: string | null;
  notes: string | null;
  secret: string; // decrypted; only sent to the client after step-up
  updatedAt: string;
};

export type VaultEntryInput = {
  label: string;
  username: string;
  secret: string;
  url: string | null;
  notes: string | null;
};

// In-memory store for demo mode (persists for the life of the dev server).
let demoStore: VaultEntry[] | null = null;
function demoVault(): VaultEntry[] {
  if (!demoStore) {
    demoStore = [
      { id: "1", label: "Supabase", username: "rordan@gmail.com", url: "https://supabase.com/dashboard", notes: "פרויקט toptik", secret: "S8x!ntP2qzL#", updatedAt: "2026-06-20T10:00:00Z" },
      { id: "2", label: "Shopify Admin", username: "toptikcoil", url: "https://admin.shopify.com/store/toptikcoil", notes: "", secret: "shp_4kQ9zR1mY", updatedAt: "2026-06-19T09:00:00Z" },
    ];
  }
  return demoStore;
}

export async function listVaultEntries(): Promise<VaultEntry[]> {
  if (isPanelDemo()) return demoVault();
  const supabase = createSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .from(TABLE)
    .select("id,label,username,url,notes,secret_encrypted,updated_at")
    .order("label", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => ({
    id: r.id as string,
    label: (r.label as string) ?? "",
    username: (r.username as string) ?? "",
    url: (r.url as string | null) ?? null,
    notes: (r.notes as string | null) ?? null,
    secret: r.secret_encrypted ? safeDecrypt(r.secret_encrypted as string) : "",
    updatedAt: r.updated_at as string,
  }));
}

function safeDecrypt(payload: string): string {
  try {
    return decryptSecret(payload);
  } catch {
    return "";
  }
}

export async function createVaultEntry(input: VaultEntryInput, userId: string): Promise<void> {
  if (isPanelDemo()) {
    demoVault().unshift({
      id: crypto.randomUUID(),
      label: input.label,
      username: input.username,
      url: input.url,
      notes: input.notes,
      secret: input.secret,
      updatedAt: new Date().toISOString(),
    });
    return;
  }
  const supabase = createSupabaseServiceRoleClient();
  const { error } = await supabase.from(TABLE).insert({
    label: input.label,
    username: input.username,
    secret_encrypted: encryptSecret(input.secret),
    url: input.url,
    notes: input.notes,
    created_by: userId,
  });
  if (error) throw new Error(error.message);
}

export async function updateVaultEntry(id: string, input: VaultEntryInput): Promise<void> {
  if (isPanelDemo()) {
    const store = demoVault();
    const i = store.findIndex((e) => e.id === id);
    if (i >= 0) {
      store[i] = {
        ...store[i],
        label: input.label,
        username: input.username,
        url: input.url,
        notes: input.notes,
        secret: input.secret,
        updatedAt: new Date().toISOString(),
      };
    }
    return;
  }
  const supabase = createSupabaseServiceRoleClient();
  const { error } = await supabase
    .from(TABLE)
    .update({
      label: input.label,
      username: input.username,
      secret_encrypted: encryptSecret(input.secret),
      url: input.url,
      notes: input.notes,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (error) throw new Error(error.message);
}

export async function deleteVaultEntry(id: string): Promise<void> {
  if (isPanelDemo()) {
    demoStore = demoVault().filter((e) => e.id !== id);
    return;
  }
  const supabase = createSupabaseServiceRoleClient();
  const { error } = await supabase.from(TABLE).delete().eq("id", id);
  if (error) throw new Error(error.message);
}

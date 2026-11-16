import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { brosDir, ensureBrosDir } from "./config.ts";

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  picture?: string;
  provider: "google" | "local";
}

export interface StoredAuth {
  user: AuthUser;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}

export interface IAuthProvider {
  getCurrentUser(): AuthUser | null;
  logout(): void;
}

function authPath(): string {
  return join(brosDir(), "auth.json");
}

function base64Url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function readAuth(): StoredAuth | null {
  const p = authPath();
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as StoredAuth;
  } catch {
    return null;
  }
}

export function writeAuth(auth: StoredAuth): void {
  ensureBrosDir();
  const p = authPath();
  const tmp = `${p}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(auth, null, 2) + "\n", { mode: 0o600 });
  try { chmodSync(tmp, 0o600); } catch {}
  renameSync(tmp, p);
}

export class LocalGoogleAuthProvider implements IAuthProvider {
  private pending = new Map<string, { verifier: string; redirectUri: string }>();

  getCurrentUser(): AuthUser | null {
    return readAuth()?.user ?? null;
  }

  logout(): void {
    const p = authPath();
    if (existsSync(p)) unlinkSync(p);
  }

  isConfigured(): boolean {
    return Boolean(process.env.BROSAI_GOOGLE_CLIENT_ID?.trim());
  }

  createLoginUrl(redirectUri: string): string {
    const clientId = process.env.BROSAI_GOOGLE_CLIENT_ID?.trim();
    if (!clientId) throw new Error("Set BROSAI_GOOGLE_CLIENT_ID to enable Google login");

    const state = base64Url(randomBytes(16));
    const verifier = base64Url(randomBytes(32));
    const challenge = base64Url(createHash("sha256").update(verifier).digest());
    this.pending.set(state, { verifier, redirectUri });

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "openid email profile",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      access_type: "offline",
      prompt: "consent",
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  }

  async handleCallback(code: string, state: string): Promise<AuthUser> {
    const entry = this.pending.get(state);
    if (!entry) throw new Error("Invalid or expired OAuth state");
    this.pending.delete(state);

    const clientId = process.env.BROSAI_GOOGLE_CLIENT_ID!.trim();
    const clientSecret = process.env.BROSAI_GOOGLE_CLIENT_SECRET?.trim();
    const body = new URLSearchParams({
      client_id: clientId,
      code,
      code_verifier: entry.verifier,
      redirect_uri: entry.redirectUri,
      grant_type: "authorization_code",
      ...(clientSecret ? { client_secret: clientSecret } : {}),
    });

    const tokRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    const tok: any = await tokRes.json();
    if (!tokRes.ok || !tok.access_token) {
      throw new Error(tok.error_description ?? tok.error ?? "Google token exchange failed");
    }

    const userRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { authorization: `Bearer ${tok.access_token}` },
    });
    const info: any = await userRes.json();
    if (!userRes.ok || !info.sub) throw new Error("Failed to fetch Google user profile");

    const user: AuthUser = {
      id: String(info.sub),
      email: String(info.email ?? ""),
      name: String(info.name ?? info.email ?? "User"),
      picture: info.picture ? String(info.picture) : undefined,
      provider: "google",
    };
    writeAuth({
      user,
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token,
      expiresAt: tok.expires_in ? Date.now() + Number(tok.expires_in) * 1000 : undefined,
    });
    return user;
  }
}
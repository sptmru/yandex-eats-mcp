import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Cookie, CookieJar, type SerializedCookieJar } from "tough-cookie";
import type { Logger } from "pino";
import type { AppConfig } from "../config.js";

type IdentityState = { deviceId: string; clientSession: string };
type CookieState = {
  sourceHash: string;
  jar: SerializedCookieJar;
  eatsSession?: string;
};

export class EatsSession {
  private jar = new CookieJar();
  private identity!: IdentityState;
  private cookieLoaded = false;
  private eatsSession: string | undefined;
  private sourceHash: string | undefined;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {}

  async initialize(): Promise<void> {
    await mkdir(this.config.stateDir, { recursive: true, mode: 0o700 });
    this.identity = await this.loadIdentity();
    await this.reloadCookie();
  }

  async reloadCookie(): Promise<boolean> {
    let cookieHeader: string;
    try {
      cookieHeader = (await readFile(this.config.eats.cookieFile, "utf8")).trim();
    } catch (error) {
      this.cookieLoaded = false;
      this.logger.warn({ code: fileErrorCode(error) }, "Yandex Eats cookie secret is not available");
      return false;
    }
    if (!cookieHeader) {
      this.cookieLoaded = false;
      this.logger.warn("Yandex Eats cookie secret is empty");
      return false;
    }

    const sourceHash = createHash("sha256").update(cookieHeader).digest("hex");
    const persisted = await this.loadCookieState();
    if (persisted?.sourceHash === sourceHash) {
      try {
        this.jar = CookieJar.deserializeSync(persisted.jar);
        this.eatsSession = persisted.eatsSession;
        this.sourceHash = sourceHash;
        this.cookieLoaded = true;
        return true;
      } catch {
        this.logger.warn("Persisted cookie jar was invalid and will be rebuilt");
      }
    }

    const jar = new CookieJar();
    let parsedCount = 0;
    for (const segment of cookieHeader.split(";")) {
      const cookie = Cookie.parse(segment.trim());
      if (!cookie?.key) continue;
      await jar.setCookie(cookie, this.config.eats.baseUrl.href);
      parsedCount += 1;
    }
    if (parsedCount === 0) {
      this.cookieLoaded = false;
      this.logger.warn("Yandex Eats cookie secret did not contain parseable cookies");
      return false;
    }

    this.jar = jar;
    this.eatsSession = undefined;
    this.sourceHash = sourceHash;
    this.cookieLoaded = true;
    await this.persistCookieState();
    return true;
  }

  isCookieLoaded(): boolean {
    return this.cookieLoaded;
  }

  get deviceId(): string {
    return this.identity.deviceId;
  }

  get clientSession(): string {
    return this.identity.clientSession;
  }

  async buildSensitiveHeaders(): Promise<Record<string, string>> {
    if (!this.cookieLoaded) return {};
    const cookie = await this.jar.getCookieString(this.config.eats.baseUrl.href);
    const headers: Record<string, string> = {};
    if (cookie) headers.Cookie = cookie;
    const tokenCookie = await this.jar.getCookies(this.config.eats.baseUrl.href);
    const webApiToken = tokenCookie.find((value) => value.key === "webapitoken")?.value;
    const baggage = tokenCookie.find((value) => value.key === "baggage")?.value;
    if (webApiToken) headers.Authorization = `Bearer ${webApiToken}`;
    if (baggage) headers.baggage = baggage;
    if (this.eatsSession) headers["X-Eats-Session"] = this.eatsSession;
    return headers;
  }

  async absorbResponse(headers: Headers): Promise<void> {
    const extended = headers as Headers & { getSetCookie?: () => string[] };
    const setCookies = extended.getSetCookie?.() ?? splitCombinedSetCookie(headers.get("set-cookie"));
    let changed = false;
    for (const value of setCookies) {
      try {
        await this.jar.setCookie(value, this.config.eats.baseUrl.href);
        changed = true;
      } catch {
        this.logger.warn("Ignored an invalid Set-Cookie header from Yandex Eats");
      }
    }
    const session = headers.get("x-eats-session");
    if (session && session !== this.eatsSession) {
      this.eatsSession = session;
      changed = true;
    }
    if (changed) await this.persistCookieState();
  }

  private async loadIdentity(): Promise<IdentityState> {
    const path = join(this.config.stateDir, "identity.json");
    try {
      const value = JSON.parse(await readFile(path, "utf8")) as Partial<IdentityState>;
      if (typeof value.deviceId === "string" && typeof value.clientSession === "string") {
        return { deviceId: value.deviceId, clientSession: value.clientSession };
      }
    } catch {
      // A new identity is created below.
    }
    const identity = { deviceId: randomUUID(), clientSession: randomUUID() };
    await atomicWrite(path, JSON.stringify(identity));
    return identity;
  }

  private async loadCookieState(): Promise<CookieState | undefined> {
    try {
      return JSON.parse(await readFile(join(this.config.stateDir, "cookies.json"), "utf8")) as CookieState;
    } catch {
      return undefined;
    }
  }

  private async persistCookieState(): Promise<void> {
    if (!this.sourceHash) return;
    const serialized = this.jar.serializeSync();
    if (!serialized) return;
    const state: CookieState = {
      sourceHash: this.sourceHash,
      jar: serialized,
      ...(this.eatsSession ? { eatsSession: this.eatsSession } : {}),
    };
    await atomicWrite(join(this.config.stateDir, "cookies.json"), JSON.stringify(state));
  }
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, contents, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

function fileErrorCode(error: unknown): string {
  return error instanceof Error && "code" in error ? String(error.code) : "UNKNOWN";
}

function splitCombinedSetCookie(value: string | null): string[] {
  if (!value) return [];
  return value.split(/,(?=\s*[^;,=]+=[^;,]+)/g);
}

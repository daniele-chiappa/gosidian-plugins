// The limits of a subscription: how much of the session (5 hours) and of
// the week is used, and when each resets. The API says it in the
// anthropic-ratelimit-unified-* headers of every answer to a message, which
// the proxy hands here; Claude Code's /usage reads an endpoint instead,
// which needs a token with the user:profile scope (one from
// `claude setup-token` has only user:inference, and gets 403). With an API
// key there is no subscription: the limits are not applicable.

export interface Window {
  used_percent: number;
  left_percent: number;
  resets_at?: string;
  status?: string;
}

export interface Snapshot {
  applicable: true;
  source: "endpoint" | "headers";
  read_at: string;
  status?: string;
  // representative_claim names the window that limits first (five_hour…).
  representative_claim?: string;
  session?: Window;
  week?: Window;
  // week_models are the weekly windows of single models (opus, sonnet), when
  // the source gives them.
  week_models?: Record<string, Window>;
  overage_status?: string;
}

export type Info = Snapshot | { applicable: false; reason: string } | { applicable: true; reason: string };

export const HEADER_PREFIX = "anthropic-ratelimit-unified-";

type HeaderSource = Headers | Record<string, string | string[] | undefined>;

function entries(h: HeaderSource): [string, string][] {
  const out: [string, string][] = [];
  if (typeof (h as Headers).forEach === "function" && typeof (h as Headers).get === "function") {
    (h as Headers).forEach((v, k) => out.push([k.toLowerCase(), v]));
  } else {
    for (const [k, v] of Object.entries(h)) if (v !== undefined) out.push([k.toLowerCase(), Array.isArray(v) ? v.join(",") : v]);
  }
  return out;
}

// rateLimitHeaderNames are the names of the subscription's headers in an
// answer, to log once: never their values with other headers.
export function rateLimitHeaderNames(h: HeaderSource): string[] {
  return entries(h).map(([k]) => k).filter((k) => k.startsWith(HEADER_PREFIX)).sort();
}

const round1 = (n: number) => Math.round(n * 10) / 10;

function window(used: number | undefined, reset: string | undefined, status: string | undefined): Window | undefined {
  if (used === undefined || !Number.isFinite(used)) return undefined;
  const u = Math.min(100, Math.max(0, round1(used)));
  return { used_percent: u, left_percent: round1(100 - u), ...(reset ? { resets_at: reset } : {}), ...(status ? { status } : {}) };
}

function epoch(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) return new Date(n * 1000).toISOString();
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

// fromHeaders reads the subscription's headers of an answer:
// anthropic-ratelimit-unified-{5h,7d,…}-{utilization,reset,status}, the
// utilization a fraction, the reset a Unix time.
export function fromHeaders(h: HeaderSource, now = new Date()): Snapshot | undefined {
  const all = new Map(entries(h).filter(([k]) => k.startsWith(HEADER_PREFIX)).map(([k, v]) => [k.slice(HEADER_PREFIX.length), v]));
  if (!all.size) return undefined;
  const windows = new Map<string, { u?: number; reset?: string; status?: string }>();
  for (const [k, v] of all) {
    const m = /^(.+)-(utilization|reset|status)$/.exec(k);
    if (!m) continue;
    const w = windows.get(m[1]) ?? {};
    if (m[2] === "utilization") w.u = Number(v) * 100;
    else if (m[2] === "reset") w.reset = epoch(v);
    else w.status = v;
    windows.set(m[1], w);
  }
  const snap: Snapshot = { applicable: true, source: "headers", read_at: now.toISOString() };
  const status = all.get("status");
  if (status) snap.status = status;
  const claim = all.get("representative-claim");
  if (claim) snap.representative_claim = claim;
  const overage = all.get("overage-status");
  if (overage) snap.overage_status = overage;
  for (const [name, w] of windows) {
    const win = window(w.u, w.reset, w.status);
    if (!win) continue;
    if (name === "5h") snap.session = win;
    else if (name === "7d") snap.week = win;
    else {
      const m = /^7d[_-](.+)$/.exec(name);
      if (m) (snap.week_models ??= {})[m[1]] = win;
    }
  }
  return snap;
}

// fromEndpoint reads the answer of GET /api/oauth/usage: five_hour,
// seven_day and seven_day_<model>, each {utilization (percent), resets_at}.
export function fromEndpoint(body: any, now = new Date()): Snapshot | undefined {
  if (!body || typeof body !== "object") return undefined;
  const w = (o: any) => (o && typeof o === "object" ? window(typeof o.utilization === "number" ? o.utilization : undefined, epoch(o.resets_at ?? undefined), undefined) : undefined);
  const snap: Snapshot = { applicable: true, source: "endpoint", read_at: now.toISOString() };
  const session = w(body.five_hour);
  const week = w(body.seven_day);
  if (session) snap.session = session;
  if (week) snap.week = week;
  for (const [k, v] of Object.entries(body)) {
    const m = /^seven_day_(.+)$/.exec(k);
    const win = m ? w(v) : undefined;
    if (m && win) (snap.week_models ??= {})[m[1]] = win;
  }
  return snap.session || snap.week ? snap : undefined;
}

export interface SubscriptionDeps {
  kind: "oauth" | "api_key";
  // usage asks the usage endpoint; ping makes the smallest request that
  // brings the headers back (it hands them to note itself, as the proxy
  // does for every answer).
  usage(): Promise<{ status: number; body: unknown }>;
  ping(): Promise<void>;
  now?: () => Date;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
}

// Subscription keeps the last limits seen, and reads them again when asked
// for values younger than they are.
export class Subscription {
  latest: Snapshot | undefined;
  // endpointOff says why the usage endpoint is not asked any more.
  endpointOff = "";
  private deps: SubscriptionDeps;
  private now: () => Date;

  constructor(deps: SubscriptionDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
  }

  get applicable(): boolean {
    return this.deps.kind === "oauth";
  }

  // note takes the headers of an answer of the API.
  note(h: HeaderSource): void {
    if (!this.applicable) return;
    const s = fromHeaders(h, this.now());
    if (s) this.latest = s;
  }

  private fresh(maxAgeMs: number): boolean {
    return Boolean(this.latest && this.now().getTime() - Date.parse(this.latest.read_at) <= maxAgeMs);
  }

  // read gives the limits no older than maxAgeMs: the last seen, the
  // endpoint's, or those of a ping.
  async read(maxAgeMs: number): Promise<Info> {
    if (!this.applicable) return { applicable: false, reason: "an API key: the limits of a subscription do not apply" };
    if (this.fresh(maxAgeMs)) return this.latest!;
    if (!this.endpointOff) {
      try {
        const r = await this.deps.usage();
        const s = r.status === 200 ? fromEndpoint(r.body, this.now()) : undefined;
        if (s) {
          this.latest = s;
          return s;
        }
        // 401, 403 (the token's scope), 404: the headers from now on.
        if (r.status !== 200 && r.status < 500 && r.status !== 429) {
          this.endpointOff = `the usage endpoint answered ${r.status}`;
          this.deps.log?.("the usage endpoint is not available: the headers of the answers instead", { status: r.status });
        }
      } catch (e) {
        this.deps.log?.("the usage endpoint failed", { error: (e as Error).message });
      }
    }
    try {
      await this.deps.ping();
    } catch (e) {
      this.deps.log?.("the ping for the subscription's limits failed", { error: (e as Error).message });
    }
    if (this.fresh(maxAgeMs)) return this.latest!;
    return this.latest ?? { applicable: true, reason: "the limits are not known yet: no answer of the API carried them" };
  }

  // shortfall says why a step may not start: the session or the week has
  // less left than the preset's min_left_percent; "" when it may.
  async shortfall(min: { session: number; week: number }, maxAgeMs: number): Promise<string> {
    if (!this.applicable || (!min.session && !min.week)) return "";
    const s = await this.read(maxAgeMs);
    if (!("session" in s) && !("week" in s)) return "";
    const snap = s as Snapshot;
    for (const [what, w, need] of [["session (5 hours)", snap.session, min.session], ["week", snap.week, min.week]] as const) {
      if (need && w && w.left_percent < need) {
        return `the subscription has ${w.left_percent}% of its ${what} left, less than the preset's min_left_percent (${need}%)${w.resets_at ? `: it resets at ${w.resets_at}` : ""}`;
      }
    }
    return "";
  }
}

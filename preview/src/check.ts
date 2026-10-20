// The check node's browser: a Playwright server of the preset's
// (playwright run-server), driven with playwright-core of the same version.
// A new context per check, with the node's viewport, closed at the end; the
// steps one after another, within the check's time; what the page logs as
// errors and warnings, the requests that failed, the screenshots.
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { NodeError } from "./files.ts";

export const ACTIONS = ["goto", "click", "fill", "select", "press", "wait_for", "expect_text", "expect_count", "screenshot"] as const;
export type Action = (typeof ACTIONS)[number];

export interface Step {
  action: Action;
  path?: string;
  selector?: string;
  value?: string | string[];
  key?: string;
  text?: string;
  count?: number;
  name?: string;
  full_page?: boolean;
  timeout?: number;
}

export interface StepResult {
  action: Action;
  ok: boolean;
  ms: number;
  error?: string;
  not_run?: boolean;
  screenshot?: string;
}

export interface Shot {
  name: string;
  data: Buffer;
}

export interface CheckResult {
  ok: boolean;
  url: string;
  error?: string;
  steps: StepResult[];
  console: { type: string; text: string }[];
  failed_requests: ({ url: string; status: number } | { url: string; error: string })[];
  screenshots: Shot[];
  seconds: number;
  browser: string;
}

export interface CheckOptions {
  ws_endpoint: string;
  // base is the preview's root, with its trailing slash: goto's paths are
  // under it, and with connect self the browser reaches nothing else.
  base: string;
  // start is the page opened first, under base.
  start: string;
  steps: Step[];
  viewport: { width: number; height: number };
  // timeout is the whole check's, in seconds.
  timeout: number;
  connect: "open" | "self";
  signal?: AbortSignal;
}

const STEP_TIMEOUT = 10_000;
const MAX_CONSOLE = 50;
const MAX_FAILED = 50;
const MAX_TEXT = 1000;
const POLL = 100;

// stepError says why a step is not one the node can run, or "".
export function stepError(s: Step, i: number): string {
  const at = `steps[${i}]`;
  if (!s || typeof s !== "object" || !ACTIONS.includes(s.action)) return `${at}: an action of ${ACTIONS.join(", ")}`;
  const str = (k: keyof Step) => typeof s[k] === "string" && (s[k] as string).length > 0 && (s[k] as string).length <= 2000;
  const need = (...ks: (keyof Step)[]) => {
    for (const k of ks) if (!str(k)) return `${at} (${s.action}): ${k}, a text`;
    return "";
  };
  if (s.timeout !== undefined && !(typeof s.timeout === "number" && s.timeout > 0 && s.timeout <= 600)) return `${at}: timeout, seconds from 0 to 600`;
  switch (s.action) {
    case "goto":
      return s.path === undefined || typeof s.path === "string" ? "" : `${at} (goto): path, a path under the preview`;
    case "click":
      return need("selector");
    case "fill":
      return need("selector") || (typeof s.value === "string" ? "" : `${at} (fill): value, a text`);
    case "select":
      return need("selector") || (typeof s.value === "string" || (Array.isArray(s.value) && s.value.every((v) => typeof v === "string")) ? "" : `${at} (select): value, a text or a list of them`);
    case "press":
      return need("key") || (s.selector === undefined || str("selector") ? "" : `${at} (press): selector, a text`);
    case "wait_for":
      return str("selector") || str("text") ? (str("selector") && str("text") ? `${at} (wait_for): selector or text, not both` : "") : `${at} (wait_for): a selector or a text`;
    case "expect_text":
      return need("text") || (s.selector === undefined || str("selector") ? "" : `${at} (expect_text): selector, a text`);
    case "expect_count":
      return need("selector") || (Number.isInteger(s.count) && s.count! >= 0 ? "" : `${at} (expect_count): count, a whole number`);
    case "screenshot":
      return s.name === undefined || str("name") ? "" : `${at} (screenshot): name, a text`;
  }
}

// under resolves a path of goto under base; a path that leaves it is
// refused.
export function under(base: string, p: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(p) || p.startsWith("//")) throw new NodeError(`goto ${p}: a path under the preview, not an address`);
  const u = new URL(p.replace(/^\/+/, ""), base);
  if (!u.href.startsWith(base)) throw new NodeError(`goto ${p}: outside the preview`);
  return u.href;
}

function clip(s: string, n = MAX_TEXT): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function shotName(i: number, name: string | undefined, used: Set<string>): string {
  const base = (name ?? "screenshot").replace(/\.png$/i, "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "").slice(0, 64) || "screenshot";
  let n = `${String(i + 1).padStart(2, "0")}-${base}.png`;
  for (let k = 2; used.has(n); k++) n = `${String(i + 1).padStart(2, "0")}-${base}-${k}.png`;
  used.add(n);
  return n;
}

// poll calls fn until it says "" or the time is up; the last answer is
// the error.
async function poll(ms: number, fn: () => Promise<string>): Promise<void> {
  const end = Date.now() + ms;
  for (;;) {
    const why = await fn();
    if (!why) return;
    if (Date.now() + POLL > end) throw new Error(why);
    await new Promise((r) => setTimeout(r, POLL));
  }
}

async function runStep(page: Page, base: string, s: Step, ms: number, shots: Shot[], used: Set<string>, i: number): Promise<string | undefined> {
  const first = (sel: string) => page.locator(sel).first();
  switch (s.action) {
    case "goto": {
      const r = await page.goto(under(base, s.path ?? ""), { timeout: ms, waitUntil: "load" });
      if (r && r.status() >= 400) throw new Error(`the page answered ${r.status()}`);
      return;
    }
    case "click":
      await first(s.selector!).click({ timeout: ms });
      return;
    case "fill":
      await first(s.selector!).fill(s.value as string, { timeout: ms });
      return;
    case "select":
      await first(s.selector!).selectOption(s.value as string | string[], { timeout: ms });
      return;
    case "press":
      if (s.selector) await first(s.selector).press(s.key!, { timeout: ms });
      else await page.keyboard.press(s.key!);
      return;
    case "wait_for":
      if (s.selector) await first(s.selector).waitFor({ state: "visible", timeout: ms });
      else await page.getByText(s.text!).first().waitFor({ state: "visible", timeout: ms });
      return;
    case "expect_text": {
      const where = s.selector ?? "body";
      await poll(ms, async () => {
        const loc = first(where);
        if ((await loc.count()) === 0) return `${where}: no element`;
        const got = await loc.innerText({ timeout: Math.min(ms, 1000) }).catch(() => "");
        return got.includes(s.text!) ? "" : `${JSON.stringify(s.text)} is not in ${s.selector ?? "the page"}, which reads ${JSON.stringify(clip(got.replace(/\s+/g, " ").trim(), 200))}`;
      });
      return;
    }
    case "expect_count":
      await poll(ms, async () => {
        const n = await page.locator(s.selector!).count();
        return n === s.count ? "" : `${s.selector}: ${n} elements, not ${s.count}`;
      });
      return;
    case "screenshot": {
      const name = shotName(i, s.name, used);
      shots.push({ name, data: await page.screenshot({ fullPage: Boolean(s.full_page), timeout: ms }) });
      return name;
    }
  }
}

// runCheck opens the preview in a new context of the Playwright server's
// Chromium and runs the steps. A step that fails stops the others, and a
// screenshot is taken. Without steps, ok says the page loaded with no
// error in its console and no failed request.
export async function runCheck(o: CheckOptions): Promise<CheckResult> {
  const t0 = Date.now();
  const deadline = t0 + o.timeout * 1000;
  const consoleLog: CheckResult["console"] = [];
  const failed: CheckResult["failed_requests"] = [];
  const shots: Shot[] = [];
  const used = new Set<string>();
  const steps: StepResult[] = [];
  let errors = 0;
  const note = (type: string, text: string) => {
    if (type === "error" || type === "pageerror") errors++;
    if (consoleLog.length < MAX_CONSOLE) consoleLog.push({ type, text: clip(text) });
  };
  const blocked = new Set<string>();
  const fail = (f: CheckResult["failed_requests"][number]) => {
    if (failed.length < MAX_FAILED) failed.push(f);
  };
  const origin = new URL(o.base).origin;

  let browser;
  try {
    browser = await chromium.connect(o.ws_endpoint, { timeout: Math.min(30_000, o.timeout * 1000) });
  } catch (e) {
    throw new NodeError(`the Playwright server ${o.ws_endpoint} did not take the connection: ${clip((e as Error).message.split("\n")[0], 300)}`);
  }
  let ctx: BrowserContext | undefined;
  const onAbort = () => void browser.close().catch(() => {});
  o.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    // No serviceWorkers: "block": its script reads navigator.serviceWorker,
    // which throws in a sandboxed page of a secure context (https,
    // localhost), an error of the check's in the page's console. An opaque
    // origin registers none anyway.
    ctx = await browser.newContext({ viewport: o.viewport, acceptDownloads: false });
    ctx.setDefaultTimeout(STEP_TIMEOUT);
    if (o.connect === "self") {
      await ctx.route("**/*", (route) => {
        const url = route.request().url();
        if (url.startsWith(o.base)) return route.continue();
        blocked.add(url);
        fail({ url: clip(url, 500), error: "blocked: the preset's connect is self" });
        return route.abort("blockedbyclient");
      });
    }
    ctx.on("console", (m) => {
      const t = m.type();
      if (t === "error" || t === "warning") note(t, m.text());
    });
    ctx.on("weberror", (e) => note("pageerror", String(e.error()?.message ?? e.error())));
    ctx.on("requestfailed", (r) => {
      const url = r.url();
      if (blocked.has(url) || url === `${origin}/favicon.ico`) return;
      fail({ url: clip(url, 500), error: r.failure()?.errorText ?? "failed" });
    });
    ctx.on("response", (r) => {
      const url = r.url();
      if (r.status() >= 400 && url !== `${origin}/favicon.ico`) fail({ url: clip(url, 500), status: r.status() });
    });
    const page = await ctx.newPage();
    let error: string | undefined;
    if (o.steps[0]?.action !== "goto") {
      try {
        const r = await page.goto(o.start, { timeout: Math.max(1, deadline - Date.now()), waitUntil: "load" });
        if (r && r.status() >= 400) error = `${o.start} answered ${r.status()}`;
      } catch (e) {
        error = `${o.start} did not load: ${clip((e as Error).message.split("\n")[0], 300)}`;
      }
    }
    let stopped = Boolean(error);
    for (const [i, s] of o.steps.entries()) {
      if (stopped) {
        steps.push({ action: s.action, ok: false, ms: 0, not_run: true });
        continue;
      }
      const left = deadline - Date.now();
      const t1 = Date.now();
      try {
        if (left <= 0) throw new Error(`the check's timeout (${o.timeout} s) passed`);
        const shot = await runStep(page, o.base, s, Math.min((s.timeout ?? 0) * 1000 || STEP_TIMEOUT, left), shots, used, i);
        steps.push({ action: s.action, ok: true, ms: Date.now() - t1, ...(shot ? { screenshot: shot } : {}) });
      } catch (e) {
        const r: StepResult = { action: s.action, ok: false, ms: Date.now() - t1, error: clip((e as Error).message.replace(/\n[\s\S]*$/, ""), 500) };
        try {
          const name = shotName(i, "failed", used);
          shots.push({ name, data: await page.screenshot({ timeout: 5000 }) });
          r.screenshot = name;
        } catch {
          // a page that cannot be shot: the error says enough
        }
        steps.push(r);
        stopped = true;
      }
    }
    if (!o.steps.length && !error) {
      // What the page fetches after load: a moment to see it fail.
      await page.waitForLoadState("networkidle", { timeout: Math.max(1, Math.min(5000, deadline - Date.now())) }).catch(() => {});
    }
    const ok = !error && (o.steps.length ? steps.every((s) => s.ok) : errors === 0 && failed.length === 0);
    return {
      ok,
      url: page.url(),
      ...(error ? { error } : {}),
      steps,
      console: consoleLog,
      failed_requests: failed,
      screenshots: shots,
      seconds: Math.round((Date.now() - t0) / 100) / 10,
      browser: `chromium ${browser.version()}`,
    };
  } finally {
    o.signal?.removeEventListener("abort", onAbort);
    await ctx?.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

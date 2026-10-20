// Email: the preset's SMTP server (STARTTLS required by default, TLS on
// 465, none only when the preset says so), its user and password from
// files, one text/plain message per destination. nodemailer writes the
// message (the headers' encoding, the lines) and talks SMTP; it reads no
// file and fetches no address of a message.
import nodemailer from "nodemailer";
import type { EmailConfig, Preset } from "../preset.ts";
import { capUnits, fill } from "../text.ts";
import { redact } from "../secrets.ts";
import { ChannelError, lines, tryTwice, type Channel, type Dest, type Outgoing, type Sent } from "./channel.ts";

// The SMTP errors worth a second try: the connection, a timeout, a server
// that says to try later (4xx).
const RETRY_CODES = new Set(["ECONNECTION", "ETIMEDOUT", "ESOCKET", "EDNS", "ECONNREFUSED"]);

export class Email implements Channel {
  readonly name = "email" as const;
  private readonly cfg: EmailConfig;
  private readonly preset: Preset;
  private readonly transport: ReturnType<typeof nodemailer.createTransport>;

  constructor(preset: Preset, user: string, password: string) {
    this.cfg = preset.channels.email!;
    this.preset = preset;
    const c = this.cfg;
    this.transport = nodemailer.createTransport({
      host: c.host,
      port: c.port,
      secure: c.security === "tls",
      requireTLS: c.security === "starttls",
      ignoreTLS: c.security === "none",
      ...(user ? { auth: { user, pass: password } } : {}),
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 30_000,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
  }

  reaches(d: Dest): boolean {
    return d.kind === "person" ? Boolean(d.person.email) : Boolean(d.room.email);
  }

  async send(o: Outgoing): Promise<Sent> {
    const d = o.dest;
    const to = d.kind === "person" ? d.person.email! : d.room.email!;
    const s = this.preset.strings;
    const label = o.priority === "urgent" ? s.urgent : o.priority === "high" ? s.high : "";
    const topic = d.kind === "room" && d.topic ? `[${d.topic}]` : "";
    const subject = [label, topic, o.title || capUnits(o.text.split("\n")[0], 120)].filter(Boolean).join(" ");
    const answer = o.question?.answer_url;
    const tail = lines(o.question ? o.question.choices.join(" / ") : "", o.link, answer ? fill(s.answer_at, { url: answer }) : "");
    const text = lines(capUnits(o.text, Math.max(this.preset.limits.text.email - tail.length - 2, 100)), tail) + "\n";
    const important = o.priority === "high" || o.priority === "urgent";
    await tryTwice(async () => {
      try {
        await this.transport.sendMail({
          from: this.cfg.from,
          to,
          subject,
          text,
          headers: {
            "Auto-Submitted": "auto-generated",
            ...(important ? { "X-Priority": "1 (Highest)", Importance: "high" } : {}),
          },
        });
      } catch (e) {
        const err = e as { code?: string; responseCode?: number; message?: string };
        const msg = redact(`email: ${err.code ?? "error"}${err.responseCode ? ` ${err.responseCode}` : ""}: ${err.message ?? ""}`).slice(0, 300);
        const retry = RETRY_CODES.has(err.code ?? "") || (err.responseCode !== undefined && err.responseCode >= 400 && err.responseCode < 500);
        throw new ChannelError(msg, { retry, after: 1 });
      }
    });
    return {};
  }

  close(): void {
    this.transport.close();
  }
}

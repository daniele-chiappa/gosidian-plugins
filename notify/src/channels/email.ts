// Email: the preset's SMTP server (STARTTLS required by default, TLS on
// 465, none only when the preset says so), its user and password from
// files, one text/plain message per destination. nodemailer writes the
// message (the headers' encoding, the lines) and talks SMTP; it reads no
// file and fetches no address of a message. A node's image is an
// attachment (multipart/mixed: the text/plain part as without it, then the
// image, its bytes given, never a path or an address); a server that
// refuses the size (552, or past the SIZE it announced) gets the message
// without it.
import nodemailer from "nodemailer";
import type { EmailConfig, Preset } from "../preset.ts";
import { capUnits, fill } from "../text.ts";
import { redact } from "../secrets.ts";
import { ChannelError, lines, tryTwice, type Channel, type Dest, type Outgoing, type Sent } from "./channel.ts";

// The SMTP errors worth a second try: the connection, a timeout, a server
// that says to try later (4xx).
const RETRY_CODES = new Set(["ECONNECTION", "ETIMEDOUT", "ESOCKET", "EDNS", "ECONNREFUSED"]);

class MailError extends ChannelError {
  // tooBig: the server refused the message's size (552, or a SIZE it
  // announced).
  readonly tooBig: boolean;
  constructor(message: string, tooBig: boolean, opts: { retry?: boolean; after?: number }) {
    super(message, opts);
    this.tooBig = tooBig;
  }
}

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
    const mail = (withImage: boolean) =>
      tryTwice(async () => {
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
            ...(withImage && o.image ? { attachments: [{ filename: o.image.name, content: o.image.data, contentType: o.image.mime, contentDisposition: "attachment" as const }] } : {}),
          });
        } catch (e) {
          const err = e as { code?: string; responseCode?: number; message?: string };
          const msg = redact(`email: ${err.code ?? "error"}${err.responseCode ? ` ${err.responseCode}` : ""}: ${err.message ?? ""}`).slice(0, 300);
          const retry = RETRY_CODES.has(err.code ?? "") || (err.responseCode !== undefined && err.responseCode >= 400 && err.responseCode < 500);
          const tooBig = err.responseCode === 552 || (err.code === "EMESSAGE" && /larger than allowed/i.test(err.message ?? ""));
          throw new MailError(msg, tooBig, { retry, after: 1 });
        }
      });
    if (!o.image) {
      await mail(false);
      return {};
    }
    try {
      await mail(true);
      return { image: "sent" };
    } catch (e) {
      if (!(e instanceof MailError && e.tooBig)) throw e;
      await mail(false);
      return { image: "dropped", note: `the SMTP server refused the message with the image (${e.message}): sent without it` };
    }
  }

  close(): void {
    this.transport.close();
  }
}

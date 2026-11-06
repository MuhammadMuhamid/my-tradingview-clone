/**
 * Outgoing account email, through Amazon SES.
 *
 * Credentials come from the AWS SDK's default chain: the instance role where the
 * container can reach it, or a narrow key in the environment where it can't.
 * With EMAIL_FROM unset this server sends nothing and says so, because a user
 * told "check your inbox" for a message that was never sent has nowhere to go.
 *
 * Nothing here logs a message body: the body holds a sign-in-grade link.
 */
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { config } from "../config";

export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export type EmailTransport = (message: OutgoingEmail) => Promise<void>;

let client: SESv2Client | null = null;

const sesTransport: EmailTransport = async (message) => {
  client ??= new SESv2Client({ region: config.emailRegion });
  await client.send(new SendEmailCommand({
    FromEmailAddress: config.emailFrom,
    Destination: { ToAddresses: [message.to] },
    Content: { Simple: {
      Subject: { Data: message.subject, Charset: "UTF-8" },
      Body: {
        Text: { Data: message.text, Charset: "UTF-8" },
        Html: { Data: message.html, Charset: "UTF-8" },
      },
    } },
  }), { abortSignal: AbortSignal.timeout(10_000) });
};

let transport: EmailTransport = sesTransport;

export function useEmailTransportForTests(next: EmailTransport | null): void {
  transport = next ?? sesTransport;
}

export const isEmailConfigured = (): boolean => !!config.emailFrom && !!config.publicBaseUrl;

const escapeHtml = (value: string): string => value.replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export async function sendVerificationEmail(to: string, token: string): Promise<void> {
  const link = `${config.publicBaseUrl}/verify-email?token=${encodeURIComponent(token)}`;
  await transport({
    to,
    subject: "Verify your Trading Scene email",
    text: `Open this link to verify your email address:\n\n${link}\n\n`
      + "It works once and expires in 24 hours. If you didn't create a Trading Scene account, you can ignore this email.",
    html: `<p>Verify your email address for Trading Scene:</p><p><a href="${escapeHtml(link)}">Verify my email</a></p>`
      + "<p>This link works once and expires in 24 hours. If you didn't create a Trading Scene account, you can ignore this email.</p>",
  });
}

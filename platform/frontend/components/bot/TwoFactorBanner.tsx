"use client";
/**
 * OD-2 guidance: with two-factor off, only Halt and Pause new entries (both
 * risk-reducing) can be confirmed, with the password. Everything else on the
 * Bot pages needs an authenticator code, so the page says so up front and
 * links to where it is turned on.
 */
import Link from "next/link";
import { Notice } from "@/components/ui";

export function TwoFactorBanner() {
  return (
    <Notice tone="warn" role="status">
      <strong>Turn on two-factor to operate the Bot.</strong>{" "}
      Without it, only Halt and Pause new entries can be confirmed (with your password); starting bots, closing trades,
      editing bots and exchange accounts need an authenticator code.{" "}
      <Link href="/profile" className="underline">Turn it on in your profile</Link>.
    </Notice>
  );
}

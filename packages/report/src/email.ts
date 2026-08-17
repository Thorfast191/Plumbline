// No real email-provider credentials exist yet (same category of gap as
// the missing Shopify Partner credentials — see .env.example, which has no
// SES/Postmark/SMTP entry). EmailTransport is the swappable seam: a real
// provider becomes a second implementation of this interface, wired up the
// same way ShopifyClient is swapped for a real client once Shopify
// credentials exist. Nothing here has been proven against a real inbox.

export interface EmailMessage {
  to: string[];
  subject: string;
  textBody: string;
}

export interface EmailTransport {
  send(message: EmailMessage): Promise<void>;
}

/**
 * Deterministic in-memory sink. Every call to send() either records the
 * message or throws, per `failNextSends` — this is what makes retry logic
 * provable in a test: configure N failures, then assert the (N+1)th
 * attempt is recorded as delivered.
 */
export class MockEmailTransport implements EmailTransport {
  readonly sent: EmailMessage[] = [];
  private failuresRemaining = 0;

  /** The next `count` calls to send() will throw instead of recording. */
  failNextSends(count: number): void {
    this.failuresRemaining = count;
  }

  async send(message: EmailMessage): Promise<void> {
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new Error("mock transport: simulated send failure");
    }
    this.sent.push(message);
  }
}

/**
 * What scripts/worker.ts actually uses today: never throws (so retry logic
 * is never exercised in production by this transport specifically — that's
 * proven against MockEmailTransport in tests instead), and never reaches a
 * real inbox — it prints to stdout. This is the honest default until a real
 * provider (SES/Postmark/etc) is wired up and its credentials exist in
 * .env; swapping it out is a one-line change in scripts/worker.ts, not a
 * design change, since both implement the same EmailTransport interface.
 */
export class ConsoleEmailTransport implements EmailTransport {
  async send(message: EmailMessage): Promise<void> {
    console.log(`[email:UNSENT — no real provider configured] to=${message.to.join(",")} subject="${message.subject}"`);
    console.log(message.textBody);
  }
}

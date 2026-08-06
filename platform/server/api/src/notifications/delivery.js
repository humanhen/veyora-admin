/* Provider-neutral notification delivery (Final Handover, Phase 1).
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE
 *
 *   No adapter may report success without actual provider confirmation.
 *
 * That is not hypothetical. `src/mail.js` currently does exactly the opposite:
 *
 *     if (!transport) {
 *       console.log(`[mail:log-only] to=${to} ...\n${text || html}`);
 *       return { logged: true };            // <- reads as success
 *     }
 *
 * A caller cannot distinguish that from a sent message, and it prints the
 * whole body — an enquiry's name, email address and message — into the
 * container log. The outbox must never treat it as delivered, so this module
 * defines what "delivered" means and refuses to infer it.
 *
 * THREE ADAPTERS
 *
 *   memory      deterministic, for tests. Records what it was asked to send.
 *   unconfigured  the safe production default. Reports NOT_CONFIGURED, which
 *                 is a retryable non-delivery, never a success.
 *   smtp        real delivery through nodemailer. Only constructed when SMTP
 *               is genuinely configured, and only reports success on a
 *               provider message id.
 *
 * A delivery result is one of:
 *   { ok: true,  providerReference }                    delivered, evidenced
 *   { ok: false, retryable, code, message }             not delivered
 */

export const DELIVERY_CODES = Object.freeze({
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  PROVIDER_ERROR: 'PROVIDER_ERROR',
  INVALID_RECIPIENT: 'INVALID_RECIPIENT',
  NO_REFERENCE: 'NO_REFERENCE',
});

const delivered = (providerReference) => ({ ok: true, providerReference: String(providerReference) });
const notDelivered = (code, message, retryable = true) =>
  ({ ok: false, retryable, code, message: String(message || code) });

/* A recipient must at least look like an address. A malformed one is NOT
   retryable — retrying it fifty times changes nothing and just burns the
   backoff schedule. Deliberately the same conservative shape the public form
   validator uses. */
const ADDRESS = /^[^\s@,;:<>()[\]\\"]+@[^\s@.,;:<>()[\]\\"]+(?:\.[^\s@.,;:<>()[\]\\"]+)+$/;

/* ---------------------------------------------------------------------------
   Adapters
   --------------------------------------------------------------------------- */

/** Deterministic, for tests. Never touches the network. */
export function createMemoryAdapter({ failTimes = 0, failRetryable = true, failCode = DELIVERY_CODES.PROVIDER_ERROR } = {}) {
  const sent = [];
  let remainingFailures = failTimes;
  let counter = 0;

  return {
    name: 'memory',
    configured: true,
    sent,
    async send(message) {
      if (!ADDRESS.test(String(message.to || ''))) {
        return notDelivered(DELIVERY_CODES.INVALID_RECIPIENT, 'not a deliverable address', false);
      }
      if (remainingFailures > 0) {
        remainingFailures -= 1;
        return notDelivered(failCode, 'simulated provider failure', failRetryable);
      }
      counter += 1;
      sent.push({ ...message });
      return delivered(`memory-${counter}`);
    },
  };
}

/** The safe production default when nothing is configured.
 *
 *  Reports NOT_CONFIGURED — a retryable non-delivery. The notification stays
 *  in the outbox, the admin screen shows "not configured", and nobody is told
 *  a message went out that did not. It logs nothing, because there is nothing
 *  useful to log and the body is private. */
export function createUnconfiguredAdapter() {
  return {
    name: 'unconfigured',
    configured: false,
    async send() {
      return notDelivered(
        DELIVERY_CODES.NOT_CONFIGURED,
        'No email provider is configured. Set SMTP_HOST (see .env.example).'
      );
    },
  };
}

/** Real SMTP delivery.
 *
 *  @param transport anything with `.sendMail()` — nodemailer in production,
 *    a double in tests. Injected rather than constructed here so this module
 *    imports no driver and can be exercised without one. */
export function createSmtpAdapter(transport, { from } = {}) {
  return {
    name: 'smtp',
    configured: true,
    async send(message) {
      if (!ADDRESS.test(String(message.to || ''))) {
        return notDelivered(DELIVERY_CODES.INVALID_RECIPIENT, 'not a deliverable address', false);
      }
      let info;
      try {
        info = await transport.sendMail({
          from, to: message.to, subject: message.subject,
          html: message.html, text: message.text,
        });
      } catch (err) {
        /* The provider's message, never the payload. A stack trace carrying a
           recipient's enquiry into the logs is the failure mode this whole
           module exists to avoid. */
        return notDelivered(DELIVERY_CODES.PROVIDER_ERROR, err && err.message ? err.message : 'send failed');
      }
      /* NO REFERENCE MEANS NO CONFIRMATION. nodemailer returns a messageId on
         a real send; its absence means we cannot evidence delivery, so we do
         not claim it. */
      const reference = info && (info.messageId || info.response);
      if (!reference) {
        return notDelivered(DELIVERY_CODES.NO_REFERENCE, 'provider returned no message reference');
      }
      return delivered(reference);
    },
  };
}

/* ---------------------------------------------------------------------------
   Selection
   --------------------------------------------------------------------------- */

/**
 * Chooses the adapter for an environment.
 *
 * SMTP is used only when it is genuinely configured. Anything less falls back
 * to the unconfigured adapter, which cannot report success — the fail-closed
 * choice, and the opposite of mail.js's current log-and-claim-success.
 */
export function selectAdapter(env = {}, { createTransport = null } = {}) {
  const host = String(env.SMTP_HOST || '').trim();
  if (!host || !createTransport) return createUnconfiguredAdapter();

  const transport = createTransport({
    host,
    port: parseInt(env.SMTP_PORT || '587', 10),
    secure: env.SMTP_PORT === '465',
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
  });
  return createSmtpAdapter(transport, { from: env.SMTP_FROM || undefined });
}

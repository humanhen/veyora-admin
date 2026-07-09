import nodemailer from 'nodemailer';

let transport = null;
if (process.env.SMTP_HOST) {
  transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_PORT === '465',
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
  });
}

/** Sends mail when SMTP is configured; otherwise logs (so flows never break). */
export async function sendMail({ to, subject, html, text }) {
  if (!transport) {
    console.log(`[mail:log-only] to=${to} subject="${subject}"\n${text || html}`);
    return { logged: true };
  }
  return transport.sendMail({
    from: process.env.SMTP_FROM || 'Veyora <info@veyora.com>',
    to, subject, html, text,
  });
}

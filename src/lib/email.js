import { Resend } from 'resend';
import { getSupabase } from './supabase.js';

// Email alerts via Resend (optional — silently no-ops without RESEND_API_KEY).
// Types: SL_BREACH, TARGET_HIT

let _resend = null;
function getResend() {
  const key = process.env.RESEND_API_KEY;
  if (!key) return null;
  if (!_resend) _resend = new Resend(key);
  return _resend;
}

const FROM = process.env.ALERT_FROM || 'NEPSE Intelligence <alerts@resend.dev>';
const TO = process.env.ALERT_TO || 'marketing@nepawholesale.com';

const SUBJECTS = {
  SL_BREACH: (s) => `🔴 Stop-loss breached: ${s}`,
  TARGET_HIT: (s) => `🟢 Target hit: ${s}`,
};

/**
 * sendAlert(type, symbol, price, level)
 *  type   - 'SL_BREACH' | 'TARGET_HIT'
 *  symbol - stock symbol
 *  price  - current price that triggered the alert
 *  level  - the SL or target level that was crossed
 *
 * Records the alert in the `alerts` table regardless of email delivery.
 */
export async function sendAlert(type, symbol, price, level) {
  const supabase = getSupabase();
  const subjectFn = SUBJECTS[type] || ((s) => `Alert: ${s}`);
  const subject = subjectFn(symbol);
  const message =
    type === 'SL_BREACH'
      ? `${symbol} hit ${price}, breaching stop-loss at ${level}.`
      : `${symbol} hit ${price}, reaching target at ${level}.`;

  let sentAt = null;
  const resend = getResend();
  if (resend) {
    try {
      await resend.emails.send({
        from: FROM,
        to: TO,
        subject,
        text: message,
      });
      sentAt = new Date().toISOString();
    } catch (err) {
      console.error(`sendAlert email failed (${type} ${symbol}):`, err?.message || err);
    }
  }

  await supabase.from('alerts').insert({
    symbol,
    type,
    price,
    level,
    message,
    sent_at: sentAt,
    created_at: new Date().toISOString(),
  });

  return { sent: Boolean(sentAt), message };
}

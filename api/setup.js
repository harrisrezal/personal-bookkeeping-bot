const { createSheetsClient } = require('../lib/google-sheets');

module.exports = async function handler(req, res) {
  const expectedSecret = process.env.SETUP_SECRET;
  const providedSecret = req.headers['x-setup-secret'] || req.query.secret;

  if (!expectedSecret || providedSecret !== expectedSecret) {
    res.status(401).json({ ok: false, error: 'Unauthorized setup request.' });
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Use POST.' });
    return;
  }

  try {
    await createSheetsClient().setupSpreadsheet();

    let webhook = null;
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const webhookUrl = process.env.TELEGRAM_WEBHOOK_URL;
    if (token && webhookUrl) {
      const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
      const payload = {
        url: webhookUrl,
        allowed_updates: ['message', 'callback_query'],
        drop_pending_updates: true
      };
      if (webhookSecret) payload.secret_token = webhookSecret;

      const webhookRes = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const webhookBody = await webhookRes.json();
      webhook = webhookBody.ok ? webhookUrl : { error: webhookBody.description };
    }

    res.status(200).json({ ok: true, webhook: webhook || 'TELEGRAM_BOT_TOKEN or TELEGRAM_WEBHOOK_URL not set' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ ok: false, error: error.message });
  }
};

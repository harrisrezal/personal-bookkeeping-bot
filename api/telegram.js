const { createBot } = require('../lib/bot');
const { createSheetsClient } = require('../lib/google-sheets');
const { createTelegramClient } = require('../lib/telegram');
const { createAiClient } = require('../lib/ai');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(200).send('Shared Finance Telegram webhook is running.');
    return;
  }

  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (expectedSecret && req.headers['x-telegram-bot-api-secret-token'] !== expectedSecret) {
    res.status(401).json({ ok: false, error: 'Unauthorized webhook request.' });
    return;
  }

  try {
    const bot = createBot({
      sheets: createSheetsClient(),
      telegram: createTelegramClient(),
      gemini: process.env.GEMINI_API_KEY ? createAiClient() : null
    });
    await bot.handleUpdate(req.body || {});
    res.status(200).json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ ok: false, error: 'Webhook handler failed.' });
  }
};

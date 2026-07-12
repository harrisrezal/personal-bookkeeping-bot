const token = process.env.TELEGRAM_BOT_TOKEN;
const webhookUrl = process.env.TELEGRAM_WEBHOOK_URL;
const secretToken = process.env.TELEGRAM_WEBHOOK_SECRET;

if (!token) {
  throw new Error('TELEGRAM_BOT_TOKEN is required.');
}
if (!webhookUrl) {
  throw new Error('TELEGRAM_WEBHOOK_URL is required. Example: https://your-app.vercel.app/api/telegram');
}

async function main() {
  const payload = {
    url: webhookUrl,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: true
  };

  if (secretToken) {
    payload.secret_token = secretToken;
  }

  const response = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const body = await response.json();
  console.log(JSON.stringify(body, null, 2));

  if (!body.ok) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

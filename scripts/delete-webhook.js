const token = process.env.TELEGRAM_BOT_TOKEN;

if (!token) {
  throw new Error('TELEGRAM_BOT_TOKEN is required.');
}

async function main() {
  const response = await fetch(`https://api.telegram.org/bot${token}/deleteWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ drop_pending_updates: true })
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

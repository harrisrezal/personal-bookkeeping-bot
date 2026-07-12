# PRD: Personal Bookkeeping Bot

A Telegram bot that lets a small group (couple, family, housemates) record shared expenses via chat — typing, receipt photos, or voice messages — and stores everything in Google Sheets for easy viewing and AI analysis.

---

## Todo list for the agent

Work through these in order. Each item is a discrete, testable unit.

- [ ] 1. Initialise project (`package.json`, `.gitignore`, `.env.example`)
- [ ] 2. Write `lib/schema.js` — sheet names, headers, statuses, default categories
- [ ] 3. Write `lib/telegram.js` — Telegram API client
- [ ] 4. Write `lib/google-sheets.js` — Sheets API client with JWT auth
- [ ] 5. Write `lib/ai.js` — Gemini AI adapter (receipt OCR + voice transcription)
- [ ] 6. Write `lib/bot.js` — all bot logic (see Feature Specs below)
- [ ] 7. Write `api/health.js` — health check endpoint
- [ ] 8. Write `api/setup.js` — spreadsheet init + webhook registration endpoint
- [ ] 9. Write `api/telegram.js` — webhook handler entry point
- [ ] 10. Write `server.js` — Express entry point for non-Vercel hosts
- [ ] 11. Write `scripts/set-webhook.js`, `delete-webhook.js`, `get-webhook-info.js`
- [ ] 12. Write `test/bot.test.js` — unit tests covering all core logic
- [ ] 13. Verify `npm test` passes
- [ ] 14. Verify `node server.js` starts and `GET /api/health` returns `{"ok":true}`

---

## Tech stack

- **Runtime**: Node.js ≥ 20, CommonJS (`"type": "commonjs"`)
- **Hosting**: Vercel (serverless, zero config) or any Node.js host via Express
- **Database**: Google Sheets via service account (no ORM, raw `fetch`)
- **Bot platform**: Telegram Bot API, webhook mode (not polling)
- **AI**: Google Gemini API (`gemini-2.5-flash` default), multimodal — images and audio
- **Dependencies**: `express` only (no other runtime deps)
- **Dev dependencies**: none (tests use Node's built-in `assert`)

### `package.json`
```json
{
  "name": "personal-bookkeeping-bot",
  "version": "1.0.0",
  "description": "Telegram bookkeeping bot backed by Google Sheets.",
  "type": "commonjs",
  "scripts": {
    "start": "node server.js",
    "test": "node test/bot.test.js",
    "set-webhook": "node scripts/set-webhook.js",
    "delete-webhook": "node scripts/delete-webhook.js",
    "get-webhook-info": "node scripts/get-webhook-info.js"
  },
  "engines": { "node": ">=20" },
  "dependencies": { "express": "^4.18.0" }
}
```

---

## File structure

```
api/
  health.js          — GET /api/health
  setup.js           — POST /api/setup (init sheet + register webhook)
  telegram.js        — POST /api/telegram (Telegram webhook)
lib/
  ai.js              — Gemini AI client
  bot.js             — all bot logic
  google-sheets.js   — Sheets API client
  schema.js          — constants: sheet names, headers, statuses
  telegram.js        — Telegram API client
scripts/
  delete-webhook.js
  get-webhook-info.js
  set-webhook.js
test/
  bot.test.js
server.js            — Express entry point
.env.example
```

---

## Environment variables

### Required
| Variable | Description |
|---|---|
| `TELEGRAM_BOT_TOKEN` | From BotFather |
| `TELEGRAM_WEBHOOK_SECRET` | Random string — checked in `x-telegram-bot-api-secret-token` header |
| `TELEGRAM_WEBHOOK_URL` | Full URL of the `/api/telegram` endpoint |
| `GOOGLE_SHEET_ID` | Google Spreadsheet ID |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | Service account `client_email` |
| `GOOGLE_PRIVATE_KEY` | Service account `private_key` (escaped `\n` accepted) |
| `SETUP_SECRET` | Random string — checked in `x-setup-secret` header |

### Access control
| Variable | Description |
|---|---|
| `ALLOWED_CHAT_ID` | Telegram group chat ID. If blank, all chats are allowed (open mode). |
| `ALLOWED_USER_IDS` | Comma-separated Telegram user IDs. If blank, all users are allowed. |

### Optional
| Variable | Default | Description |
|---|---|---|
| `GEMINI_API_KEY` | — | Enables receipt scanning and voice recording |
| `GEMINI_MODEL` | `gemini-2.5-flash` | Gemini model name |
| `TIMEZONE` | `UTC` | Timezone for reports and month labels |
| `CURRENCY_SYMBOL` | `$` | Symbol shown in summaries |

---

## Data schema

### Google Sheet tabs

#### `Transactions`
Confirmed expenses and refunds. One row per transaction.

| Column | Type | Notes |
|---|---|---|
| `transaction_id` | string | e.g. `t1a2b3c4` |
| `created_at` | ISO datetime | when confirmed |
| `transaction_date` | ISO datetime | month this counts towards (may differ from created_at) |
| `telegram_chat_id` | string | |
| `telegram_user_id` | string | |
| `telegram_username` | string | |
| `payer_name` | string | display name of who entered it |
| `type` | `expense` \| `refund` | |
| `amount` | number | always positive |
| `signed_amount` | number | negative for refunds |
| `category` | string | |
| `description` | string | |
| `source_message_id` | string | Telegram message ID |

#### `PendingConfirmations`
In-flight transactions awaiting category selection or confirmation. Cleaned up once confirmed/cancelled/expired.

| Column | Type | Notes |
|---|---|---|
| `pending_id` | string | e.g. `p1a2b3c4` |
| `created_at` | ISO datetime | |
| `expires_at` | ISO datetime | 24h after created_at |
| `status` | string | see statuses below |
| `telegram_chat_id` | string | |
| `telegram_user_id` | string | |
| `telegram_username` | string | |
| `payer_name` | string | |
| `type` | `expense` \| `refund` | |
| `amount` | number | |
| `description` | string | |
| `transaction_date` | ISO datetime | defaults to created_at, user can change |
| `category` | string | |
| `source_message_id` | string | |

**Pending statuses:**
- `awaiting_input` — guided flow: waiting for user to type amount + description
- `awaiting_category` — waiting for user to tap a category button
- `awaiting_confirm` — waiting for Confirm or Cancel
- `awaiting_description_edit` — user tapped "Edit description", waiting for new text
- `confirmed` — saved to Transactions
- `cancelled` — user tapped Cancel
- `expired` — 24h passed without confirmation

#### `Categories`
| Column | Type | Notes |
|---|---|---|
| `category` | string | display name |
| `active` | `true` \| `false` | only active categories shown |
| `sort_order` | number | lower = shown first |

**Default categories (seeded on setup):**
Groceries, Dining, Shopping, Transport, Bills, Health, Travel, Entertainment, Home, Personal Care, Gifts, Other

---

## Feature specs

### Access control (`lib/bot.js → isAuthorized`)

- Read `ALLOWED_CHAT_ID` and `ALLOWED_USER_IDS` from `process.env`
- If `ALLOWED_CHAT_ID` is set and the message's `chat.id` doesn't match → deny
- If `ALLOWED_USER_IDS` is set and the user's `id` is not in the list → deny
- If both are blank → allow everyone (open mode)
- **Open mode helper**: when `ALLOWED_CHAT_ID` is blank and a user sends any command, reply with their Chat ID and User ID before processing, so they can configure access control

### Guided expense/refund flow

Triggered when user taps `/expense` or `/refund` from the Telegram menu (sends command with no arguments).

1. Bot creates a pending record with status `awaiting_input`
2. Bot sends: `"Enter the amount and description, e.g. 55 Coffee"`
3. User types `"55 Coffee"` (a free-text message)
4. Bot finds the matching `awaiting_input` pending for this user+chat, parses first token as amount and rest as description
5. If amount or description missing → reply with error, return (pending stays open)
6. Update pending to `awaiting_category`, show category keyboard
7. User taps a category button → update pending to `awaiting_confirm`, show confirmation screen
8. User taps Confirm → write to Transactions, mark pending as `confirmed`

**Callback data formats:**
- Category button: `cat:{pendingId}:{categoryKey}` — categoryKey is the category name lowercased with spaces replaced by `_`, max 24 chars
- Confirm: `ok:{pendingId}`
- Cancel: `cancel:{pendingId}`
- Edit description: `ed:{pendingId}`
- Change month (date picker entry): `dt:{pendingId}`
- Year selected: `dy:{pendingId}:{year}`
- Month selected: `dm:{pendingId}:{year}:{month}`

### Confirmation screen

Shown after category is selected. Text format:
```
Confirm this transaction:

{Type}: ${amount}
Description: {description}
Paid by: {payer_name}
Category: {category}
Date: {Mon YYYY}
```

Keyboard — two rows:
- Row 1: [Confirm] [Cancel]
- Row 2: [✏️ Edit description] [📅 Change month]

### Edit description flow

1. User taps "Edit description" → pending status → `awaiting_description_edit`
2. Bot sends: `Current description: "{desc}"\n\nType the new description:`
3. User sends free-text → bot updates description, resets status to `awaiting_confirm`, shows confirmation screen again

### Change month flow

Date picker: year selector → month selector (Jan–Dec grid, 3 per row).
On month selected: update `transaction_date` on pending to first of that month.

### Report month picker (for `/report_month`)

Same year/month picker UI but callback prefixes are `ry:{year}` and `rm:{year}:{month}`.

### Receipt photo scanning

Requires `GEMINI_API_KEY`. Triggered by `message.photo`.

1. Auth check
2. If no Gemini client → send error, return
3. Send `"Reading receipt…"`, capture `statusMsgId`
4. Download largest photo via `getFile` + `downloadFile`
5. Send image to Gemini with prompt to extract `{ merchant, total }` as JSON
6. Delete status message (fire-and-forget)
7. If total is null → send error, return
8. Create pending with `awaitingCategory`, description = merchant or `"Receipt"`, show category keyboard

### Voice message transcription

Requires `GEMINI_API_KEY`. Triggered by `message.voice`.

1. Auth check
2. If no Gemini client → send error, return
3. Send `"Transcribing voice message…"`, capture `statusMsgId`
4. Download audio via `getFile` + `downloadFile`
5. Send audio to Gemini with prompt to extract `{ type, amount, description }` as JSON
6. Delete status message (fire-and-forget)
7. If amount is null → send error with example, return
8. Normalise type: if not `"refund"` → use `"expense"`
9. If description is null → use `"Voice recording"`
10. Create pending with `awaitingCategory`, show category keyboard

### Reports

`buildReportFromTransactions(transactions, options)` — pure function, returns:
```js
{
  label, start, end, timezone, currencySymbol,
  netSpend,        // sum of signed_amount
  expenseTotal,    // sum of amount where type=expense
  refundTotal,     // sum of amount where type=refund
  categoryTotals,  // { [category]: signedAmount }
  payerTotals,     // { [payer_name]: signedAmount }
  count
}
```

Formatted output shows net spend, expenses, refunds, then breakdowns by category and by payer, sorted by absolute value descending.

Commands:
- `/report_week` — Monday to now
- `/report_current_month` — 1st of month to now
- `/report_month` — year picker → month picker → full month

---

## API layer

### `lib/telegram.js`

Exports `createTelegramClient(env)`. Methods:
- `sendMessage(chatId, text, replyMarkup?)` → returns raw Telegram response (use `.result.message_id`)
- `editMessageText(chatId, messageId, text, replyMarkup?)`
- `answerCallbackQuery(callbackQueryId, text)`
- `getFile(fileId)` → returns `.result.file_path`
- `downloadFile(filePath)` → returns `Buffer`, 10s timeout
- `deleteMessage(chatId, messageId)`

All methods throw on non-OK responses. `downloadFile` uses `AbortController` with 10s timeout.

### `lib/google-sheets.js`

Exports `createSheetsClient(env)`. Methods:
- `setupSpreadsheet()` — creates missing tabs, writes headers, seeds categories if empty
- `getObjects(sheetName, headers)` → array of plain objects
- `appendObject(sheetName, headers, object)`
- `findObjectRow(sheetName, headers, key, value)` → `{ rowNumber, object }` or null
- `updateObjectRow(sheetName, headers, rowNumber, object)`

Auth: JWT signed with `crypto.createSign('RSA-SHA256')`, exchanged for access token at `https://oauth2.googleapis.com/token`. Cache the token until 60s before expiry. All Sheets fetch calls use `AbortController` with 10s timeout.

### `lib/ai.js`

Exports `createAiClient(env)`. Methods:
- `extractReceiptData(imageBuffer)` → `{ merchant, total, _tokens }` or null
- `extractExpenseFromAudio(audioBuffer, mimeType)` → `{ type, amount, description }` or null

Both use `AbortController` with 15s timeout. Parse JSON from Gemini response text using regex `\{[\s\S]*\}` to handle any surrounding text. Default model: `process.env.GEMINI_MODEL || 'gemini-2.5-flash'`. URL: `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`.

**Receipt prompt:** `"This is a receipt image. Extract the total amount and merchant/store name. Return ONLY valid JSON: {\"merchant\": \"name or null\", \"total\": 0.00 or null}. Use null if you cannot determine the value."`

**Voice prompt:** `"The user sent a voice message to record a financial transaction. Extract: type (\"expense\" or \"refund\", default \"expense\"), amount (number), description (what was purchased). Return ONLY valid JSON: {\"type\":\"expense\",\"amount\":5.50,\"description\":\"coffee\"}. Use null for values you cannot determine."`

---

## Endpoint specs

### `GET /api/health`
Returns `{"ok":true,"service":"personal-bookkeeping-bot"}`. No auth.

### `POST /api/setup`
Auth: `x-setup-secret` header must match `SETUP_SECRET` env var.
1. Calls `createSheetsClient().setupSpreadsheet()`
2. If `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_URL` are set, calls `setWebhook` on the Telegram API with `allowed_updates: ['message', 'callback_query']` and `drop_pending_updates: true`
3. Returns `{"ok":true,"webhook":"<url or not-configured message>"}`

### `POST /api/telegram`
1. If not POST → return 200 with plain text (liveness check)
2. Check `x-telegram-bot-api-secret-token` header against `TELEGRAM_WEBHOOK_SECRET` (if set) → 401 if mismatch
3. Call `bot.handleUpdate(req.body)`
4. Return `{"ok":true}`
5. On error → log, return 500 with generic error (no stack trace)

---

## `server.js` (Express for non-Vercel)

```js
const express = require('express');
const app = express();
app.use(express.json());
app.post('/api/telegram', require('./api/telegram'));
app.post('/api/setup', require('./api/setup'));
app.get('/api/health', require('./api/health'));
app.listen(process.env.PORT || 3000, () => console.log(`Listening on port ${process.env.PORT || 3000}`));
```

---

## `createBot` dependency injection

`createBot({ sheets, telegram, gemini = null, now = () => new Date() })`

All bot functions receive a `deps` object. `now` is injectable for deterministic tests. Never call `Date.now()` or `new Date()` directly — always use `deps.now()`.

---

## Testing

File: `test/bot.test.js`. Uses only `node:assert/strict`. No test framework.

Set `process.env.ALLOWED_CHAT_ID` and `process.env.ALLOWED_USER_IDS` at the top of the file to suppress the open-mode helper message during tests.

Tests to implement:
- `parseTransactionCommand` — valid expense, valid refund, invalid amount, missing description, no args (guided mode)
- `parseCallbackData` — all callback formats
- `applySelectedCategory` — sets category and status
- `canConfirmPending` — requires awaitingConfirm + category + not expired
- `buildReportFromTransactions` — refund netting, category totals, payer totals
- `testExpenseFlow` (async) — full flow: `/expense 55 Costco` → category callback → confirm callback → transaction written
- `testDuplicateConfirmPrevention` (async) — confirming an already-confirmed pending does nothing
- `testCancelPreventsInsert` (async) — cancel marks pending cancelled, no transaction written

Use fake implementations of `sheets` and `telegram` — in-memory arrays, no real API calls.

---

## ID generation

```js
function generateId(prefix) {
  return `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 1000000).toString(36)}`;
}
```

---

## Money parsing

```js
function parseMoneyAmount(value) {
  const normalized = String(value || '').replace(/[$,]/g, '');
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return null;
  const amount = Number(normalized);
  return Number.isFinite(amount) ? Math.round(amount * 100) / 100 : null;
}
```

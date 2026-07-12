const assert = require('node:assert/strict');
const {
  createBot,
  parseTransactionCommand,
  parseCallbackData,
  applySelectedCategory,
  canConfirmPending,
  buildTransactionFromPending,
  buildReportFromTransactions,
  PENDING_STATUS,
  TRANSACTION_TYPES
} = require('../lib/bot');
const {
  SHEET_NAMES,
  TRANSACTION_HEADERS,
  PENDING_HEADERS,
  CATEGORY_HEADERS
} = require('../lib/schema');

// Lock down to the test chat/user so the ID auto-discovery message doesn't fire
process.env.ALLOWED_CHAT_ID = '-100';
process.env.ALLOWED_USER_IDS = '123';

async function run() {
  testParseExpense();
  testParseRefund();
  testInvalidAmount();
  testMissingDescription();
  testCallbackParsing();
  testPendingState();
  testReportRefundNetting();
  testReportBreakdowns();
  await testExpenseFlow();
  await testDuplicateConfirmPrevention();
  await testCancelPreventsInsert();
  console.log('All tests passed.');
}

function testParseExpense() {
  const parsed = parseTransactionCommand('/expense 55 Costco', 'expense');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.amount, 55);
  assert.equal(parsed.value.description, 'Costco');
}

function testParseRefund() {
  const parsed = parseTransactionCommand('/refund 55 returned shoes', 'refund');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.amount, 55);
  assert.equal(parsed.value.description, 'returned shoes');
}

function testInvalidAmount() {
  const parsed = parseTransactionCommand('/expense nope Costco', 'expense');
  assert.equal(parsed.ok, false);
}

function testMissingDescription() {
  const parsed = parseTransactionCommand('/expense 55', 'expense');
  assert.equal(parsed.ok, false);
}

function testCallbackParsing() {
  assert.deepEqual(parseCallbackData('cat:p123:groceries'), {
    action: 'cat',
    pendingId: 'p123',
    categoryKey: 'groceries'
  });
  assert.deepEqual(parseCallbackData('ok:p123'), { action: 'ok', pendingId: 'p123' });
  assert.deepEqual(parseCallbackData('cancel:p123'), { action: 'cancel', pendingId: 'p123' });
}

function testPendingState() {
  const pending = makePending();
  applySelectedCategory(pending, 'Shopping');
  assert.equal(pending.category, 'Shopping');
  assert.equal(pending.status, PENDING_STATUS.awaitingConfirm);
  assert.equal(canConfirmPending(pending), true);
}

function testReportRefundNetting() {
  const report = buildReportFromTransactions([
    { type: 'expense', amount: 55, signed_amount: 55, category: 'Shopping', payer_name: 'Harris' },
    { type: 'refund', amount: 55, signed_amount: -55, category: 'Shopping', payer_name: 'Harris' }
  ], reportOptions());

  assert.equal(report.netSpend, 0);
  assert.equal(report.expenseTotal, 55);
  assert.equal(report.refundTotal, 55);
}

function testReportBreakdowns() {
  const report = buildReportFromTransactions([
    { type: 'expense', amount: 20, signed_amount: 20, category: 'Groceries', payer_name: 'A' },
    { type: 'expense', amount: 10, signed_amount: 10, category: 'Dining', payer_name: 'B' },
    { type: 'refund', amount: 5, signed_amount: -5, category: 'Groceries', payer_name: 'A' }
  ], reportOptions());

  assert.equal(report.netSpend, 25);
  assert.equal(report.categoryTotals.Groceries, 15);
  assert.equal(report.payerTotals.A, 15);
}

async function testExpenseFlow() {
  const sheets = makeFakeSheets();
  const telegram = makeFakeTelegram();
  const bot = createBot({ sheets, telegram, now: () => new Date('2026-06-30T12:00:00Z') });

  await bot.handleUpdate({
    message: {
      message_id: 10,
      text: '/expense 55 Costco',
      chat: { id: '-100' },
      from: { id: 123, first_name: 'Harris', username: 'harris' }
    }
  });

  assert.equal(sheets.tables[SHEET_NAMES.pending].length, 1);
  assert.equal(telegram.sentMessages.length, 1);
  assert.equal(telegram.sentMessages[0].replyMarkup.inline_keyboard[0][0].text, 'Shopping');

  const pendingId = sheets.tables[SHEET_NAMES.pending][0].pending_id;
  await bot.handleUpdate({
    callback_query: {
      id: 'cb1',
      data: `cat:${pendingId}:shopping`,
      from: { id: 123 },
      message: { message_id: 20, chat: { id: '-100' } }
    }
  });

  assert.equal(sheets.tables[SHEET_NAMES.pending][0].category, 'Shopping');
  assert.equal(sheets.tables[SHEET_NAMES.pending][0].status, PENDING_STATUS.awaitingConfirm);

  await bot.handleUpdate({
    callback_query: {
      id: 'cb2',
      data: `ok:${pendingId}`,
      from: { id: 123 },
      message: { message_id: 20, chat: { id: '-100' } }
    }
  });

  assert.equal(sheets.tables[SHEET_NAMES.transactions].length, 1);
  assert.equal(sheets.tables[SHEET_NAMES.transactions][0].signed_amount, 55);
  assert.equal(sheets.tables[SHEET_NAMES.pending][0].status, PENDING_STATUS.confirmed);
}

async function testDuplicateConfirmPrevention() {
  const sheets = makeFakeSheets();
  const telegram = makeFakeTelegram();
  const bot = createBot({ sheets, telegram, now: () => new Date('2026-06-30T12:00:00Z') });
  const pending = makePending();
  pending.category = 'Shopping';
  pending.status = PENDING_STATUS.confirmed;
  sheets.tables[SHEET_NAMES.pending].push(pending);

  await bot.handleUpdate({
    callback_query: {
      id: 'cb3',
      data: `ok:${pending.pending_id}`,
      from: { id: 123 },
      message: { message_id: 20, chat: { id: '-100' } }
    }
  });

  assert.equal(sheets.tables[SHEET_NAMES.transactions].length, 0);
}

async function testCancelPreventsInsert() {
  const sheets = makeFakeSheets();
  const telegram = makeFakeTelegram();
  const bot = createBot({ sheets, telegram, now: () => new Date('2026-06-30T12:00:00Z') });
  const pending = makePending();
  sheets.tables[SHEET_NAMES.pending].push(pending);

  await bot.handleUpdate({
    callback_query: {
      id: 'cb4',
      data: `cancel:${pending.pending_id}`,
      from: { id: 123 },
      message: { message_id: 20, chat: { id: '-100' } }
    }
  });

  assert.equal(sheets.tables[SHEET_NAMES.transactions].length, 0);
  assert.equal(sheets.tables[SHEET_NAMES.pending][0].status, PENDING_STATUS.cancelled);
}

function makePending() {
  return {
    pending_id: 'ptest',
    created_at: new Date(),
    expires_at: new Date(Date.now() + 60 * 60 * 1000),
    status: PENDING_STATUS.awaitingCategory,
    telegram_chat_id: '-100',
    telegram_user_id: '123',
    telegram_username: 'harris',
    payer_name: 'Harris',
    type: TRANSACTION_TYPES.expense,
    amount: 55,
    description: 'Costco',
    transaction_date: new Date(),
    category: '',
    source_message_id: '1'
  };
}

function makeFakeSheets() {
  const tables = {
    [SHEET_NAMES.transactions]: [],
    [SHEET_NAMES.pending]: [],
    [SHEET_NAMES.categories]: [
      { category: 'Shopping', active: 'true', sort_order: 1 },
      { category: 'Dining', active: 'true', sort_order: 2 }
    ]
  };

  return {
    tables,
    async getObjects(sheetName) {
      return tables[sheetName].map((row) => ({ ...row }));
    },
    async appendObject(sheetName, headers, object) {
      tables[sheetName].push({ ...object });
    },
    async findObjectRow(sheetName, headers, key, value) {
      const index = tables[sheetName].findIndex((row) => String(row[key]) === String(value));
      if (index === -1) {
        return null;
      }
      return { rowNumber: index + 2, object: { ...tables[sheetName][index] } };
    },
    async updateObjectRow(sheetName, headers, rowNumber, object) {
      tables[sheetName][rowNumber - 2] = { ...object };
    }
  };
}

function makeFakeTelegram() {
  return {
    sentMessages: [],
    editedMessages: [],
    callbackAnswers: [],
    async sendMessage(chatId, text, replyMarkup) {
      this.sentMessages.push({ chatId, text, replyMarkup });
    },
    async editMessageText(chatId, messageId, text, replyMarkup) {
      this.editedMessages.push({ chatId, messageId, text, replyMarkup });
    },
    async answerCallbackQuery(callbackQueryId, text) {
      this.callbackAnswers.push({ callbackQueryId, text });
    }
  };
}

function reportOptions() {
  return {
    period: 'week',
    start: new Date('2026-01-01T00:00:00Z'),
    end: new Date('2026-01-07T00:00:00Z'),
    timezone: 'America/Los_Angeles',
    currencySymbol: '$'
  };
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});

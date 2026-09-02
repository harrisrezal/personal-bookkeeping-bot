const assert = require('node:assert/strict');
const {
  createBot,
  parseTransactionCommand,
  parseCallbackData,
  applySelectedCategory,
  canConfirmPending,
  buildTransactionFromPending,
  buildReportFromTransactions,
  formatReport,
  formatDelta,
  getPreviousMonthYearMonth,
  PENDING_STATUS,
  TRANSACTION_TYPES
} = require('../lib/bot');
const {
  SHEET_NAMES,
  TRANSACTION_HEADERS,
  PENDING_HEADERS,
  CATEGORY_HEADERS
} = require('../lib/schema');
const { normalizeDescription } = require('../lib/merchant-aliases');

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
  testNormalizeDescription();
  testFormatDeltaAndComparisonReport();
  testGetPreviousMonthYearMonth();
  await testExpenseFlow();
  await testExpenseFlowNormalizesDescription();
  await testDuplicateConfirmPrevention();
  await testCancelPreventsInsert();
  await testUndoNoTransactions();
  await testUndoDeleteFlow();
  await testUndoKeepFlow();
  await testBudgetThresholdMessages();
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

function testNormalizeDescription() {
  // case-insensitive alias match
  assert.equal(normalizeDescription('costco'), 'Costco Wholesale');
  assert.equal(normalizeDescription('COSTCO GAS'), 'Costco Gas');
  assert.equal(normalizeDescription('target'), 'Target');
  assert.equal(normalizeDescription('wee!'), 'Weee!');
  assert.equal(normalizeDescription('Wee'), 'Weee!');

  // AMC store-number regex rule
  assert.equal(normalizeDescription('AMC 0420 SUNNYVALE 12'), 'AMC Sunnyvale 12');

  // shouted-case fallback for merchants not in the alias map
  assert.equal(normalizeDescription('WHOLE FOODS MARKET'), 'Whole Foods Market');

  // free-text descriptions pass through unchanged
  assert.equal(normalizeDescription('dinner with Yifan and Han'), 'dinner with Yifan and Han');
  assert.equal(normalizeDescription(''), '');
}

async function testExpenseFlowNormalizesDescription() {
  const sheets = makeFakeSheets();
  const telegram = makeFakeTelegram();
  const bot = createBot({ sheets, telegram, now: () => new Date('2026-06-30T12:00:00Z') });

  await bot.handleUpdate({
    message: {
      message_id: 10,
      text: '/expense 42 costco gas',
      chat: { id: '-100' },
      from: { id: 123, first_name: 'Harris', username: 'harris' }
    }
  });

  assert.equal(sheets.tables[SHEET_NAMES.pending][0].description, 'Costco Gas');
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

function testFormatDeltaAndComparisonReport() {
  assert.equal(formatDelta(120, 100, 'Last Month'), ' (+20% vs Last Month)');
  assert.equal(formatDelta(80, 100, 'Last Month'), ' (-20% vs Last Month)');
  assert.equal(formatDelta(100, 100, 'Last Month'), ' (flat vs Last Month)');
  assert.equal(formatDelta(50, 0, 'Last Month'), ' (new)');
  assert.equal(formatDelta(0, 0, 'Last Month'), '');

  const options = { start: new Date(), end: new Date(), timezone: 'UTC', currencySymbol: '$' };
  const report = buildReportFromTransactions([
    { type: 'expense', amount: 210, signed_amount: 210, category: 'Dining', payer_name: 'A' }
  ], { ...options, label: 'This Month' });
  const previousReport = buildReportFromTransactions([
    { type: 'expense', amount: 178, signed_amount: 178, category: 'Dining', payer_name: 'A' }
  ], { ...options, label: 'Last Month' });

  const text = formatReport(report, previousReport);
  assert.ok(text.includes('Net spend: $210.00 (+18% vs Last Month)'));
  assert.ok(text.includes('Dining: $210.00 (+18% vs Last Month)'));
}

function testGetPreviousMonthYearMonth() {
  assert.deepEqual(getPreviousMonthYearMonth(2026, 6), { year: 2026, month: 5 });
  assert.deepEqual(getPreviousMonthYearMonth(2026, 1), { year: 2025, month: 12 });
}

async function testUndoNoTransactions() {
  const sheets = makeFakeSheets();
  const telegram = makeFakeTelegram();
  const bot = createBot({ sheets, telegram, now: () => new Date('2026-06-15T12:00:00Z') });

  await bot.handleUpdate({
    message: {
      message_id: 1,
      text: '/undo',
      chat: { id: '-100' },
      from: { id: 123, first_name: 'Harris', username: 'harris' }
    }
  });

  assert.equal(telegram.sentMessages.length, 1);
  assert.equal(telegram.sentMessages[0].text, 'No transactions to undo.');
}

async function testUndoDeleteFlow() {
  const sheets = makeFakeSheets();
  sheets.tables[SHEET_NAMES.transactions].push(seedTransaction({
    transaction_id: 'tundo1',
    description: 'Costco Wholesale',
    amount: 47.46,
    signed_amount: 47.46
  }));

  const telegram = makeFakeTelegram();
  const bot = createBot({ sheets, telegram, now: () => new Date('2026-06-15T12:00:00Z') });

  await bot.handleUpdate({
    message: {
      message_id: 1,
      text: '/undo',
      chat: { id: '-100' },
      from: { id: 123, first_name: 'Harris', username: 'harris' }
    }
  });

  assert.equal(telegram.sentMessages.length, 1);
  assert.ok(telegram.sentMessages[0].text.includes('Delete this transaction?'));
  assert.equal(telegram.sentMessages[0].replyMarkup.inline_keyboard[0][0].callback_data, 'ud:tundo1');

  await bot.handleUpdate({
    callback_query: {
      id: 'cb1',
      data: 'ud:tundo1',
      from: { id: 123 },
      message: { message_id: 2, chat: { id: '-100' } }
    }
  });

  assert.equal(telegram.callbackAnswers[0].text, 'Deleted.');
  const remaining = await sheets.getObjects(SHEET_NAMES.transactions, TRANSACTION_HEADERS);
  assert.equal(remaining.find((t) => t.transaction_id === 'tundo1'), undefined);
}

async function testUndoKeepFlow() {
  const sheets = makeFakeSheets();
  sheets.tables[SHEET_NAMES.transactions].push(seedTransaction({ transaction_id: 'tundo2' }));

  const telegram = makeFakeTelegram();
  const bot = createBot({ sheets, telegram, now: () => new Date('2026-06-15T12:00:00Z') });

  await bot.handleUpdate({
    callback_query: {
      id: 'cb1',
      data: 'uk:tundo2',
      from: { id: 123 },
      message: { message_id: 2, chat: { id: '-100' } }
    }
  });

  assert.equal(telegram.callbackAnswers[0].text, 'Kept.');
  const remaining = await sheets.getObjects(SHEET_NAMES.transactions, TRANSACTION_HEADERS);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].transaction_id, 'tundo2');
}

async function testBudgetThresholdMessages() {
  await assertBudgetFlow({
    existingSpent: 85,
    newAmount: 20,
    expectIncludes: 'has hit its budget',
    expectExcludes: '80% of its'
  });

  await assertBudgetFlow({
    existingSpent: 70,
    newAmount: 15,
    expectIncludes: 'of its $100.00 budget this month',
    expectExcludes: 'has hit its budget'
  });

  await assertBudgetFlow({
    existingSpent: 150,
    newAmount: 10,
    expectNoBudgetMessage: true
  });
}

async function assertBudgetFlow({ existingSpent, newAmount, expectIncludes, expectExcludes, expectNoBudgetMessage }) {
  const sheets = makeFakeSheets();
  sheets.tables[SHEET_NAMES.categories] = [
    { category: 'Shopping', active: 'true', sort_order: 1, budget_amount: 100 }
  ];
  sheets.tables[SHEET_NAMES.transactions].push(seedTransaction({
    transaction_id: 'existing',
    category: 'Shopping',
    amount: existingSpent,
    signed_amount: existingSpent,
    transaction_date: new Date('2026-06-05T00:00:00Z')
  }));

  const telegram = makeFakeTelegram();
  const bot = createBot({ sheets, telegram, now: () => new Date('2026-06-15T12:00:00Z') });

  await bot.handleUpdate({
    message: {
      message_id: 1,
      text: `/expense ${newAmount} Target`,
      chat: { id: '-100' },
      from: { id: 123, first_name: 'Harris', username: 'harris' }
    }
  });
  const pendingId = sheets.tables[SHEET_NAMES.pending][0].pending_id;
  await bot.handleUpdate({
    callback_query: {
      id: 'cb1',
      data: `cat:${pendingId}:shopping`,
      from: { id: 123 },
      message: { message_id: 2, chat: { id: '-100' } }
    }
  });
  await bot.handleUpdate({
    callback_query: {
      id: 'cb2',
      data: `ok:${pendingId}`,
      from: { id: 123 },
      message: { message_id: 2, chat: { id: '-100' } }
    }
  });

  if (expectNoBudgetMessage) {
    assert.ok(!telegram.sentMessages.some((m) => m.text.includes('budget')), 'expected no budget message');
    return;
  }

  assert.ok(telegram.sentMessages.some((m) => m.text.includes(expectIncludes)), `expected a message including "${expectIncludes}"`);
  assert.ok(!telegram.sentMessages.some((m) => m.text.includes(expectExcludes)), `did not expect a message including "${expectExcludes}"`);
}

function seedTransaction(overrides) {
  return {
    transaction_id: 'seed' + Math.random().toString(36).slice(2),
    created_at: new Date('2026-06-01T00:00:00Z'),
    transaction_date: new Date('2026-06-01T00:00:00Z'),
    telegram_chat_id: '-100',
    telegram_user_id: '123',
    telegram_username: 'harris',
    payer_name: 'Harris',
    type: TRANSACTION_TYPES.expense,
    amount: 0,
    signed_amount: 0,
    category: 'Shopping',
    description: 'seed',
    source_message_id: '0',
    ...overrides
  };
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

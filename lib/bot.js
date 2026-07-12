const {
  SHEET_NAMES,
  TRANSACTION_HEADERS,
  PENDING_HEADERS,
  CATEGORY_HEADERS,
  PENDING_STATUS,
  TRANSACTION_TYPES
} = require('./schema');

function createBot({ sheets, telegram, gemini = null, now = () => new Date() }) {
  if (!sheets) {
    throw new Error('sheets dependency is required.');
  }
  if (!telegram) {
    throw new Error('telegram dependency is required.');
  }

  return {
    handleUpdate: (update) => handleUpdate({ sheets, telegram, gemini, now }, update),
    buildReport: (period, at = now()) => buildReport({ sheets }, period, at)
  };
}

async function handleUpdate(deps, update) {
  if (update.message) {
    await handleMessage(deps, update.message);
    return;
  }

  if (update.callback_query) {
    await handleCallbackQuery(deps, update.callback_query);
  }
}

async function handleMessage(deps, message) {
  const chatId = String(message.chat.id);
  const user = message.from || {};

  if (message.photo) {
    await handlePhotoMessage(deps, message);
    return;
  }

  if (message.voice) {
    await handleVoiceMessage(deps, message);
    return;
  }

  const text = String(message.text || '').trim();
  if (!text) {
    return;
  }

  if (await handleDescriptionInput(deps, message)) {
    return;
  }

  if (await handleExpenseInput(deps, message)) {
    return;
  }

  const command = parseCommandName(text);
  if (!command) {
    return;
  }

  if (!process.env.ALLOWED_CHAT_ID) {
    await deps.telegram.sendMessage(chatId,
      `⚠️ Bot is open to everyone — set ALLOWED_CHAT_ID and ALLOWED_USER_IDS in your env vars to restrict access.\n\nChat ID: ${chatId}\nYour User ID: ${user.id || 'unknown'}`
    );
  }

  if (!(await isAuthorized(deps.sheets, chatId, user.id))) {
    await deps.telegram.sendMessage(chatId, 'This bot is not configured for this chat or user.');
    return;
  }

  if (command === 'expense' || command === 'refund') {
    await handleTransactionCommand(deps, message, command);
    return;
  }

  if (command === 'report_week') {
    await sendReport(deps, chatId, 'week');
    return;
  }

  if (command === 'report_current_month') {
    await sendReport(deps, chatId, 'month');
    return;
  }

  if (command === 'report_month') {
    await sendReportYearPicker(deps, chatId);
    return;
  }

  if (command === 'categories') {
    await sendCategories(deps, chatId);
    return;
  }

  if (command === 'help') {
    await deps.telegram.sendMessage(chatId, getHelpText());
  }
}

async function handleTransactionCommand(deps, message, command) {
  const chatId = String(message.chat.id);
  const parsed = parseTransactionCommand(message.text, command);

  if (!parsed.ok && parsed.guided) {
    const createdAt = deps.now();
    const user = message.from || {};
    const pending = {
      pending_id: generateId('p'),
      created_at: createdAt,
      expires_at: new Date(createdAt.getTime() + 24 * 60 * 60 * 1000),
      status: PENDING_STATUS.awaitingInput,
      telegram_chat_id: chatId,
      telegram_user_id: String(user.id || ''),
      telegram_username: user.username || '',
      payer_name: getDisplayName(user),
      type: command,
      amount: 0,
      description: '',
      transaction_date: createdAt,
      category: '',
      source_message_id: String(message.message_id || '')
    };
    await deps.sheets.appendObject(SHEET_NAMES.pending, PENDING_HEADERS, pending);
    await deps.telegram.sendMessage(chatId, 'Enter the amount and description, e.g. 55 Coffee');
    return;
  }

  if (!parsed.ok) {
    await deps.telegram.sendMessage(chatId, parsed.error);
    return;
  }

  const categories = await getActiveCategories(deps.sheets);
  if (categories.length === 0) {
    await deps.telegram.sendMessage(chatId, 'No active categories found. Add categories in the Categories sheet first.');
    return;
  }

  const createdAt = deps.now();
  const pendingId = generateId('p');
  const user = message.from || {};
  const pending = {
    pending_id: pendingId,
    created_at: createdAt,
    expires_at: new Date(createdAt.getTime() + 24 * 60 * 60 * 1000),
    status: PENDING_STATUS.awaitingCategory,
    telegram_chat_id: String(message.chat.id),
    telegram_user_id: String(user.id || ''),
    telegram_username: user.username || '',
    payer_name: getDisplayName(user),
    type: parsed.value.type,
    amount: parsed.value.amount,
    description: parsed.value.description,
    transaction_date: createdAt,
    category: '',
    source_message_id: String(message.message_id || '')
  };

  await deps.sheets.appendObject(SHEET_NAMES.pending, PENDING_HEADERS, pending);
  await deps.telegram.sendMessage(chatId, buildCategoryPrompt(pending), buildCategoryKeyboard(pendingId, categories));
}

async function handlePhotoMessage(deps, message) {
  const chatId = String(message.chat.id);
  const user = message.from || {};

  if (!(await isAuthorized(deps.sheets, chatId, user.id))) {
    await deps.telegram.sendMessage(chatId, 'This bot is not configured for this chat or user.');
    return;
  }

  if (!deps.gemini) {
    await deps.telegram.sendMessage(chatId, 'Receipt scanning is not configured. Use /expense to record manually.');
    return;
  }

  const statusMsg = await deps.telegram.sendMessage(chatId, 'Reading receipt…');
  const statusMsgId = statusMsg.result.message_id;

  let receipt;
  try {
    const largestPhoto = message.photo[message.photo.length - 1];
    const fileInfo = await deps.telegram.getFile(largestPhoto.file_id);
    const imageBuffer = await deps.telegram.downloadFile(fileInfo.result.file_path);
    receipt = await deps.gemini.extractReceiptData(imageBuffer);
  } catch (error) {
    console.error('handlePhotoMessage error:', error.message, error.stack);
    deps.telegram.deleteMessage(chatId, statusMsgId).catch(() => {});
    const isTimeout = error.message && error.message.includes('timed out');
    await deps.telegram.sendMessage(chatId,
      isTimeout
        ? 'Request timed out reading the receipt. Please try again or use /expense to record manually.'
        : "Couldn't read the receipt. Use /expense to record it manually."
    );
    return;
  }

  deps.telegram.deleteMessage(chatId, statusMsgId).catch(() => {});

  if (!receipt || receipt.total === null || receipt.total === undefined) {
    await deps.telegram.sendMessage(chatId, "Couldn't read the receipt total. Use /expense to record it manually.");
    return;
  }

  const categories = await getActiveCategories(deps.sheets);
  if (categories.length === 0) {
    await deps.telegram.sendMessage(chatId, 'No active categories found. Add categories in the Categories sheet first.');
    return;
  }

  const createdAt = deps.now();
  const pendingId = generateId('p');
  const pending = {
    pending_id: pendingId,
    created_at: createdAt,
    expires_at: new Date(createdAt.getTime() + 24 * 60 * 60 * 1000),
    status: PENDING_STATUS.awaitingCategory,
    telegram_chat_id: chatId,
    telegram_user_id: String(user.id || ''),
    telegram_username: user.username || '',
    payer_name: getDisplayName(user),
    type: TRANSACTION_TYPES.expense,
    amount: receipt.total,
    description: receipt.merchant || 'Receipt',
    transaction_date: createdAt,
    category: '',
    source_message_id: String(message.message_id || '')
  };

  await deps.sheets.appendObject(SHEET_NAMES.pending, PENDING_HEADERS, pending);
  await deps.telegram.sendMessage(chatId, buildCategoryPrompt(pending), buildCategoryKeyboard(pendingId, categories));
}

async function handleVoiceMessage(deps, message) {
  const chatId = String(message.chat.id);
  const user = message.from || {};

  if (!(await isAuthorized(deps.sheets, chatId, user.id))) {
    await deps.telegram.sendMessage(chatId, 'This bot is not configured for this chat or user.');
    return;
  }

  if (!deps.gemini) {
    await deps.telegram.sendMessage(chatId, 'Voice recording is not configured. Use /expense to record manually.');
    return;
  }

  const statusMsg = await deps.telegram.sendMessage(chatId, 'Transcribing voice message…');
  const statusMsgId = statusMsg.result.message_id;

  let voice;
  try {
    const fileInfo = await deps.telegram.getFile(message.voice.file_id);
    const audioBuffer = await deps.telegram.downloadFile(fileInfo.result.file_path);
    voice = await deps.gemini.extractExpenseFromAudio(audioBuffer, message.voice.mime_type);
  } catch (error) {
    console.error('handleVoiceMessage error:', error.message, error.stack);
    deps.telegram.deleteMessage(chatId, statusMsgId).catch(() => {});
    const isTimeout = error.message && error.message.includes('timed out');
    await deps.telegram.sendMessage(chatId,
      isTimeout
        ? "Request timed out. Please try again or use /expense to record manually."
        : "Couldn't understand the voice message. Use /expense to record manually."
    );
    return;
  }

  deps.telegram.deleteMessage(chatId, statusMsgId).catch(() => {});

  if (!voice || voice.amount === null || voice.amount === undefined) {
    await deps.telegram.sendMessage(chatId, "Couldn't understand the amount. Try saying something like 'Spent 5.50 on coffee'.");
    return;
  }

  const categories = await getActiveCategories(deps.sheets);
  if (categories.length === 0) {
    await deps.telegram.sendMessage(chatId, 'No active categories found. Add categories in the Categories sheet first.');
    return;
  }

  const type = voice.type === TRANSACTION_TYPES.refund ? TRANSACTION_TYPES.refund : TRANSACTION_TYPES.expense;
  const description = voice.description || 'Voice recording';
  const createdAt = deps.now();
  const pendingId = generateId('p');
  const pending = {
    pending_id: pendingId,
    created_at: createdAt,
    expires_at: new Date(createdAt.getTime() + 24 * 60 * 60 * 1000),
    status: PENDING_STATUS.awaitingCategory,
    telegram_chat_id: chatId,
    telegram_user_id: String(user.id || ''),
    telegram_username: user.username || '',
    payer_name: getDisplayName(user),
    type,
    amount: voice.amount,
    description,
    transaction_date: createdAt,
    category: '',
    source_message_id: String(message.message_id || '')
  };

  await deps.sheets.appendObject(SHEET_NAMES.pending, PENDING_HEADERS, pending);
  await deps.telegram.sendMessage(chatId, buildCategoryPrompt(pending), buildCategoryKeyboard(pendingId, categories));
}

async function handleCallbackQuery(deps, callbackQuery) {
  const data = String(callbackQuery.data || '');
  const message = callbackQuery.message || {};
  const chat = message.chat || {};
  const chatId = String(chat.id || '');
  const user = callbackQuery.from || {};

  if (!(await isAuthorized(deps.sheets, chatId, user.id))) {
    await deps.telegram.answerCallbackQuery(callbackQuery.id, 'Not authorized.');
    return;
  }

  const callback = parseCallbackData(data);
  if (!callback) {
    await deps.telegram.answerCallbackQuery(callbackQuery.id, 'Unknown action.');
    return;
  }

  if (callback.action === 'cat') {
    await handleCategoryCallback(deps, callbackQuery, callback);
    return;
  }

  if (callback.action === 'ok') {
    await handleConfirmCallback(deps, callbackQuery, callback);
    return;
  }

  if (callback.action === 'cancel') {
    await handleCancelCallback(deps, callbackQuery, callback);
    return;
  }

  if (callback.action === 'ed') {
    await handleEditDescriptionCallback(deps, callbackQuery, callback);
    return;
  }

  if (callback.action === 'dt') {
    await handleDateCallback(deps, callbackQuery, callback);
    return;
  }

  if (callback.action === 'dy') {
    await handleDateYearCallback(deps, callbackQuery, callback);
    return;
  }

  if (callback.action === 'dm') {
    await handleDateMonthCallback(deps, callbackQuery, callback);
    return;
  }

  if (callback.action === 'ry') {
    await handleReportYearCallback(deps, callbackQuery, callback);
    return;
  }

  if (callback.action === 'rm') {
    await handleReportMonthCallback(deps, callbackQuery, callback);
  }
}

async function handleCategoryCallback(deps, callbackQuery, callback) {
  const pendingResult = await getPendingForCallback(deps, callback.pendingId, callbackQuery);
  if (!pendingResult.ok) {
    await deps.telegram.answerCallbackQuery(callbackQuery.id, pendingResult.error);
    return;
  }

  const category = await findCategoryByKey(deps.sheets, callback.categoryKey);
  if (!category) {
    await deps.telegram.answerCallbackQuery(callbackQuery.id, 'Category is no longer active.');
    return;
  }

  const pending = applySelectedCategory(pendingResult.pending, category.category);
  await deps.sheets.updateObjectRow(SHEET_NAMES.pending, PENDING_HEADERS, pendingResult.rowNumber, pending);

  await deps.telegram.answerCallbackQuery(callbackQuery.id, 'Category selected.');
  await deps.telegram.editMessageText(
    String(callbackQuery.message.chat.id),
    callbackQuery.message.message_id,
    buildConfirmationText(pending),
    buildConfirmKeyboard(pending.pending_id)
  );
}

async function handleConfirmCallback(deps, callbackQuery, callback) {
  const pendingResult = await getPendingForCallback(deps, callback.pendingId, callbackQuery);
  if (!pendingResult.ok) {
    await deps.telegram.answerCallbackQuery(callbackQuery.id, pendingResult.error);
    return;
  }

  const pending = pendingResult.pending;
  if (pending.status === PENDING_STATUS.awaitingDescriptionEdit) {
    pending.status = PENDING_STATUS.awaitingConfirm;
  }
  if (!canConfirmPending(pending, deps.now().getTime())) {
    await deps.telegram.answerCallbackQuery(callbackQuery.id, 'Choose a category first.');
    return;
  }

  const transaction = buildTransactionFromPending(pending, deps.now());
  await deps.sheets.appendObject(SHEET_NAMES.transactions, TRANSACTION_HEADERS, transaction);

  pending.status = PENDING_STATUS.confirmed;
  await deps.sheets.updateObjectRow(SHEET_NAMES.pending, PENDING_HEADERS, pendingResult.rowNumber, pending);

  await deps.telegram.answerCallbackQuery(callbackQuery.id, 'Saved.');
  await deps.telegram.editMessageText(
    String(callbackQuery.message.chat.id),
    callbackQuery.message.message_id,
    `Saved.\n\n${buildTransactionSummary(transaction, defaultConfig())}`
  );
}

async function handleCancelCallback(deps, callbackQuery, callback) {
  const pendingResult = await getPendingForCallback(deps, callback.pendingId, callbackQuery);
  if (!pendingResult.ok) {
    await deps.telegram.answerCallbackQuery(callbackQuery.id, pendingResult.error);
    return;
  }

  const pending = pendingResult.pending;
  if (pending.status === PENDING_STATUS.confirmed) {
    await deps.telegram.answerCallbackQuery(callbackQuery.id, 'Already saved.');
    return;
  }

  pending.status = PENDING_STATUS.cancelled;
  await deps.sheets.updateObjectRow(SHEET_NAMES.pending, PENDING_HEADERS, pendingResult.rowNumber, pending);

  await deps.telegram.answerCallbackQuery(callbackQuery.id, 'Cancelled.');
  await deps.telegram.editMessageText(
    String(callbackQuery.message.chat.id),
    callbackQuery.message.message_id,
    `Cancelled.\n\n${buildPendingSummary(pending, defaultConfig())}`
  );
}

async function handleEditDescriptionCallback(deps, callbackQuery, callback) {
  const pendingResult = await getPendingForCallback(deps, callback.pendingId, callbackQuery);
  if (!pendingResult.ok) {
    await deps.telegram.answerCallbackQuery(callbackQuery.id, pendingResult.error);
    return;
  }

  const pending = pendingResult.pending;
  pending.status = PENDING_STATUS.awaitingDescriptionEdit;
  await deps.sheets.updateObjectRow(SHEET_NAMES.pending, PENDING_HEADERS, pendingResult.rowNumber, pending);

  await deps.telegram.answerCallbackQuery(callbackQuery.id, '');
  await deps.telegram.sendMessage(
    String(callbackQuery.message.chat.id),
    `Current description: "${pending.description}"\n\nType the new description:`
  );
}

async function handleDescriptionInput(deps, message) {
  const chatId = String(message.chat.id);
  const user = message.from || {};
  const text = String(message.text || '').trim();

  if (!text || parseCommandName(text)) return false;
  if (!(await isAuthorized(deps.sheets, chatId, user.id))) return false;

  const allPending = await deps.sheets.getObjects(SHEET_NAMES.pending, PENDING_HEADERS);
  const match = allPending.find((p) =>
    String(p.telegram_chat_id) === chatId &&
    String(p.telegram_user_id) === String(user.id || '') &&
    p.status === PENDING_STATUS.awaitingDescriptionEdit &&
    !isExpired(p.expires_at)
  );
  if (!match) return false;

  const result = await deps.sheets.findObjectRow(SHEET_NAMES.pending, PENDING_HEADERS, 'pending_id', match.pending_id);
  if (!result) return false;

  const pending = result.object;
  pending.description = text;
  pending.status = PENDING_STATUS.awaitingConfirm;
  await deps.sheets.updateObjectRow(SHEET_NAMES.pending, PENDING_HEADERS, result.rowNumber, pending);
  await deps.telegram.sendMessage(chatId, buildConfirmationText(pending), buildConfirmKeyboard(pending.pending_id));
  return true;
}

async function handleExpenseInput(deps, message) {
  const chatId = String(message.chat.id);
  const user = message.from || {};
  const text = String(message.text || '').trim();

  if (!text || parseCommandName(text)) return false;
  if (!(await isAuthorized(deps.sheets, chatId, user.id))) return false;

  const allPending = await deps.sheets.getObjects(SHEET_NAMES.pending, PENDING_HEADERS);
  const match = allPending.find((p) =>
    String(p.telegram_chat_id) === chatId &&
    String(p.telegram_user_id) === String(user.id || '') &&
    p.status === PENDING_STATUS.awaitingInput &&
    !isExpired(p.expires_at)
  );
  if (!match) return false;

  const firstSpace = text.search(/\s/);
  const amountToken = firstSpace === -1 ? text : text.slice(0, firstSpace);
  const description = firstSpace === -1 ? '' : text.slice(firstSpace + 1).trim();
  const amount = parseMoneyAmount(amountToken);

  if (!amount || amount <= 0 || !description) {
    await deps.telegram.sendMessage(chatId, 'Please enter amount and description, e.g. 55 Coffee');
    return true;
  }

  const result = await deps.sheets.findObjectRow(SHEET_NAMES.pending, PENDING_HEADERS, 'pending_id', match.pending_id);
  if (!result) return false;

  const categories = await getActiveCategories(deps.sheets);
  if (categories.length === 0) {
    await deps.telegram.sendMessage(chatId, 'No active categories found.');
    return true;
  }

  const pending = result.object;
  pending.amount = amount;
  pending.description = description;
  pending.status = PENDING_STATUS.awaitingCategory;
  await deps.sheets.updateObjectRow(SHEET_NAMES.pending, PENDING_HEADERS, result.rowNumber, pending);
  await deps.telegram.sendMessage(chatId, buildCategoryPrompt(pending), buildCategoryKeyboard(pending.pending_id, categories));
  return true;
}

async function handleDateCallback(deps, callbackQuery, callback) {
  const pendingResult = await getPendingForCallback(deps, callback.pendingId, callbackQuery);
  if (!pendingResult.ok) {
    await deps.telegram.answerCallbackQuery(callbackQuery.id, pendingResult.error);
    return;
  }

  await deps.telegram.answerCallbackQuery(callbackQuery.id, '');
  await deps.telegram.editMessageText(
    String(callbackQuery.message.chat.id),
    callbackQuery.message.message_id,
    'Select year:',
    buildExpenseYearKeyboard(callback.pendingId)
  );
}

async function handleDateYearCallback(deps, callbackQuery, callback) {
  const pendingResult = await getPendingForCallback(deps, callback.pendingId, callbackQuery);
  if (!pendingResult.ok) {
    await deps.telegram.answerCallbackQuery(callbackQuery.id, pendingResult.error);
    return;
  }

  await deps.telegram.answerCallbackQuery(callbackQuery.id, '');
  await deps.telegram.editMessageText(
    String(callbackQuery.message.chat.id),
    callbackQuery.message.message_id,
    `Select month (${callback.year}):`,
    buildExpenseMonthKeyboard(callback.pendingId, callback.year)
  );
}

async function handleDateMonthCallback(deps, callbackQuery, callback) {
  const pendingResult = await getPendingForCallback(deps, callback.pendingId, callbackQuery);
  if (!pendingResult.ok) {
    await deps.telegram.answerCallbackQuery(callbackQuery.id, pendingResult.error);
    return;
  }

  const pending = pendingResult.pending;
  const { start } = getMonthRange(callback.year, callback.month);
  pending.transaction_date = start;
  await deps.sheets.updateObjectRow(SHEET_NAMES.pending, PENDING_HEADERS, pendingResult.rowNumber, pending);

  await deps.telegram.answerCallbackQuery(callbackQuery.id, 'Date updated.');
  await deps.telegram.editMessageText(
    String(callbackQuery.message.chat.id),
    callbackQuery.message.message_id,
    buildConfirmationText(pending),
    buildConfirmKeyboard(pending.pending_id)
  );
}

async function handleReportYearCallback(deps, callbackQuery, callback) {
  await deps.telegram.answerCallbackQuery(callbackQuery.id, '');
  await deps.telegram.editMessageText(
    String(callbackQuery.message.chat.id),
    callbackQuery.message.message_id,
    `Select month (${callback.year}):`,
    buildReportMonthKeyboard(callback.year)
  );
}

async function handleReportMonthCallback(deps, callbackQuery, callback) {
  await deps.telegram.answerCallbackQuery(callbackQuery.id, '');
  const report = await buildMonthReport(deps, callback.year, callback.month);
  await deps.telegram.sendMessage(String(callbackQuery.message.chat.id), formatReport(report));
}

async function sendReportYearPicker(deps, chatId) {
  await deps.telegram.sendMessage(chatId, 'Select year:', buildReportYearKeyboard());
}

async function getPendingForCallback(deps, pendingId, callbackQuery) {
  const result = await deps.sheets.findObjectRow(SHEET_NAMES.pending, PENDING_HEADERS, 'pending_id', pendingId);
  if (!result) {
    return { ok: false, error: 'Pending item not found.' };
  }

  const pending = result.object;
  const callbackUserId = String((callbackQuery.from || {}).id || '');
  const callbackChatId = String(((callbackQuery.message || {}).chat || {}).id || '');

  if (String(pending.telegram_chat_id) !== callbackChatId || String(pending.telegram_user_id) !== callbackUserId) {
    return { ok: false, error: 'Only the original sender can finish this item.' };
  }

  if (pending.status === PENDING_STATUS.confirmed) {
    return { ok: false, error: 'Already saved.' };
  }

  if (pending.status === PENDING_STATUS.cancelled) {
    return { ok: false, error: 'Already cancelled.' };
  }

  if (isExpired(pending.expires_at, deps.now().getTime())) {
    pending.status = PENDING_STATUS.expired;
    await deps.sheets.updateObjectRow(SHEET_NAMES.pending, PENDING_HEADERS, result.rowNumber, pending);
    return { ok: false, error: 'This pending item expired.' };
  }

  return { ok: true, pending, rowNumber: result.rowNumber };
}

function parseTransactionCommand(text, expectedType) {
  const commandPattern = new RegExp(`^\\/${expectedType}(?:@\\w+)?(?:\\s+(.+))?$`, 'i');
  const match = String(text || '').trim().match(commandPattern);
  const rest = match ? String(match[1] || '').trim() : '';
  if (!rest) {
    return { ok: false, guided: true };
  }

  const firstSpace = rest.search(/\s/);
  const amountToken = firstSpace === -1 ? rest : rest.slice(0, firstSpace);
  const description = firstSpace === -1 ? '' : rest.slice(firstSpace + 1).trim();
  const amount = parseMoneyAmount(amountToken);

  if (!amount || amount <= 0) {
    return { ok: false, error: 'Amount must be a positive number, like 12.50.' };
  }

  if (!description) {
    return { ok: false, error: 'Description is required.' };
  }

  return {
    ok: true,
    value: {
      type: expectedType,
      amount,
      description
    }
  };
}

function parseMoneyAmount(value) {
  const normalized = String(value || '').replace(/[$,]/g, '');
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) {
    return null;
  }

  const amount = Number(normalized);
  return Number.isFinite(amount) ? Math.round(amount * 100) / 100 : null;
}

function parseCommandName(text) {
  const match = String(text || '').trim().match(/^\/([a-z_]+)(?:@\w+)?(?:\s|$)/i);
  return match ? match[1].toLowerCase() : '';
}

function parseCallbackData(data) {
  const parts = String(data || '').split(':');

  if (parts[0] === 'cat' && parts.length === 3) {
    return { action: 'cat', pendingId: parts[1], categoryKey: parts[2] };
  }

  if ((parts[0] === 'ok' || parts[0] === 'cancel' || parts[0] === 'dt' || parts[0] === 'ed') && parts.length === 2) {
    return { action: parts[0], pendingId: parts[1] };
  }

  if (parts[0] === 'dy' && parts.length === 3) {
    return { action: 'dy', pendingId: parts[1], year: Number(parts[2]) };
  }

  if (parts[0] === 'dm' && parts.length === 4) {
    return { action: 'dm', pendingId: parts[1], year: Number(parts[2]), month: Number(parts[3]) };
  }

  if (parts[0] === 'ry' && parts.length === 2) {
    return { action: 'ry', year: Number(parts[1]) };
  }

  if (parts[0] === 'rm' && parts.length === 3) {
    return { action: 'rm', year: Number(parts[1]), month: Number(parts[2]) };
  }

  return null;
}

function buildCategoryPrompt(pending, config = defaultConfig()) {
  return ['Choose a category:', '', buildPendingSummary(pending, config)].join('\n');
}

function buildPendingSummary(pending, config = defaultConfig()) {
  return [
    `${capitalize(pending.type)}: ${formatMoney(pending.amount, config.currency_symbol)}`,
    `Description: ${pending.description}`,
    `Paid by: ${pending.payer_name}`
  ].join('\n');
}

function buildConfirmationText(pending) {
  return [
    'Confirm this transaction:',
    '',
    buildPendingSummary(pending),
    `Category: ${pending.category}`,
    `Date: ${formatMonthYear(pending.transaction_date)}`
  ].join('\n');
}

function buildTransactionSummary(transaction, config = defaultConfig()) {
  return [
    `${capitalize(transaction.type)}: ${formatMoney(transaction.amount, config.currency_symbol)}`,
    `Category: ${transaction.category}`,
    `Description: ${transaction.description}`,
    `Month: ${formatMonthYear(transaction.transaction_date || transaction.created_at)}`,
    `Entered by: ${transaction.payer_name}`
  ].join('\n');
}

function buildCategoryKeyboard(pendingId, categories) {
  const rows = [];
  const buttons = categories.map((category) => ({
    text: category.category,
    callback_data: `cat:${pendingId}:${category.key}`
  }));

  for (let index = 0; index < buttons.length; index += 2) {
    rows.push(buttons.slice(index, index + 2));
  }

  rows.push([{ text: 'Cancel', callback_data: `cancel:${pendingId}` }]);
  return { inline_keyboard: rows };
}

function buildConfirmKeyboard(pendingId) {
  return {
    inline_keyboard: [
      [
        { text: 'Confirm', callback_data: `ok:${pendingId}` },
        { text: 'Cancel', callback_data: `cancel:${pendingId}` }
      ],
      [
        { text: '✏️ Edit description', callback_data: `ed:${pendingId}` },
        { text: '📅 Change month', callback_data: `dt:${pendingId}` }
      ]
    ]
  };
}

function buildTransactionFromPending(pending, at = new Date()) {
  const amount = Number(pending.amount);
  const signedAmount = pending.type === TRANSACTION_TYPES.refund ? -amount : amount;

  return {
    transaction_id: generateId('t'),
    created_at: at,
    transaction_date: pending.transaction_date ? normalizeDate(pending.transaction_date) || at : at,
    telegram_chat_id: String(pending.telegram_chat_id),
    telegram_user_id: String(pending.telegram_user_id),
    telegram_username: pending.telegram_username,
    payer_name: pending.payer_name,
    type: pending.type,
    amount,
    signed_amount: signedAmount,
    category: pending.category,
    description: pending.description,
    source_message_id: String(pending.source_message_id || '')
  };
}

function applySelectedCategory(pending, categoryName) {
  pending.category = categoryName;
  pending.status = PENDING_STATUS.awaitingConfirm;
  return pending;
}

function canConfirmPending(pending, nowMs = Date.now()) {
  return pending.status === PENDING_STATUS.awaitingConfirm && Boolean(pending.category) && !isExpired(pending.expires_at, nowMs);
}

async function sendReport(deps, chatId, period) {
  const report = await buildReport(deps, period, deps.now());
  await deps.telegram.sendMessage(chatId, formatReport(report));
}

async function buildReport(deps, period, at) {
  const config = defaultConfig();
  const range = getReportRange(period, at);
  const label = period === 'week' ? 'This Week' : 'This Month';
  const transactions = (await deps.sheets.getObjects(SHEET_NAMES.transactions, TRANSACTION_HEADERS)).filter((transaction) => {
    const date = normalizeDate(transaction.transaction_date || transaction.created_at);
    return date && date >= range.start && date <= range.end;
  });

  return buildReportFromTransactions(transactions, {
    label,
    start: range.start,
    end: range.end,
    timezone: config.timezone,
    currencySymbol: config.currency_symbol
  });
}

async function buildMonthReport(deps, year, month) {
  const config = defaultConfig();
  const range = getMonthRange(year, month);
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const label = `${monthNames[month - 1]} ${year}`;
  const transactions = (await deps.sheets.getObjects(SHEET_NAMES.transactions, TRANSACTION_HEADERS)).filter((transaction) => {
    const date = normalizeDate(transaction.transaction_date || transaction.created_at);
    return date && date >= range.start && date <= range.end;
  });

  return buildReportFromTransactions(transactions, {
    label,
    start: range.start,
    end: range.end,
    timezone: config.timezone,
    currencySymbol: config.currency_symbol
  });
}

function buildReportFromTransactions(transactions, options) {
  const summary = {
    label: options.label,
    start: options.start,
    end: options.end,
    timezone: options.timezone,
    currencySymbol: options.currencySymbol,
    netSpend: 0,
    expenseTotal: 0,
    refundTotal: 0,
    categoryTotals: {},
    payerTotals: {},
    count: transactions.length
  };

  transactions.forEach((transaction) => {
    const type = String(transaction.type || '').toLowerCase();
    const amount = Number(transaction.amount) || 0;
    const signedAmount = Number(transaction.signed_amount) || (type === TRANSACTION_TYPES.refund ? -amount : amount);
    const category = transaction.category || 'Uncategorized';
    const payer = transaction.payer_name || 'Unknown';

    summary.netSpend += signedAmount;
    if (type === TRANSACTION_TYPES.refund) {
      summary.refundTotal += amount;
    } else {
      summary.expenseTotal += amount;
    }

    summary.categoryTotals[category] = (summary.categoryTotals[category] || 0) + signedAmount;
    summary.payerTotals[payer] = (summary.payerTotals[payer] || 0) + signedAmount;
  });

  summary.netSpend = roundCurrency(summary.netSpend);
  summary.expenseTotal = roundCurrency(summary.expenseTotal);
  summary.refundTotal = roundCurrency(summary.refundTotal);
  summary.categoryTotals = roundTotals(summary.categoryTotals);
  summary.payerTotals = roundTotals(summary.payerTotals);
  return summary;
}

function formatReport(report) {
  const label = report.label || 'Report';
  const dateRange = `${formatDate(report.start, report.timezone)} to ${formatDate(report.end, report.timezone)}`;
  return [
    `${label} Spending`,
    dateRange,
    '',
    `Net spend: ${formatMoney(report.netSpend, report.currencySymbol)}`,
    `Expenses: ${formatMoney(report.expenseTotal, report.currencySymbol)}`,
    `Refunds: ${formatMoney(report.refundTotal, report.currencySymbol)}`,
    `Transactions: ${report.count}`,
    '',
    'By category:',
    formatBreakdown(report.categoryTotals, report.currencySymbol),
    '',
    'By payer:',
    formatBreakdown(report.payerTotals, report.currencySymbol)
  ].join('\n');
}

function formatBreakdown(totals, currencySymbol) {
  const keys = Object.keys(totals).sort((a, b) => Math.abs(totals[b]) - Math.abs(totals[a]));
  if (keys.length === 0) {
    return 'None yet.';
  }

  return keys.map((key) => `${key}: ${formatMoney(totals[key], currencySymbol)}`).join('\n');
}

function getReportRange(period, at) {
  const end = new Date(at);
  const start = new Date(at);
  start.setHours(0, 0, 0, 0);

  if (period === 'week') {
    const daysSinceMonday = (start.getDay() + 6) % 7;
    start.setDate(start.getDate() - daysSinceMonday);
  } else if (period === 'month') {
    start.setDate(1);
  } else {
    throw new Error(`Unknown report period: ${period}`);
  }

  return { start, end };
}

function getMonthRange(year, month) {
  const start = new Date(year, month - 1, 1, 0, 0, 0, 0);
  const end = new Date(year, month, 0, 23, 59, 59, 999);
  return { start, end };
}

function buildReportYearKeyboard() {
  const currentYear = new Date().getFullYear();
  return {
    inline_keyboard: [
      [
        { text: String(currentYear), callback_data: `ry:${currentYear}` },
        { text: String(currentYear - 1), callback_data: `ry:${currentYear - 1}` }
      ]
    ]
  };
}

function buildReportMonthKeyboard(year) {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const rows = [];
  for (let i = 0; i < 12; i += 3) {
    rows.push(months.slice(i, i + 3).map((name, offset) => ({
      text: name,
      callback_data: `rm:${year}:${i + offset + 1}`
    })));
  }
  return { inline_keyboard: rows };
}

function buildExpenseYearKeyboard(pendingId) {
  const currentYear = new Date().getFullYear();
  return {
    inline_keyboard: [
      [
        { text: String(currentYear), callback_data: `dy:${pendingId}:${currentYear}` },
        { text: String(currentYear - 1), callback_data: `dy:${pendingId}:${currentYear - 1}` }
      ]
    ]
  };
}

function buildExpenseMonthKeyboard(pendingId, year) {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const rows = [];
  for (let i = 0; i < 12; i += 3) {
    rows.push(months.slice(i, i + 3).map((name, offset) => ({
      text: name,
      callback_data: `dm:${pendingId}:${year}:${i + offset + 1}`
    })));
  }
  return { inline_keyboard: rows };
}

function formatMonthYear(value) {
  const date = normalizeDate(value);
  if (!date) return '';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: defaultConfig().timezone,
    year: 'numeric',
    month: 'short'
  }).format(date);
}

async function sendCategories(deps, chatId) {
  const categories = await getActiveCategories(deps.sheets);
  if (categories.length === 0) {
    await deps.telegram.sendMessage(chatId, 'No active categories found.');
    return;
  }

  await deps.telegram.sendMessage(chatId, `Active categories:\n${categories.map((category) => `- ${category.category}`).join('\n')}`);
}


function getHelpText() {
  return [
    'Shared Finance commands:',
    '/expense <amount> <description>',
    '/refund <amount> <description>',
    '/report_week',
    '/report_current_month',
    '/report_month - pick any month',
    '/categories',
    '/help',
    '',
    'Examples:',
    '/expense 55 Costco',
    '/refund 55 returned shoes'
  ].join('\n');
}

async function isAuthorized(sheets, chatId, userId) {
  const allowedChatId = String(process.env.ALLOWED_CHAT_ID || '').trim();
  const allowedUserIds = String(process.env.ALLOWED_USER_IDS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  if (allowedChatId && String(chatId) !== allowedChatId) {
    return false;
  }

  if (allowedUserIds.length > 0 && !allowedUserIds.includes(String(userId))) {
    return false;
  }

  return true;
}

async function getActiveCategories(sheets) {
  return (await sheets.getObjects(SHEET_NAMES.categories, CATEGORY_HEADERS))
    .filter((category) => String(category.category || '').trim() && isTruthy(category.active))
    .sort((a, b) => (Number(a.sort_order) || 9999) - (Number(b.sort_order) || 9999))
    .map((category) => {
      const name = String(category.category).trim();
      return {
        category: name,
        key: toCategoryKey(name)
      };
    });
}

async function findCategoryByKey(sheets, categoryKey) {
  const categories = await getActiveCategories(sheets);
  return categories.find((category) => category.key === categoryKey) || null;
}

function toCategoryKey(category) {
  const key = String(category || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 24);
  return key || 'category';
}

function defaultConfig() {
  return {
    timezone: process.env.TIMEZONE || 'UTC',
    currency_symbol: process.env.CURRENCY_SYMBOL || '$'
  };
}

function getDisplayName(user) {
  const firstName = String(user.first_name || '').trim();
  const lastName = String(user.last_name || '').trim();
  const username = String(user.username || '').trim();
  const fullName = `${firstName} ${lastName}`.trim();
  return fullName || username || String(user.id || 'Unknown');
}

function generateId(prefix) {
  const randomPart = Math.floor(Math.random() * 1000000).toString(36);
  return `${prefix}${Date.now().toString(36)}${randomPart}`;
}

function isExpired(expiresAt, nowMs = Date.now()) {
  const expiresDate = normalizeDate(expiresAt);
  return expiresDate ? expiresDate.getTime() < nowMs : false;
}

function normalizeDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isTruthy(value) {
  const normalized = String(value).toLowerCase().trim();
  return value === true || normalized === 'true' || normalized === 'yes' || normalized === '1';
}

function roundCurrency(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function roundTotals(totals) {
  const rounded = {};
  Object.keys(totals).forEach((key) => {
    rounded[key] = roundCurrency(totals[key]);
  });
  return rounded;
}

function formatMoney(value, currencySymbol) {
  const amount = Math.abs(roundCurrency(value)).toFixed(2);
  const sign = Number(value) < 0 ? '-' : '';
  return `${sign}${currencySymbol || '$'}${amount}`;
}

function formatDate(date, timezone) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone || 'America/Los_Angeles',
    year: '2-digit',
    month: 'short',
    day: '2-digit'
  }).format(date);
}

function capitalize(value) {
  const text = String(value || '');
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : '';
}

module.exports = {
  createBot,
  parseTransactionCommand,
  parseMoneyAmount,
  parseCommandName,
  parseCallbackData,
  buildCategoryKeyboard,
  buildConfirmKeyboard,
  buildTransactionFromPending,
  applySelectedCategory,
  canConfirmPending,
  buildReportFromTransactions,
  buildMonthReport,
  formatReport,
  getReportRange,
  getMonthRange,
  getHelpText,
  toCategoryKey,
  isAuthorized,
  getActiveCategories,
  PENDING_STATUS,
  TRANSACTION_TYPES
};

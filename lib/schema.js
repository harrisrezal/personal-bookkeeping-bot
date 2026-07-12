const SHEET_NAMES = {
  transactions: 'Transactions',
  pending: 'PendingConfirmations',
  categories: 'Categories'
};

const TRANSACTION_HEADERS = [
  'transaction_id',
  'created_at',
  'transaction_date',
  'telegram_chat_id',
  'telegram_user_id',
  'telegram_username',
  'payer_name',
  'type',
  'amount',
  'signed_amount',
  'category',
  'description',
  'source_message_id'
];

const PENDING_HEADERS = [
  'pending_id',
  'created_at',
  'expires_at',
  'status',
  'telegram_chat_id',
  'telegram_user_id',
  'telegram_username',
  'payer_name',
  'type',
  'amount',
  'description',
  'transaction_date',
  'category',
  'source_message_id'
];

const CATEGORY_HEADERS = ['category', 'active', 'sort_order'];

const DEFAULT_CATEGORIES = [
  'Groceries',
  'Dining',
  'Shopping',
  'Transport',
  'Bills',
  'Health',
  'Travel',
  'Entertainment',
  'Home',
  'Personal Care',
  'Gifts',
  'Other'
];

const PENDING_STATUS = {
  awaitingInput: 'awaiting_input',
  awaitingCategory: 'awaiting_category',
  awaitingConfirm: 'awaiting_confirm',
  awaitingDescriptionEdit: 'awaiting_description_edit',
  confirmed: 'confirmed',
  cancelled: 'cancelled',
  expired: 'expired'
};

const TRANSACTION_TYPES = {
  expense: 'expense',
  refund: 'refund'
};

module.exports = {
  SHEET_NAMES,
  TRANSACTION_HEADERS,
  PENDING_HEADERS,
  CATEGORY_HEADERS,
  DEFAULT_CATEGORIES,
  PENDING_STATUS,
  TRANSACTION_TYPES
};

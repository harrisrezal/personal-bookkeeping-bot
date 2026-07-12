function createTelegramClient(env = process.env) {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error('TELEGRAM_BOT_TOKEN is required.');
  }

  async function api(method, payload) {
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {})
    });
    const body = await response.json();

    if (!response.ok || !body.ok) {
      throw new Error(`Telegram API ${method} failed: ${JSON.stringify(body)}`);
    }

    return body;
  }

  return {
    api,
    sendMessage: (chatId, text, replyMarkup) => {
      const payload = { chat_id: chatId, text };
      if (replyMarkup) {
        payload.reply_markup = replyMarkup;
      }
      return api('sendMessage', payload);
    },
    editMessageText: (chatId, messageId, text, replyMarkup) => {
      const payload = { chat_id: chatId, message_id: messageId, text };
      if (replyMarkup) {
        payload.reply_markup = replyMarkup;
      }
      return api('editMessageText', payload);
    },
    answerCallbackQuery: (callbackQueryId, text) => api('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      text
    }),
    getFile: (fileId) => api('getFile', { file_id: fileId }),
    deleteMessage: (chatId, messageId) => api('deleteMessage', {
      chat_id: chatId,
      message_id: messageId
    }),
    downloadFile: async (filePath) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      let response;
      try {
        response = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`, {
          signal: controller.signal
        });
      } catch (error) {
        if (error.name === 'AbortError') throw new Error('Telegram file download timed out after 10s');
        throw error;
      } finally {
        clearTimeout(timer);
      }
      if (!response.ok) throw new Error(`Failed to download file: ${response.status}`);
      const buffer = await response.arrayBuffer();
      return Buffer.from(buffer);
    }
  };
}

module.exports = {
  createTelegramClient
};

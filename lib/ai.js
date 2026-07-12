function createAiClient(env = process.env) {
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is required.');
  }

  const model = env.GEMINI_MODEL || 'gemini-2.5-flash-lite';
  const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  async function geminiPost(payload) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    let response;
    try {
      response = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('AI API timed out after 15s');
      throw error;
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`AI API failed (${response.status}): ${errorText}`);
    }

    return response.json();
  }

  async function extractReceiptData(imageBuffer) {
    const body = await geminiPost({
      contents: [{
        parts: [
          { inline_data: { mime_type: 'image/jpeg', data: imageBuffer.toString('base64') } },
          { text: 'This is a receipt image. Extract the total amount and merchant/store name. Return ONLY valid JSON in this exact format: {"merchant": "store name or null", "total": 0.00 or null}. Use null if you cannot determine the value. Do not include any other text.' }
        ]
      }]
    });

    const usage = body.usageMetadata || {};
    const text = body?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    let parsed = null;
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
    } catch {
      // ignore parse errors
    }
    return parsed ? { ...parsed, _tokens: usage } : null;
  }

  async function extractExpenseFromAudio(audioBuffer, mimeType) {
    const body = await geminiPost({
      contents: [{
        parts: [
          { inline_data: { mime_type: mimeType || 'audio/ogg', data: audioBuffer.toString('base64') } },
          { text: 'The user sent a voice message to record a financial transaction. Extract: type ("expense" or "refund", default to "expense"), amount (number), and description (what was purchased/spent on). Return ONLY valid JSON: {"type":"expense","amount":5.50,"description":"coffee"}. Use null for values you cannot determine. Do not include any other text.' }
        ]
      }]
    });

    const text = body?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    let parsed = null;
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
    } catch {
      // ignore parse errors
    }
    return parsed || null;
  }

  return { extractReceiptData, extractExpenseFromAudio };
}

module.exports = { createAiClient };

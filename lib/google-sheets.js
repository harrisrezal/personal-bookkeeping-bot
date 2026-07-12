const crypto = require('node:crypto');
const {
  SHEET_NAMES,
  TRANSACTION_HEADERS,
  PENDING_HEADERS,
  CATEGORY_HEADERS,
  DEFAULT_CATEGORIES
} = require('./schema');

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SHEETS_BASE_URL = 'https://sheets.googleapis.com/v4/spreadsheets';
const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

let cachedToken = null;

function createSheetsClient(env = process.env) {
  const spreadsheetId = env.GOOGLE_SHEET_ID;
  const clientEmail = env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = normalizePrivateKey(env.GOOGLE_PRIVATE_KEY);

  if (!spreadsheetId) {
    throw new Error('GOOGLE_SHEET_ID is required.');
  }
  if (!clientEmail) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_EMAIL is required.');
  }
  if (!privateKey) {
    throw new Error('GOOGLE_PRIVATE_KEY is required.');
  }

  const auth = { spreadsheetId, clientEmail, privateKey };
  return {
    setupSpreadsheet: () => setupSpreadsheet(auth),
    getObjects: (sheetName, headers) => getObjects(auth, sheetName, headers),
    appendObject: (sheetName, headers, object) => appendObject(auth, sheetName, headers, object),
    findObjectRow: (sheetName, headers, key, value) => findObjectRow(auth, sheetName, headers, key, value),
    updateObjectRow: (sheetName, headers, rowNumber, object) => updateObjectRow(auth, sheetName, headers, rowNumber, object)
  };
}

async function setupSpreadsheet(auth) {
  const metadata = await sheetsFetch(auth, '', { method: 'GET' });
  const existingTitles = new Set((metadata.sheets || []).map((sheet) => sheet.properties.title));
  const requiredSheets = [
    SHEET_NAMES.transactions,
    SHEET_NAMES.pending,
    SHEET_NAMES.categories
  ];

  const addSheetRequests = requiredSheets
    .filter((sheetName) => !existingTitles.has(sheetName))
    .map((sheetName) => ({ addSheet: { properties: { title: sheetName } } }));

  if (addSheetRequests.length > 0) {
    await sheetsFetch(auth, ':batchUpdate', {
      method: 'POST',
      body: JSON.stringify({ requests: addSheetRequests })
    });
  }

  await ensureHeaders(auth, SHEET_NAMES.transactions, TRANSACTION_HEADERS);
  await ensureHeaders(auth, SHEET_NAMES.pending, PENDING_HEADERS);
  await ensureHeaders(auth, SHEET_NAMES.categories, CATEGORY_HEADERS);
  await seedDefaultCategories(auth);

  return { ok: true };
}

async function ensureHeaders(auth, sheetName, headers) {
  await updateValues(auth, `${sheetName}!A1:${columnLetter(headers.length)}1`, [headers]);
}

async function seedDefaultCategories(auth) {
  const existing = await getObjects(auth, SHEET_NAMES.categories, CATEGORY_HEADERS);
  if (existing.length > 0) {
    return;
  }

  const rows = DEFAULT_CATEGORIES.map((category, index) => [category, true, index + 1]);
  await updateValues(auth, `${SHEET_NAMES.categories}!A2:C${rows.length + 1}`, rows);
}


async function getObjects(auth, sheetName, headers) {
  const range = `${sheetName}!A2:${columnLetter(headers.length)}`;
  const response = await getValues(auth, range);
  const rows = response.values || [];

  return rows
    .filter((row) => row.some((value) => value !== ''))
    .map((row) => {
      const object = {};
      headers.forEach((header, index) => {
        object[header] = row[index] === undefined ? '' : row[index];
      });
      return object;
    });
}

async function appendObject(auth, sheetName, headers, object) {
  const row = headers.map((header) => valueForSheet(object[header]));
  const range = `${sheetName}!A:${columnLetter(headers.length)}`;
  await sheetsFetch(auth, `/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, {
    method: 'POST',
    body: JSON.stringify({ values: [row] })
  });
}

async function findObjectRow(auth, sheetName, headers, key, value) {
  const response = await getValues(auth, `${sheetName}!A2:${columnLetter(headers.length)}`);
  const rows = response.values || [];
  const keyIndex = headers.indexOf(key);

  for (let index = 0; index < rows.length; index += 1) {
    if (String(rows[index][keyIndex] || '') === String(value)) {
      const object = {};
      headers.forEach((header, columnIndex) => {
        object[header] = rows[index][columnIndex] === undefined ? '' : rows[index][columnIndex];
      });
      return { rowNumber: index + 2, object };
    }
  }

  return null;
}

async function updateObjectRow(auth, sheetName, headers, rowNumber, object) {
  const row = headers.map((header) => valueForSheet(object[header]));
  const range = `${sheetName}!A${rowNumber}:${columnLetter(headers.length)}${rowNumber}`;
  await updateValues(auth, range, [row]);
}

async function getValues(auth, range) {
  return sheetsFetch(auth, `/values/${encodeURIComponent(range)}`, { method: 'GET' });
}

async function updateValues(auth, range, values) {
  return sheetsFetch(auth, `/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`, {
    method: 'PUT',
    body: JSON.stringify({ values })
  });
}

async function sheetsFetch(auth, path, options) {
  const token = await getAccessToken(auth);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  let response;
  try {
    response = await fetch(`${SHEETS_BASE_URL}/${auth.spreadsheetId}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(options.headers || {})
      },
      signal: controller.signal
    });
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('Google Sheets API timed out after 10s');
    throw error;
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  const body = text ? JSON.parse(text) : {};

  if (!response.ok) {
    throw new Error(`Google Sheets API failed (${response.status}): ${text}`);
  }

  return body;
}

async function getAccessToken(auth) {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.expiresAt - 60 > now) {
    return cachedToken.accessToken;
  }

  const jwt = createJwt(auth.clientEmail, auth.privateKey, now);
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt
    })
  });

  const tokenBody = await response.json();
  if (!response.ok) {
    throw new Error(`Google token request failed (${response.status}): ${JSON.stringify(tokenBody)}`);
  }

  cachedToken = {
    accessToken: tokenBody.access_token,
    expiresAt: now + Number(tokenBody.expires_in || 3600)
  };

  return cachedToken.accessToken;
}

function createJwt(clientEmail, privateKey, now) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: clientEmail,
    scope: SHEETS_SCOPE,
    aud: GOOGLE_TOKEN_URL,
    exp: now + 3600,
    iat: now
  };

  const unsigned = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(claim))}`;
  const signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(privateKey);
  return `${unsigned}.${base64Url(signature)}`;
}

function normalizePrivateKey(privateKey) {
  return privateKey ? privateKey.replace(/\\n/g, '\n') : '';
}

function base64Url(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function columnLetter(columnNumber) {
  let dividend = columnNumber;
  let columnName = '';

  while (dividend > 0) {
    const modulo = (dividend - 1) % 26;
    columnName = String.fromCharCode(65 + modulo) + columnName;
    dividend = Math.floor((dividend - modulo) / 26);
  }

  return columnName;
}

function valueForSheet(value) {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return value === undefined || value === null ? '' : value;
}

module.exports = {
  createSheetsClient,
  columnLetter,
  normalizePrivateKey
};

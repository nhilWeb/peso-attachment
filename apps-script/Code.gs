/**
 * PESO San Miguel Attachment System - Google Sheets data service.
 *
 * Required Script Properties:
 *   SPREADSHEET_ID  ID of the Google Spreadsheet used as the database
 *   GATEWAY_SECRET  Same random secret configured in the Cloudflare Worker
 *
 * Deploy as a Web app that executes as the owner. The Cloudflare Worker is the
 * only intended caller; all requests are POSTed and authenticated in the body.
 */

const TRANSACTIONS_SHEET = 'Transactions';
const SETTINGS_SHEET = 'Settings';
const TRANSACTION_HEADERS = [
  'id', 'type', 'orNo', 'dvNo', 'transactionDate', 'payee', 'position',
  'office', 'address', 'officialStation', 'salary', 'travelFrom', 'travelTo',
  'destination', 'dateReturn', 'purpose', 'explanation',
  'responsibilityCenter', 'responsibilityCenterName', 'ffp', 'accountCode',
  'particulars', 'totalAmount', 'itineraryJson', 'templateCompletionJson',
  'status', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy', 'deletedAt'
];
const SETTINGS_HEADERS = ['key', 'valueJson', 'updatedAt', 'updatedBy'];
const INPUT_FIELDS = [
  'type', 'orNo', 'dvNo', 'transactionDate', 'payee', 'position', 'office',
  'address', 'officialStation', 'salary', 'travelFrom', 'travelTo',
  'destination', 'dateReturn', 'purpose', 'explanation',
  'responsibilityCenter', 'responsibilityCenterName', 'ffp', 'accountCode',
  'particulars'
];
const TEMPLATE_KEYS = ['or', 'dv', 'to', 'itinerary'];
const DEFAULT_SETTINGS = {
  mayor: {name: 'MICHAEL T. CORILLA', pos: 'Municipal Mayor'},
  accountant: {name: 'HAZEL GRACE T. ELLACER, CPA', pos: 'Municipal Accountant'},
  treasurer: {name: 'RINZ R. CUADRA', pos: 'Acting Municipal Treasurer'},
  budget: {name: 'LUZVIMINDA G. SAGOSOY', pos: 'Municipal Budget Officer'}
};

function doPost(e) {
  try {
    const request = parseRequest_(e);
    authenticateGateway_(request.gatewaySecret);
    const userEmail = cleanText_(request.authenticatedUser || 'unknown', 254);
    let data;

    switch (request.action) {
      case 'health':
        data = {service: 'peso-attachment-sheets', status: 'ok'};
        break;
      case 'listTransactions':
        data = listTransactions_();
        break;
      case 'getTransaction':
        data = getTransaction_(request.id);
        break;
      case 'upsertTransaction':
        data = upsertTransaction_(request.transaction, userEmail);
        break;
      case 'deleteTransaction':
        data = deleteTransaction_(request.id, userEmail);
        break;
      case 'getSettings':
        data = getSettings_();
        break;
      case 'saveSettings':
        data = saveSettings_(request.settings, userEmail);
        break;
      default:
        throw new Error('Unsupported API action.');
    }

    return jsonResponse_({ok: true, data: data});
  } catch (error) {
    console.error(error && error.stack ? error.stack : error);
    return jsonResponse_({ok: false, error: error.message || 'Unexpected server error.'});
  }
}

/** Run once from the Apps Script editor after setting Script Properties. */
function setup() {
  const spreadsheet = getSpreadsheet_();
  ensureSheet_(spreadsheet, TRANSACTIONS_SHEET, TRANSACTION_HEADERS);
  ensureSheet_(spreadsheet, SETTINGS_SHEET, SETTINGS_HEADERS);
  return 'Database sheets are ready.';
}

function parseRequest_(e) {
  if (!e || !e.postData || !e.postData.contents) throw new Error('Request body is required.');
  let request;
  try {
    request = JSON.parse(e.postData.contents);
  } catch (error) {
    throw new Error('Request body must be valid JSON.');
  }
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('Invalid request body.');
  return request;
}

function authenticateGateway_(providedSecret) {
  const expected = PropertiesService.getScriptProperties().getProperty('GATEWAY_SECRET');
  if (!expected) throw new Error('Server is missing the GATEWAY_SECRET Script Property.');
  if (!providedSecret || !constantTimeEqual_(String(providedSecret), expected)) throw new Error('Unauthorized gateway request.');
}

function constantTimeEqual_(left, right) {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return mismatch === 0;
}

function getSpreadsheet_() {
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!id) throw new Error('Server is missing the SPREADSHEET_ID Script Property.');
  return SpreadsheetApp.openById(id);
}

function ensureSheet_(spreadsheet, name, headers) {
  let sheet = spreadsheet.getSheetByName(name);
  if (!sheet) sheet = spreadsheet.insertSheet(name);
  const headerRange = sheet.getRange(1, 1, 1, headers.length);
  headerRange.setNumberFormat('@').setValues([headers]);
  headerRange.setFontWeight('bold').setBackground('#e2e8f0');
  sheet.setFrozenRows(1);
  return sheet;
}

function transactionSheet_() {
  return ensureSheet_(getSpreadsheet_(), TRANSACTIONS_SHEET, TRANSACTION_HEADERS);
}

function settingsSheet_() {
  return ensureSheet_(getSpreadsheet_(), SETTINGS_SHEET, SETTINGS_HEADERS);
}

function listTransactions_() {
  const sheet = transactionSheet_();
  if (sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, TRANSACTION_HEADERS.length)
    .getValues()
    .map(rowToTransaction_)
    .filter(transaction => !transaction.deletedAt)
    .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
}

function getTransaction_(id) {
  const sheet = transactionSheet_();
  const rowNumber = findTransactionRow_(sheet, validateId_(id));
  if (!rowNumber) throw new Error('Transaction not found.');
  const transaction = rowToTransaction_(sheet.getRange(rowNumber, 1, 1, TRANSACTION_HEADERS.length).getValues()[0]);
  if (transaction.deletedAt) throw new Error('Transaction has been deleted.');
  return transaction;
}

function upsertTransaction_(input, userEmail) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Transaction data is required.');
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sheet = transactionSheet_();
    const id = input.id ? validateId_(input.id) : createTransactionId_();
    const existingRow = findTransactionRow_(sheet, id);
    const existing = existingRow
      ? rowToTransaction_(sheet.getRange(existingRow, 1, 1, TRANSACTION_HEADERS.length).getValues()[0])
      : null;
    if (existing && existing.deletedAt) throw new Error('A deleted transaction cannot be overwritten.');

    const transaction = normalizeTransaction_(input);
    const now = new Date().toISOString();
    transaction.id = id;
    transaction.createdAt = existing ? existing.createdAt : now;
    transaction.updatedAt = now;
    transaction.createdBy = existing ? existing.createdBy : userEmail;
    transaction.updatedBy = userEmail;
    transaction.deletedAt = '';

    const row = transactionToRow_(transaction);
    const targetRow = existingRow || sheet.getLastRow() + 1;
    sheet.getRange(targetRow, 1, 1, TRANSACTION_HEADERS.length).setNumberFormat('@').setValues([row]);
    SpreadsheetApp.flush();
    return transaction;
  } finally {
    lock.releaseLock();
  }
}

function deleteTransaction_(id, userEmail) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sheet = transactionSheet_();
    const rowNumber = findTransactionRow_(sheet, validateId_(id));
    if (!rowNumber) throw new Error('Transaction not found.');
    const transaction = rowToTransaction_(sheet.getRange(rowNumber, 1, 1, TRANSACTION_HEADERS.length).getValues()[0]);
    if (transaction.deletedAt) return {id: transaction.id, deleted: true};
    transaction.deletedAt = new Date().toISOString();
    transaction.updatedAt = transaction.deletedAt;
    transaction.updatedBy = userEmail;
    sheet.getRange(rowNumber, 1, 1, TRANSACTION_HEADERS.length)
      .setNumberFormat('@')
      .setValues([transactionToRow_(transaction)]);
    return {id: transaction.id, deleted: true};
  } finally {
    lock.releaseLock();
  }
}

function normalizeTransaction_(input) {
  const transaction = {};
  INPUT_FIELDS.forEach(field => {
    const maximum = field === 'purpose' || field === 'explanation' ? 5000 : 1000;
    transaction[field] = cleanText_(input[field], maximum);
  });

  const itinerary = normalizeItinerary_(input.itinerary);
  const templateCompletion = normalizeTemplateCompletion_(input.templateCompletion);
  transaction.itinerary = itinerary;
  transaction.templateCompletion = templateCompletion;
  transaction.totalAmount = itinerary.reduce((sum, row) => sum + row.transport + row.perDiem + row.others, 0);
  transaction.status = TEMPLATE_KEYS.every(key => templateCompletion[key] === 'complete') ? 'Done' : 'Draft';
  return transaction;
}

function normalizeItinerary_(input) {
  const rows = Array.isArray(input) ? input : [];
  if (rows.length > 100) throw new Error('An itinerary cannot contain more than 100 rows.');
  const itinerary = rows.map(row => ({
    dateRange: cleanText_(row && row.dateRange, 100),
    from: cleanText_(row && row.from, 500),
    to: cleanText_(row && row.to, 500),
    departure: cleanText_(row && row.departure, 20),
    arrival: cleanText_(row && row.arrival, 20),
    means: cleanText_(row && row.means, 200),
    transport: cleanAmount_(row && row.transport),
    perDiem: cleanAmount_(row && row.perDiem),
    others: cleanAmount_(row && row.others)
  }));
  if (JSON.stringify(itinerary).length > 45000) throw new Error('The itinerary is too large for one spreadsheet cell.');
  return itinerary;
}

function normalizeTemplateCompletion_(input) {
  const completion = {};
  TEMPLATE_KEYS.forEach(key => completion[key] = input && input[key] === 'complete' ? 'complete' : 'incomplete');
  return completion;
}

function cleanAmount_(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number < 0 || number > 1000000000) throw new Error('Itinerary amounts must be valid non-negative numbers.');
  return Math.round(number * 100) / 100;
}

function cleanText_(value, maximumLength) {
  const text = String(value == null ? '' : value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim();
  if (text.length > maximumLength) throw new Error('A submitted text field is longer than allowed.');
  return text;
}

function validateId_(value) {
  const id = cleanText_(value, 100);
  if (!/^TX-[A-Za-z0-9._-]+$/.test(id)) throw new Error('Invalid transaction ID.');
  return id;
}

function createTransactionId_() {
  return 'TX-' + Date.now() + '-' + Utilities.getUuid().slice(0, 8);
}

function findTransactionRow_(sheet, id) {
  if (sheet.getLastRow() < 2) return 0;
  const match = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1)
    .createTextFinder(id)
    .matchEntireCell(true)
    .findNext();
  return match ? match.getRow() : 0;
}

function transactionToRow_(transaction) {
  const serializable = Object.assign({}, transaction, {
    itineraryJson: JSON.stringify(transaction.itinerary || []),
    templateCompletionJson: JSON.stringify(transaction.templateCompletion || {})
  });
  return TRANSACTION_HEADERS.map(header => String(serializable[header] == null ? '' : serializable[header]));
}

function rowToTransaction_(row) {
  const stored = {};
  TRANSACTION_HEADERS.forEach((header, index) => stored[header] = row[index] == null ? '' : String(row[index]));
  const transaction = {};
  INPUT_FIELDS.forEach(field => transaction[field] = stored[field]);
  transaction.id = stored.id;
  transaction.totalAmount = Number(stored.totalAmount || 0);
  transaction.itinerary = parseJsonCell_(stored.itineraryJson, []);
  transaction.templateCompletion = normalizeTemplateCompletion_(parseJsonCell_(stored.templateCompletionJson, {}));
  transaction.status = stored.status === 'Done' ? 'Done' : 'Draft';
  transaction.createdAt = stored.createdAt;
  transaction.updatedAt = stored.updatedAt;
  transaction.createdBy = stored.createdBy;
  transaction.updatedBy = stored.updatedBy;
  transaction.deletedAt = stored.deletedAt;
  return transaction;
}

function parseJsonCell_(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch (error) {
    return fallback;
  }
}

function getSettings_() {
  const sheet = settingsSheet_();
  if (sheet.getLastRow() < 2) return DEFAULT_SETTINGS;
  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, SETTINGS_HEADERS.length).getValues();
  const row = values.find(item => String(item[0]) === 'signatories');
  return row ? normalizeSettings_(parseJsonCell_(String(row[1] || ''), DEFAULT_SETTINGS)) : DEFAULT_SETTINGS;
}

function saveSettings_(input, userEmail) {
  const settings = normalizeSettings_(input);
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sheet = settingsSheet_();
    const values = sheet.getLastRow() < 2 ? [] : sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues();
    const index = values.findIndex(row => String(row[0]) === 'signatories');
    const rowNumber = index >= 0 ? index + 2 : sheet.getLastRow() + 1;
    sheet.getRange(rowNumber, 1, 1, SETTINGS_HEADERS.length)
      .setNumberFormat('@')
      .setValues([['signatories', JSON.stringify(settings), new Date().toISOString(), userEmail]]);
    return settings;
  } finally {
    lock.releaseLock();
  }
}

function normalizeSettings_(input) {
  const source = input && typeof input === 'object' ? input : DEFAULT_SETTINGS;
  const settings = {};
  ['mayor', 'accountant', 'treasurer', 'budget'].forEach(key => {
    const fallback = DEFAULT_SETTINGS[key];
    const value = source[key] && typeof source[key] === 'object' ? source[key] : fallback;
    settings[key] = {
      name: cleanText_(value.name == null ? fallback.name : value.name, 500),
      pos: cleanText_(value.pos == null ? fallback.pos : value.pos, 500)
    };
  });
  return settings;
}

function jsonResponse_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON);
}

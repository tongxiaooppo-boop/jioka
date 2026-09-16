/**
 * 揪咖 JioKa — Google Apps Script 後端
 * 部署方式請見 README.md
 *
 * 功能：揪團排程投票（日期+時段 / 地點）、留言、即時統計、管理後台
 * 資料層：Google 試算表（Events / Options / Votes / Comments / Participants）
 */

// ===================== 基本設定 =====================
// 【部署前必改】填入你的 Google OAuth 2.0 Client ID（Web 應用程式類型）
const GOOGLE_CLIENT_ID = 'YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com';

const SHEET_ID_PROP = 'JIOKA_SPREADSHEET_ID';
const HEADERS = {
  Events: ['event_id', 'title', 'type', 'description', 'status', 'deadline',
    'confirmed_date_id', 'confirmed_place_id', 'admin_email', 'co_admin_emails',
    'created_at', 'updated_at'],
  Options: ['option_id', 'event_id', 'option_type', 'date', 'time_slot',
    'place_name', 'map_link', 'created_by', 'created_at', 'is_deleted'],
  Votes: ['event_id', 'option_id', 'user_email', 'nickname', 'voted_at'],
  Comments: ['comment_id', 'event_id', 'option_id', 'user_email', 'nickname',
    'content', 'created_at', 'is_deleted'],
  Participants: ['event_id', 'user_email', 'nickname', 'joined_at', 'last_visit_at'],
};
const EVENT_ID_LEN = 8;
// 這些欄位存的是日期/ID/Email 這類「看起來像日期或數字」的字串，
// 若欄位格式是「自動」，Google 試算表可能自動轉成 Date 或數字，打壞字串解析（例如 optionLabel 的 date.split('-')）
// 所以 setup() 時一律鎖成純文字格式
const TEXT_COLUMNS = {
  Events: ['event_id', 'deadline', 'confirmed_date_id', 'confirmed_place_id',
    'admin_email', 'co_admin_emails', 'created_at', 'updated_at'],
  Options: ['option_id', 'event_id', 'date', 'created_by', 'created_at'],
  Votes: ['event_id', 'option_id', 'user_email', 'voted_at'],
  Comments: ['comment_id', 'event_id', 'option_id', 'user_email', 'created_at'],
  Participants: ['event_id', 'user_email', 'joined_at', 'last_visit_at'],
};

// ===================== 初始化（手動執行一次） =====================
/**
 * 第一次部署前，請在 Apps Script 編輯器選擇此函式並「執行」，
 * 會自動建立試算表與 5 張工作表，並把試算表 ID 存入 Script Properties。
 * 執行後查看「執行記錄」可取得試算表網址。
 */
function setup() {
  const props = PropertiesService.getScriptProperties();
  let ssId = props.getProperty(SHEET_ID_PROP);
  let ss;
  if (ssId) {
    ss = SpreadsheetApp.openById(ssId);
  } else {
    ss = SpreadsheetApp.create('揪咖 JioKa 資料庫');
    ssId = ss.getId();
    props.setProperty(SHEET_ID_PROP, ssId);
  }
  Object.keys(HEADERS).forEach(function (name) {
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    const headers = HEADERS[name];
    const firstCell = sh.getRange(1, 1).getValue();
    if (firstCell !== headers[0]) {
      sh.getRange(1, 1, 1, headers.length).setValues([headers]);
      sh.setFrozenRows(1);
    }
    // 避免試算表自動把日期/ID字串轉型，整欄鎖成純文字
    (TEXT_COLUMNS[name] || []).forEach(function (col) {
      const idx = headers.indexOf(col);
      if (idx >= 0) sh.getRange(1, idx + 1, sh.getMaxRows(), 1).setNumberFormat('@');
    });
  });
  const def = ss.getSheetByName('Sheet1') || ss.getSheetByName('工作表1');
  if (def && ss.getSheets().length > 1) ss.deleteSheet(def);
  Logger.log('✅ 初始化完成！試算表網址：' + ss.getUrl());
  return ss.getUrl();
}

// ===================== HTTP 進入點 =====================
function doGet(e) { return handleRequest(e); }
function doPost(e) { return handleRequest(e); }

function handleRequest(e) {
  try {
    const params = parseParams(e);
    const action = params.action || 'ping';
    const handler = API_HANDLERS[action];
    if (!handler) return jsonErr('BAD_REQUEST', '未知的 action: ' + action);
    return jsonOk(handler(params));
  } catch (err) {
    if (err && err.apiCode) return jsonErr(err.apiCode, err.message);
    console.error(err);
    return jsonErr('INTERNAL', '伺服器內部錯誤：' + (err && err.message ? err.message : String(err)));
  }
}

function parseParams(e) {
  if (e && e.postData && e.postData.contents) {
    try { return JSON.parse(e.postData.contents); } catch (ignore) { /* fallthrough */ }
  }
  return (e && e.parameter) || {};
}

// ===================== 回應與錯誤工具 =====================
function jsonOk(data) { return jsonOut({ ok: true, data: data }); }
function jsonErr(code, message) { return jsonOut({ ok: false, error: { code: code, message: message } }); }
function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
function fail(code, message) { const e = new Error(message); e.apiCode = code; throw e; }

// ===================== 通用工具 =====================
function nowIso() { return new Date().toISOString(); }
function genId(len) {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 去掉易混淆字元
  let s = '';
  for (let i = 0; i < len; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}
function str(v) { return (v === null || v === undefined) ? '' : String(v); }
function normEmail(v) { return str(v).trim().toLowerCase(); }
// ===================== 試算表存取層（Repository） =====================
let _ss = null;
function getSs() {
  if (_ss) return _ss;
  const id = PropertiesService.getScriptProperties().getProperty(SHEET_ID_PROP);
  if (!id) fail('INTERNAL', '後端尚未初始化，請先在 Apps Script 執行 setup()');
  _ss = SpreadsheetApp.openById(id);
  return _ss;
}
/** 讀整張表，回傳物件陣列（每列附 __row 供更新用） */
function readTable(name) {
  const values = getSs().getSheetByName(name).getDataRange().getValues();
  if (values.length < 2) return [];
  const headers = values[0];
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const obj = { __row: i + 1 };
    for (let j = 0; j < headers.length; j++) obj[headers[j]] = values[i][j];
    rows.push(obj);
  }
  return rows;
}
function appendRow(name, obj) {
  const headers = HEADERS[name];
  const sh = getSs().getSheetByName(name);
  const rowValues = headers.map(function (h) {
    return obj[h] !== undefined ? obj[h] : '';
  });
  // 注意：Sheet.appendRow() 即使欄位已鎖純文字格式，仍會自動把像日期的字串轉成 Date，
  // 改用 Range.setValues() 寫入才會遵守 setup() 設定的純文字格式（跟 updateRowCells 一致）
  sh.getRange(sh.getLastRow() + 1, 1, 1, rowValues.length).setValues([rowValues]);
}
function updateRowCells(name, rowIndex, patch) {
  const sh = getSs().getSheetByName(name);
  const headers = HEADERS[name];
  Object.keys(patch).forEach(function (key) {
    const col = headers.indexOf(key);
    if (col >= 0) sh.getRange(rowIndex, col + 1).setValue(patch[key]);
  });
}

// ===================== 身分驗證（Google ID Token） =====================
function sha256hex(text) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text);
  return bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}
/** 驗證 Google ID token，回傳 {email, name}；結果快取 25 分鐘減少 tokeninfo 呼叫 */
function verifyToken(idToken) {
  if (!idToken) fail('INVALID_TOKEN', '缺少登入憑證，請先登入');
  const cache = CacheService.getScriptCache();
  const key = 'tok_' + sha256hex(str(idToken)).substring(0, 40);
  const cached = cache.get(key);
  if (cached) return JSON.parse(cached);
  const resp = UrlFetchApp.fetch(
    'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken),
    { muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) fail('INVALID_TOKEN', '登入憑證無效或已過期，請重新登入');
  const info = JSON.parse(resp.getContentText());
  if (GOOGLE_CLIENT_ID.indexOf('YOUR_') !== 0 && info.aud !== GOOGLE_CLIENT_ID) {
    fail('INVALID_TOKEN', '憑證來源不符（aud 驗證失敗）');
  }
  const user = { email: normEmail(info.email), name: str(info.name || info.email) };
  if (!user.email) fail('INVALID_TOKEN', '無法從憑證取得 Email');
  cache.put(key, JSON.stringify(user), 1500);
  return user;
}
/** 需要登入的 API 用 */
function requireUser(params) { return verifyToken(params.token); }

// ===================== 活動查詢與角色 =====================
function findEvent(eventId, allowDeleted) {
  const rows = readTable('Events');
  for (let i = 0; i < rows.length; i++) {
    if (str(rows[i].event_id) === str(eventId)) {
      if (!allowDeleted && str(rows[i].status) === 'deleted') break;
      return rows[i];
    }
  }
  fail('EVENT_NOT_FOUND', '找不到這場活動（可能已被刪除）');
}
function getRole(eventRow, email) {
  if (!email) return 'guest';
  if (normEmail(eventRow.admin_email) === email) return 'owner';
  const co = str(eventRow.co_admin_emails).split(',').map(normEmail).filter(Boolean);
  return co.indexOf(email) >= 0 ? 'coadmin' : 'user';
}
function requireRole(eventRow, email, roles, errMsg) {
  const role = getRole(eventRow, email);
  if (roles.indexOf(role) < 0) fail('FORBIDDEN', errMsg || '權限不足');
  return role;
}
function isVotingOpen(eventRow) {
  if (str(eventRow.status) !== 'open') return false;
  const dl = str(eventRow.deadline);
  if (!dl) return true;
  return new Date(dl).getTime() > Date.now();
}
/** 寫入後更新版本號（updated_at + 快取），供輕量輪詢比對 */
function touchEvent(eventRow) {
  const ver = nowIso();
  updateRowCells('Events', eventRow.__row, { updated_at: ver });
  CacheService.getScriptCache().put('ver_' + eventRow.event_id, ver, 21600);
  return ver;
}
/** 更新活動欄位並更新版本號 */
function patchEvent(eventRow, patch) {
  patch.updated_at = nowIso();
  updateRowCells('Events', eventRow.__row, patch);
  CacheService.getScriptCache().put('ver_' + eventRow.event_id, patch.updated_at, 21600);
  Object.keys(patch).forEach(function (k) { eventRow[k] = patch[k]; });
}
// ===================== 參與者輔助 =====================
function isDel(row) {
  const v = row.is_deleted;
  return v === true || str(v).toUpperCase() === 'TRUE';
}
function getParticipant(participants, email) {
  for (let i = 0; i < participants.length; i++) {
    if (normEmail(participants[i].user_email) === email) return participants[i];
  }
  return null;
}
function optionLabel(opt) {
  if (str(opt.option_type) === 'date') {
    const parts = str(opt.date).split('-');
    return Number(parts[1]) + '/' + Number(parts[2]) + ' ' + str(opt.time_slot);
  }
  return str(opt.place_name);
}

// ===================== 活動完整資料組裝 =====================
function getEventVersion(eventId) {
  const cached = CacheService.getScriptCache().get('ver_' + eventId);
  if (cached) return cached;
  return str(findEvent(eventId).updated_at);
}

function buildEventPayload(eventRow, user, ver) {
  const eventId = str(eventRow.event_id);
  const options = readTable('Options').filter(function (o) {
    return str(o.event_id) === eventId && !isDel(o);
  });
  const votes = readTable('Votes').filter(function (v) { return str(v.event_id) === eventId; });
  const participants = readTable('Participants').filter(function (p) { return str(p.event_id) === eventId; });
  const comments = readTable('Comments').filter(function (c) {
    return str(c.event_id) === eventId && !isDel(c);
  });
  const nickOf = {};
  participants.forEach(function (p) { nickOf[normEmail(p.user_email)] = str(p.nickname); });

  const dateOpts = [], placeOpts = [], optById = {};
  options.forEach(function (o) {
    optById[str(o.option_id)] = o;
    const item = {
      optionId: str(o.option_id), optionType: str(o.option_type),
      date: str(o.date), timeSlot: str(o.time_slot),
      placeName: str(o.place_name), mapLink: str(o.map_link),
      createdBy: nickOf[normEmail(o.created_by)] || '早期成員',
      createdByEmail: normEmail(o.created_by),
    };
    if (str(o.option_type) === 'date') dateOpts.push(item); else placeOpts.push(item);
  });
  dateOpts.sort(function (a, b) { return (a.date + a.timeSlot).localeCompare(b.date + b.timeSlot); });

  // 統計：每個 option 的投票者暱稱
  const votersByOpt = {};
  votes.forEach(function (v) {
    const oid = str(v.option_id);
    if (!votersByOpt[oid]) votersByOpt[oid] = [];
    if (votersByOpt[oid].indexOf(str(v.nickname)) < 0) votersByOpt[oid].push(str(v.nickname));
  });
  // 日期聚合（同日多時段合併，人數取聯集）
  const dateAgg = {};
  dateOpts.forEach(function (o) {
    if (!dateAgg[o.date]) dateAgg[o.date] = { date: o.date, voterSet: {}, slots: [] };
    const voters = votersByOpt[o.optionId] || [];
    voters.forEach(function (n) { dateAgg[o.date].voterSet[n] = true; });
    dateAgg[o.date].slots.push({ optionId: o.optionId, timeSlot: o.timeSlot, count: voters.length, voters: voters });
  });
  const totalP = participants.length;
  const dateStats = Object.keys(dateAgg).sort().map(function (d) {
    const g = dateAgg[d];
    const count = Object.keys(g.voterSet).length;
    return { date: d, voterCount: count, allOk: totalP > 0 && count === totalP, slots: g.slots };
  });
  const placeStats = placeOpts.map(function (o) {
    const voters = votersByOpt[o.optionId] || [];
    return { optionId: o.optionId, count: voters.length, voters: voters };
  });

  const myEmail = user ? user.email : null;
  const meP = myEmail ? getParticipant(participants, myEmail) : null;
  const myVotes = myEmail ? votes.filter(function (v) {
    return normEmail(v.user_email) === myEmail;
  }).map(function (v) { return str(v.option_id); }) : [];

  const cmtList = comments.map(function (c) {
    const oid = str(c.option_id);
    return {
      commentId: str(c.comment_id), optionId: oid,
      optionLabel: oid && optById[oid] ? optionLabel(optById[oid]) : '',
      nickname: str(c.nickname), content: str(c.content), createdAt: str(c.created_at),
    };
  }).sort(function (a, b) { return a.createdAt.localeCompare(b.createdAt); });

  const confD = str(eventRow.confirmed_date_id), confP = str(eventRow.confirmed_place_id);
  return {
    changed: true, updatedAt: ver || str(eventRow.updated_at),
    votingOpen: isVotingOpen(eventRow),
    event: {
      eventId: eventId, title: str(eventRow.title),
      types: str(eventRow.type).split(',').map(function (s) { return s.trim(); }).filter(Boolean),
      description: str(eventRow.description), status: str(eventRow.status),
      deadline: str(eventRow.deadline) || null,
      confirmedDateId: confD || null, confirmedPlaceId: confP || null,
      confirmedDateLabel: confD && optById[confD] ? optionLabel(optById[confD]) : '',
      confirmedPlaceName: confP && optById[confP] ? str(optById[confP].place_name) : '',
      confirmedPlaceLink: confP && optById[confP] ? str(optById[confP].map_link) : '',
      adminNickname: nickOf[normEmail(eventRow.admin_email)] || '主揪',
      participantCount: totalP, createdAt: str(eventRow.created_at),
    },
    options: { dates: dateOpts, places: placeOpts },
    stats: { dates: dateStats, places: placeStats },
    comments: cmtList,
    me: user ? {
      email: myEmail, name: user.name,
      nickname: meP ? str(meP.nickname) : null,
      role: getRole(eventRow, myEmail), votes: myVotes,
    } : null,
  };
}

// ===================== API：讀取類 =====================
function apiPing() { return { pong: true, time: nowIso() }; }

/** 取得活動完整資料；帶 since 且版本未變時只回 {changed:false} */
function apiGetEvent(params) {
  const eventId = str(params.eventId);
  if (!eventId) fail('BAD_REQUEST', '缺少 eventId');
  const ver = getEventVersion(eventId);
  if (params.since && str(params.since) === ver) return { changed: false, updatedAt: ver };
  const eventRow = findEvent(eventId);
  let user = null;
  if (params.token) { try { user = verifyToken(params.token); } catch (ignore) { user = null; } }
  return buildEventPayload(eventRow, user, ver);
}
// ===================== API：建立 / 複製活動 =====================
const EVENT_TYPES = ['一日遊', '聚餐', '聚會'];
function validDateStr(s) { return /^\d{4}-\d{2}-\d{2}$/.test(str(s)); }
function withLock(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) fail('BUSY', '系統忙碌中，請稍後再試');
  try { return fn(); } finally { lock.releaseLock(); }
}

function apiCreateEvent(params) {
  const user = requireUser(params);
  const title = str(params.title).trim();
  if (!title || title.length > 50) fail('BAD_REQUEST', '活動名稱必填（50 字內）');
  const types = (params.types || []).filter(function (t) { return EVENT_TYPES.indexOf(t) >= 0; });
  const description = str(params.description).trim().substring(0, 500);
  const deadline = str(params.deadline).trim();
  if (deadline && isNaN(new Date(deadline).getTime())) fail('BAD_REQUEST', '截止時間格式不正確');
  const dates = params.dates || [], places = params.places || [];
  if (!dates.length && !places.length) fail('BAD_REQUEST', '請至少新增一個候選日期或地點');

  return withLock(function () {
    let eventId = genId(EVENT_ID_LEN);
    const existing = readTable('Events').map(function (r) { return str(r.event_id); });
    while (existing.indexOf(eventId) >= 0) eventId = genId(EVENT_ID_LEN);
    const now = nowIso();
    appendRow('Events', {
      event_id: eventId, title: title, type: types.join(','), description: description,
      status: 'open', deadline: deadline, confirmed_date_id: '', confirmed_place_id: '',
      admin_email: user.email, co_admin_emails: '', created_at: now, updated_at: now,
    });
    dates.forEach(function (d) {
      if (!validDateStr(d.date)) return;
      appendRow('Options', {
        option_id: genId(12), event_id: eventId, option_type: 'date',
        date: str(d.date), time_slot: str(d.timeSlot).trim().substring(0, 10) || '全天',
        place_name: '', map_link: '', created_by: user.email, created_at: now, is_deleted: false,
      });
    });
    places.forEach(function (p) {
      const name = str(p.placeName).trim();
      if (!name) return;
      appendRow('Options', {
        option_id: genId(12), event_id: eventId, option_type: 'place',
        date: '', time_slot: '', place_name: name.substring(0, 50),
        map_link: str(p.mapLink).trim().substring(0, 300),
        created_by: user.email, created_at: now, is_deleted: false,
      });
    });
    // 建立者自動成為參與者（暱稱先用 Google 顯示名稱）
    appendRow('Participants', {
      event_id: eventId, user_email: user.email,
      nickname: user.name.substring(0, 20), joined_at: now, last_visit_at: now,
    });
    CacheService.getScriptCache().put('ver_' + eventId, now, 21600);
    return { eventId: eventId, updatedAt: now };
  });
}

/** 再揪一次：複製類型/說明/地點清單（日期不複製） */
function apiDuplicateEvent(params) {
  const user = requireUser(params);
  const src = findEvent(params.sourceEventId);
  const title = str(params.title).trim() || (str(src.title) + ' 再一攤');
  return apiCreateEvent({
    token: params.token, title: title,
    types: str(src.type).split(',').map(function (s) { return s.trim(); }).filter(Boolean),
    description: str(src.description),
    dates: params.dates || [],
    places: readTable('Options').filter(function (o) {
      return str(o.event_id) === str(src.event_id) && str(o.option_type) === 'place' && !isDel(o);
    }).map(function (o) { return { placeName: str(o.place_name), mapLink: str(o.map_link) }; }),
    deadline: '',
  });
}
// ===================== API：暱稱 =====================
function apiCheckNickname(params) {
  const user = requireUser(params);
  const nickname = str(params.nickname).trim();
  if (!nickname) return { available: false, reason: '暱稱不能為空' };
  const participants = readTable('Participants').filter(function (p) {
    return str(p.event_id) === str(params.eventId);
  });
  const taken = participants.some(function (p) {
    return str(p.nickname) === nickname && normEmail(p.user_email) !== user.email;
  });
  return { available: !taken, reason: taken ? '這個暱稱有人用了，換一個吧' : '' };
}

function apiSetNickname(params) {
  const user = requireUser(params);
  const eventRow = findEvent(params.eventId);
  const nickname = str(params.nickname).trim();
  if (!nickname || nickname.length > 20) fail('BAD_REQUEST', '暱稱必填（20 字內）');
  return withLock(function () {
    const participants = readTable('Participants').filter(function (p) {
      return str(p.event_id) === str(eventRow.event_id);
    });
    const taken = participants.some(function (p) {
      return str(p.nickname) === nickname && normEmail(p.user_email) !== user.email;
    });
    if (taken) fail('NICKNAME_TAKEN', '這個暱稱有人用了，換一個吧');
    const mine = getParticipant(participants, user.email);
    const now = nowIso();
    if (mine) {
      updateRowCells('Participants', mine.__row, { nickname: nickname, last_visit_at: now });
      // 同步更新此人在本活動的投票與留言暱稱
      readTable('Votes').forEach(function (v) {
        if (str(v.event_id) === str(eventRow.event_id) && normEmail(v.user_email) === user.email) {
          updateRowCells('Votes', v.__row, { nickname: nickname });
        }
      });
      readTable('Comments').forEach(function (c) {
        if (str(c.event_id) === str(eventRow.event_id) && normEmail(c.user_email) === user.email) {
          updateRowCells('Comments', c.__row, { nickname: nickname });
        }
      });
    } else {
      appendRow('Participants', {
        event_id: eventRow.event_id, user_email: user.email,
        nickname: nickname, joined_at: now, last_visit_at: now,
      });
    }
    touchEvent(eventRow);
    return { nickname: nickname };
  });
}
// ===================== API：投票 =====================
function apiSubmitVotes(params) {
  const user = requireUser(params);
  const eventRow = findEvent(params.eventId);
  if (!isVotingOpen(eventRow)) fail('EVENT_CLOSED', '投票已截止，無法再修改');
  const optionIds = (params.optionIds || []).map(str);
  return withLock(function () {
    const participants = readTable('Participants').filter(function (p) {
      return str(p.event_id) === str(eventRow.event_id);
    });
    const mine = getParticipant(participants, user.email);
    if (!mine) fail('NICKNAME_REQUIRED', '請先設定暱稱再投票');
    const validIds = readTable('Options').filter(function (o) {
      return str(o.event_id) === str(eventRow.event_id) && !isDel(o);
    }).map(function (o) { return str(o.option_id); });
    optionIds.forEach(function (oid) {
      if (validIds.indexOf(oid) < 0) fail('BAD_OPTION', '包含無效或已刪除的選項');
    });
    // 覆蓋式更新：刪掉我的舊票，寫入新票（由後往前刪避免位移）
    const sh = getSs().getSheetByName('Votes');
    const all = sh.getDataRange().getValues();
    for (let i = all.length - 1; i >= 1; i--) {
      if (str(all[i][0]) === str(eventRow.event_id) && normEmail(all[i][2]) === user.email) {
        sh.deleteRow(i + 1);
      }
    }
    const now = nowIso();
    optionIds.forEach(function (oid) {
      appendRow('Votes', {
        event_id: eventRow.event_id, option_id: oid,
        user_email: user.email, nickname: str(mine.nickname), voted_at: now,
      });
    });
    updateRowCells('Participants', mine.__row, { last_visit_at: now });
    touchEvent(eventRow);
    return { saved: true, count: optionIds.length };
  });
}

// ===================== API：選項 =====================
function apiAddOption(params) {
  const user = requireUser(params);
  const eventRow = findEvent(params.eventId);
  const role = getRole(eventRow, user.email);
  // 投票截止後僅主/次管理者可新增（配合後台擴充用途）
  if (!isVotingOpen(eventRow) && role !== 'owner' && role !== 'coadmin') {
    fail('EVENT_CLOSED', '投票已截止，無法新增選項');
  }
  const optType = str(params.optionType);
  if (optType !== 'date' && optType !== 'place') fail('BAD_REQUEST', 'optionType 需為 date 或 place');
  return withLock(function () {
    const participants = readTable('Participants').filter(function (p) {
      return str(p.event_id) === str(eventRow.event_id);
    });
    if (!getParticipant(participants, user.email)) fail('NICKNAME_REQUIRED', '請先設定暱稱');
    const existing = readTable('Options').filter(function (o) {
      return str(o.event_id) === str(eventRow.event_id) && !isDel(o);
    });
    const now = nowIso();
    if (optType === 'date') {
      if (!validDateStr(params.date)) fail('BAD_REQUEST', '日期格式需為 YYYY-MM-DD');
      const slot = str(params.timeSlot).trim().substring(0, 10) || '全天';
      const dup = existing.some(function (o) {
        return str(o.option_type) === 'date' && str(o.date) === str(params.date) && str(o.time_slot) === slot;
      });
      if (dup) return { added: false, message: '這個日期時段已存在' };
      appendRow('Options', {
        option_id: genId(12), event_id: eventRow.event_id, option_type: 'date',
        date: str(params.date), time_slot: slot, place_name: '', map_link: '',
        created_by: user.email, created_at: now, is_deleted: false,
      });
    } else {
      const name = str(params.placeName).trim();
      if (!name || name.length > 50) fail('BAD_REQUEST', '地點名稱必填（50 字內）');
      const dup = existing.some(function (o) {
        return str(o.option_type) === 'place' && str(o.place_name).toLowerCase() === name.toLowerCase();
      });
      if (dup) return { added: false, message: '這個地點已存在' };
      appendRow('Options', {
        option_id: genId(12), event_id: eventRow.event_id, option_type: 'place',
        date: '', time_slot: '', place_name: name,
        map_link: str(params.mapLink).trim().substring(0, 300),
        created_by: user.email, created_at: now, is_deleted: false,
      });
    }
    touchEvent(eventRow);
    return { added: true };
  });
}

/** 刪除選項（軟刪）：主管理者可刪任何選項；次管理者僅能刪「非主管理者建立」的選項 */
function apiDeleteOption(params) {
  const user = requireUser(params);
  const eventRow = findEvent(params.eventId);
  const role = requireRole(eventRow, user.email, ['owner', 'coadmin'], '只有管理者可以刪除選項');
  return withLock(function () {
    const opts = readTable('Options');
    for (let i = 0; i < opts.length; i++) {
      if (str(opts[i].option_id) === str(params.optionId) && str(opts[i].event_id) === str(eventRow.event_id)) {
        if (role === 'coadmin' && normEmail(opts[i].created_by) === normEmail(eventRow.admin_email)) {
          fail('FORBIDDEN', '次管理者不能刪除主管理者建立的選項');
        }
        updateRowCells('Options', opts[i].__row, { is_deleted: true });
        touchEvent(eventRow);
        return { deleted: true };
      }
    }
    fail('BAD_REQUEST', '找不到該選項');
  });
}
// ===================== API：留言 =====================
function apiAddComment(params) {
  const user = requireUser(params);
  const eventRow = findEvent(params.eventId);
  if (!isVotingOpen(eventRow)) fail('EVENT_CLOSED', '投票已截止，留言一併關閉');
  const content = str(params.content).trim();
  if (!content || content.length > 500) fail('BAD_REQUEST', '留言必填（500 字內）');
  const optionId = str(params.optionId);
  return withLock(function () {
    const participants = readTable('Participants').filter(function (p) {
      return str(p.event_id) === str(eventRow.event_id);
    });
    const mine = getParticipant(participants, user.email);
    if (!mine) fail('NICKNAME_REQUIRED', '請先設定暱稱再留言');
    if (optionId) {
      const found = readTable('Options').some(function (o) {
        return str(o.option_id) === optionId && str(o.event_id) === str(eventRow.event_id) && !isDel(o);
      });
      if (!found) fail('BAD_OPTION', '留言對應的選項不存在');
    }
    appendRow('Comments', {
      comment_id: genId(12), event_id: eventRow.event_id, option_id: optionId,
      user_email: user.email, nickname: str(mine.nickname),
      content: content, created_at: nowIso(), is_deleted: false,
    });
    updateRowCells('Participants', mine.__row, { last_visit_at: nowIso() });
    touchEvent(eventRow);
    return { added: true };
  });
}

/** 刪除留言（軟刪）：僅主/次管理者（留言者本人不可刪，避免滅證） */
function apiDeleteComment(params) {
  const user = requireUser(params);
  const eventRow = findEvent(params.eventId);
  requireRole(eventRow, user.email, ['owner', 'coadmin'], '只有管理者可以刪除留言');
  return withLock(function () {
    const rows = readTable('Comments');
    for (let i = 0; i < rows.length; i++) {
      if (str(rows[i].comment_id) === str(params.commentId) && str(rows[i].event_id) === str(eventRow.event_id)) {
        updateRowCells('Comments', rows[i].__row, { is_deleted: true });
        touchEvent(eventRow);
        return { deleted: true };
      }
    }
    fail('BAD_REQUEST', '找不到該留言');
  });
}

// ===================== API：我的揪咖紀錄 =====================
function eventSummary(ev, extra) {
  const o = {
    eventId: str(ev.event_id), title: str(ev.title), status: str(ev.status),
    deadline: str(ev.deadline) || null, updatedAt: str(ev.updated_at),
    createdAt: str(ev.created_at),
  };
  if (extra) Object.keys(extra).forEach(function (k) { o[k] = extra[k]; });
  return o;
}
function apiListMyEvents(params) {
  const user = requireUser(params);
  const events = readTable('Events').filter(function (ev) { return str(ev.status) !== 'deleted'; });
  const myParticipation = readTable('Participants').filter(function (p) {
    return normEmail(p.user_email) === user.email;
  });
  const joinedIds = {};
  myParticipation.forEach(function (p) { joinedIds[str(p.event_id)] = str(p.nickname); });
  const countByEvent = {};
  readTable('Participants').forEach(function (p) {
    const k = str(p.event_id);
    countByEvent[k] = (countByEvent[k] || 0) + 1;
  });
  const owned = [], coadmin = [], joined = [];
  events.forEach(function (ev) {
    const eid = str(ev.event_id);
    const role = getRole(ev, user.email);
    const summary = eventSummary(ev, {
      participantCount: countByEvent[eid] || 0,
      myNickname: joinedIds[eid] || null,
      confirmed: str(ev.status) === 'confirmed',
    });
    if (role === 'owner') owned.push(summary);
    else if (role === 'coadmin') coadmin.push(summary);
    if (joinedIds[eid] && role === 'user') joined.push(summary);
  });
  const byTime = function (a, b) { return str(b.updatedAt).localeCompare(str(a.updatedAt)); };
  return { owned: owned.sort(byTime), coadmin: coadmin.sort(byTime), joined: joined.sort(byTime) };
}
// ===================== API：管理後台 =====================
function apiGetAdminDetail(params) {
  const user = requireUser(params);
  const eventRow = findEvent(params.eventId);
  requireRole(eventRow, user.email, ['owner', 'coadmin'], '只有管理者可以查看後台明細');
  const eventId = str(eventRow.event_id);
  const participants = readTable('Participants').filter(function (p) { return str(p.event_id) === eventId; });
  const votes = readTable('Votes').filter(function (v) { return str(v.event_id) === eventId; });
  const optById = {};
  readTable('Options').forEach(function (o) {
    if (str(o.event_id) === eventId && !isDel(o)) optById[str(o.option_id)] = o;
  });
  const voterDetails = participants.map(function (p) {
    const myVotes = votes.filter(function (v) { return normEmail(v.user_email) === normEmail(p.user_email); });
    const dateLabels = [], placeNames = [];
    let lastVoted = '';
    myVotes.forEach(function (v) {
      const o = optById[str(v.option_id)];
      if (!o) return;
      if (str(o.option_type) === 'date') dateLabels.push(optionLabel(o)); else placeNames.push(str(o.place_name));
      if (str(v.voted_at) > lastVoted) lastVoted = str(v.voted_at);
    });
    return {
      email: normEmail(p.user_email), nickname: str(p.nickname),
      dateLabels: dateLabels, placeNames: placeNames,
      joinedAt: str(p.joined_at), lastVotedAt: lastVoted,
    };
  }).sort(function (a, b) { return a.joinedAt.localeCompare(b.joinedAt); });
  return {
    coAdminEmails: str(eventRow.co_admin_emails).split(',').map(normEmail).filter(Boolean),
    adminEmail: normEmail(eventRow.admin_email),
    voterDetails: voterDetails,
  };
}

function apiUpdateEvent(params) {
  const user = requireUser(params);
  const eventRow = findEvent(params.eventId);
  requireRole(eventRow, user.email, ['owner'], '只有主管理者可以修改活動設定');
  const patch = {};
  if (params.title !== undefined) {
    const title = str(params.title).trim();
    if (!title || title.length > 50) fail('BAD_REQUEST', '活動名稱必填（50 字內）');
    patch.title = title;
  }
  if (params.description !== undefined) patch.description = str(params.description).trim().substring(0, 500);
  if (params.types !== undefined) {
    patch.type = (params.types || []).filter(function (t) { return EVENT_TYPES.indexOf(t) >= 0; }).join(',');
  }
  return withLock(function () {
    patchEvent(eventRow, patch);
    return { updated: true };
  });
}

/** 設定/延長截止時間（主管理者）。設為未來時間時若已截止會自動重新開放。 */
function apiSetDeadline(params) {
  const user = requireUser(params);
  const eventRow = findEvent(params.eventId);
  requireRole(eventRow, user.email, ['owner'], '只有主管理者可以調整截止時間');
  const deadline = str(params.deadline).trim();
  if (deadline && isNaN(new Date(deadline).getTime())) fail('BAD_REQUEST', '截止時間格式不正確');
  return withLock(function () {
    const patch = { deadline: deadline };
    if (str(eventRow.status) === 'closed' && (!deadline || new Date(deadline).getTime() > Date.now())) {
      patch.status = 'open';
    }
    patchEvent(eventRow, patch);
    return { updated: true, status: str(patch.status || eventRow.status) };
  });
}

/** 立即提前結束投票（主管理者） */
function apiCloseEvent(params) {
  const user = requireUser(params);
  const eventRow = findEvent(params.eventId);
  requireRole(eventRow, user.email, ['owner'], '只有主管理者可以提前結束投票');
  return withLock(function () {
    patchEvent(eventRow, { status: 'closed' });
    return { closed: true };
  });
}
function apiManageCoAdmins(params) {
  const user = requireUser(params);
  const eventRow = findEvent(params.eventId);
  requireRole(eventRow, user.email, ['owner'], '只有主管理者可以指定次管理者');
  return withLock(function () {
    const current = str(eventRow.co_admin_emails).split(',').map(normEmail).filter(Boolean);
    (params.add || []).forEach(function (e) {
      const em = normEmail(e);
      if (!em || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) fail('BAD_REQUEST', 'Email 格式不正確：' + e);
      if (em === normEmail(eventRow.admin_email)) return;
      if (current.indexOf(em) < 0) current.push(em);
    });
    (params.remove || []).forEach(function (e) {
      const idx = current.indexOf(normEmail(e));
      if (idx >= 0) current.splice(idx, 1);
    });
    patchEvent(eventRow, { co_admin_emails: current.join(',') });
    return { coAdminEmails: current };
  });
}

/** 標記最終確定方案（主管理者）；dateId/placeId 可傳空字串代表不指定 */
function apiConfirmResult(params) {
  const user = requireUser(params);
  const eventRow = findEvent(params.eventId);
  requireRole(eventRow, user.email, ['owner'], '只有主管理者可以標記最終方案');
  const dateId = str(params.confirmedDateId), placeId = str(params.confirmedPlaceId);
  if (!dateId && !placeId) fail('BAD_REQUEST', '請至少確定日期或地點其中一項');
  const validIds = readTable('Options').filter(function (o) {
    return str(o.event_id) === str(eventRow.event_id) && !isDel(o);
  }).map(function (o) { return str(o.option_id); });
  if (dateId && validIds.indexOf(dateId) < 0) fail('BAD_OPTION', '指定的日期選項不存在');
  if (placeId && validIds.indexOf(placeId) < 0) fail('BAD_OPTION', '指定的地點選項不存在');
  return withLock(function () {
    patchEvent(eventRow, { confirmed_date_id: dateId, confirmed_place_id: placeId, status: 'confirmed' });
    return { confirmed: true };
  });
}

/** 刪除整場活動（軟刪，主管理者） */
function apiDeleteEvent(params) {
  const user = requireUser(params);
  const eventRow = findEvent(params.eventId);
  requireRole(eventRow, user.email, ['owner'], '只有主管理者可以刪除活動');
  return withLock(function () {
    patchEvent(eventRow, { status: 'deleted' });
    CacheService.getScriptCache().remove('ver_' + eventRow.event_id);
    return { deleted: true };
  });
}

// ===================== API：匯出 CSV =====================
function csvCell(v) {
  const s = str(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function apiExportCsv(params) {
  const user = requireUser(params);
  const eventRow = findEvent(params.eventId);
  requireRole(eventRow, user.email, ['owner', 'coadmin'], '只有管理者可以匯出');
  const detail = apiGetAdminDetail(params);
  const lines = ['\uFEFF暱稱,Email,可參加的日期時段,選擇的地點,最後投票時間'];
  detail.voterDetails.forEach(function (v) {
    lines.push([v.nickname, v.email, v.dateLabels.join('；'), v.placeNames.join('；'), v.lastVotedAt]
      .map(csvCell).join(','));
  });
  return { filename: 'jioka-' + eventRow.event_id + '.csv', csv: lines.join('\n') };
}

// ===================== API 路由表 =====================
const API_HANDLERS = {
  ping: apiPing,
  getEvent: apiGetEvent,
  createEvent: apiCreateEvent,
  duplicateEvent: apiDuplicateEvent,
  checkNickname: apiCheckNickname,
  setNickname: apiSetNickname,
  submitVotes: apiSubmitVotes,
  addOption: apiAddOption,
  deleteOption: apiDeleteOption,
  addComment: apiAddComment,
  deleteComment: apiDeleteComment,
  listMyEvents: apiListMyEvents,
  getAdminDetail: apiGetAdminDetail,
  updateEvent: apiUpdateEvent,
  setDeadline: apiSetDeadline,
  closeEvent: apiCloseEvent,
  manageCoAdmins: apiManageCoAdmins,
  confirmResult: apiConfirmResult,
  deleteEvent: apiDeleteEvent,
  exportCsv: apiExportCsv,
};









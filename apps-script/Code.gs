/**
 * Cybertrace Check-in — Google Form → API bridge.
 *
 * Bind this script to ONE event's Google Form (Form → ⋮ → Script editor).
 * Setup steps are in the project README ("Connect a Google Form").
 *
 * Script Properties (Project Settings → Script Properties):
 *   API_URL      https://<your-app>.vercel.app/api/form-submit
 *   EVENT_SLUG   e.g. mini-ctf-2026   (Admin page shows it)
 *   FORM_SECRET  the event's secret   (Admin page → Show / Copy)
 *   ENROLLMENT_QUESTION  (optional) exact title of the "what do you enroll in"
 *                        checkbox question. If not set, the first checkbox
 *                        question in the form is used.
 *
 * Functions you run by hand from the editor:
 *   setup()           install the triggers (run once; safe to re-run)
 *   testConnection()  check API_URL / EVENT_SLUG / FORM_SECRET
 *   syncAll()         re-send every existing response (idempotent)
 *   showPending()     log responses waiting to be retried
 *   retryPending()    retry now (also runs automatically every 5 minutes, and
 *                     nudges the app to send any QR emails still waiting)
 */

// Exact question titles in the form (matching is case-insensitive). The first
// title found in the form is used.
var QUESTIONS = {
  full_name: ['Full name'],
  email: ['Email'],
  phone: ['Phone', 'Phone number'],
  class_year: ['Class / Year'],
  study: ['Academic field', 'Academic level'], // joined with academic_year into class_year
  academic_year: ['Academic year'],
  team_name: ['Team name']
};

var PENDING_KEY = 'PENDING_RESPONSES'; // JSON: { "<responseId>": { attempts, lastError, since } }

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------

/** Installable trigger: runs on every new form response. */
function onFormSubmit(e) {
  var response = e && e.response ? e.response : null;
  if (!response) {
    console.error('onFormSubmit called without e.response — use setup() to install the trigger.');
    return;
  }
  var result = postResponse_(response);
  if (!result.ok) {
    addPending_(response.getId(), result.error);
    console.warn('Queued for retry: ' + response.getId() + ' — ' + result.error);
  }
}

/** Time-driven trigger (every 5 minutes): retry responses that failed to post, and nudge the email queue. */
function retryPending() {
  pingQueue_();
  // Document lock = "only one retry run at a time". The pending list itself is
  // guarded by the (separate) script lock, held only for milliseconds, so new
  // submissions are never blocked by a long retry run.
  var lock = LockService.getDocumentLock();
  if (!lock || !lock.tryLock(1000)) return; // another retry is running
  try {
    var pending = readPending_();
    var ids = Object.keys(pending);
    if (!ids.length) return;
    var form = FormApp.getActiveForm();
    var started = Date.now();
    ids.forEach(function (id) {
      if (Date.now() - started > 4 * 60 * 1000) return; // stay well under the 6-minute limit
      var response;
      try {
        response = form.getResponse(id);
      } catch (err) {
        response = null;
      }
      if (!response) {
        console.warn('Response ' + id + ' no longer exists in the form; dropping it.');
        updatePending_(function (p) { delete p[id]; });
        return;
      }
      var result = postResponse_(response);
      updatePending_(function (p) {
        if (result.ok) {
          delete p[id];
        } else if (p[id]) {
          p[id].attempts = (p[id].attempts || 0) + 1;
          p[id].lastError = result.error;
        }
      });
      console.log((result.ok ? 'Retried OK: ' : 'Still failing: ') + id + (result.ok ? '' : ' — ' + result.error));
    });
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Manual helpers
// ---------------------------------------------------------------------------

/** Run once after pasting the script and setting the Script Properties. */
function setup() {
  checkConfig_();
  var form = FormApp.getActiveForm();
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var fn = t.getHandlerFunction();
    if (fn === 'onFormSubmit' || fn === 'retryPending') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('onFormSubmit').forForm(form).onFormSubmit().create();
  ScriptApp.newTrigger('retryPending').timeBased().everyMinutes(5).create();
  console.log('Triggers installed: onFormSubmit (on submit) + retryPending (every 5 minutes).');
  testConnection();
}

/** Posts a payload without response_id: HTTP 400 means URL + slug + secret are right (nothing is created). */
function testConnection() {
  var cfg = checkConfig_();
  var res = UrlFetchApp.fetch(cfg.apiUrl, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'X-Form-Secret': cfg.secret },
    payload: JSON.stringify({ event_slug: cfg.slug }), // no response_id → 400 if the secret is right
    muteHttpExceptions: true,
    followRedirects: false
  });
  var code = res.getResponseCode();
  if (code === 400) console.log('OK — API reachable, event slug and secret accepted.');
  else if (code === 401) console.error('WRONG EVENT_SLUG or FORM_SECRET (HTTP 401). Copy them again from the Admin page.');
  else console.error('Unexpected HTTP ' + code + ' from ' + cfg.apiUrl + ': ' + res.getContentText().slice(0, 300));
}

/** Re-send every response in the form. Safe: the API is idempotent on response_id. */
function syncAll() {
  var responses = FormApp.getActiveForm().getResponses();
  var ok = 0, failed = 0;
  responses.forEach(function (r) {
    var result = postResponse_(r);
    if (result.ok) {
      ok++;
      updatePending_(function (p) { delete p[r.getId()]; });
    } else {
      failed++;
      addPending_(r.getId(), result.error);
    }
    Utilities.sleep(150); // be gentle
  });
  console.log('syncAll: ' + ok + ' OK, ' + failed + ' queued for retry (of ' + responses.length + ').');
}

function showPending() {
  var p = readPending_();
  var ids = Object.keys(p);
  console.log(ids.length + ' pending');
  ids.forEach(function (id) { console.log(id + ' ' + JSON.stringify(p[id])); });
}

/** Danger: forget all pending retries. */
function clearPending() {
  PropertiesService.getScriptProperties().deleteProperty(PENDING_KEY);
  console.log('Pending list cleared.');
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Ask the app to send any QR emails still waiting in its queue (cheap, safe to repeat). */
function pingQueue_() {
  try {
    var cfg = checkConfig_();
    UrlFetchApp.fetch(cfg.apiUrl, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'X-Form-Secret': cfg.secret },
      payload: JSON.stringify({ event_slug: cfg.slug, ping: true }),
      muteHttpExceptions: true,
      followRedirects: false
    });
  } catch (err) {
    console.warn('Queue ping failed: ' + err);
  }
}

function checkConfig_() {
  var props = PropertiesService.getScriptProperties();
  var apiUrl = (props.getProperty('API_URL') || '').trim();
  var slug = (props.getProperty('EVENT_SLUG') || '').trim();
  var secret = (props.getProperty('FORM_SECRET') || '').trim();
  var missing = [];
  if (!apiUrl) missing.push('API_URL');
  if (!slug) missing.push('EVENT_SLUG');
  if (!secret) missing.push('FORM_SECRET');
  if (missing.length) throw new Error('Missing Script Properties: ' + missing.join(', '));
  if (apiUrl.indexOf('https://') !== 0) throw new Error('API_URL must start with https://');
  return { apiUrl: apiUrl, slug: slug, secret: secret };
}

function buildPayload_(response, slug) {
  var answers = {};
  var enrollment = '';
  var enrollTitle = String(PropertiesService.getScriptProperties().getProperty('ENROLLMENT_QUESTION') || '').trim().toLowerCase();
  response.getItemResponses().forEach(function (ir) {
    var item = ir.getItem();
    var title = String(item.getTitle() || '').trim().toLowerCase();
    var value = ir.getResponse();
    if (Array.isArray(value)) value = value.join(', ');
    value = value == null ? '' : String(value).trim();
    answers[title] = value;
    var isEnroll = enrollTitle ? title === enrollTitle : item.getType() === FormApp.ItemType.CHECKBOX;
    if (isEnroll && !enrollment) enrollment = value;
  });
  var get = function (key) {
    var titles = QUESTIONS[key];
    for (var i = 0; i < titles.length; i++) {
      var v = answers[titles[i].toLowerCase()];
      if (v) return v;
    }
    return '';
  };

  var classYear = get('class_year');
  if (!classYear) {
    var year = get('academic_year');
    classYear = [get('study'), year ? 'Year ' + year : ''].filter(Boolean).join(' · ');
  }

  var email = get('email');
  if (!email) {
    try { email = response.getRespondentEmail() || ''; } catch (err) { email = ''; }
  }
  return {
    event_slug: slug,
    response_id: response.getId(),
    full_name: get('full_name'),
    email: email,
    phone: get('phone'),
    class_year: classYear,
    team_name: get('team_name'),
    enrollment: enrollment
  };
}

/** Returns { ok: true } or { ok: false, error: '...' }. Never throws. */
function postResponse_(response) {
  try {
    var cfg = checkConfig_();
    var payload = buildPayload_(response, cfg.slug);
    var res = UrlFetchApp.fetch(cfg.apiUrl, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'X-Form-Secret': cfg.secret },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
      followRedirects: false
    });
    var code = res.getResponseCode();
    if (code >= 200 && code < 300) return { ok: true };
    return { ok: false, error: 'HTTP ' + code + ': ' + res.getContentText().slice(0, 200) };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
}

function readPending_() {
  var raw = PropertiesService.getScriptProperties().getProperty(PENDING_KEY);
  if (!raw) return {};
  try { return JSON.parse(raw) || {}; } catch (err) { return {}; }
}

/** Read-modify-write the pending list under a lock (submits can run concurrently). */
function updatePending_(mutate) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var p = readPending_();
    mutate(p);
    var props = PropertiesService.getScriptProperties();
    if (Object.keys(p).length) props.setProperty(PENDING_KEY, JSON.stringify(p));
    else props.deleteProperty(PENDING_KEY);
  } finally {
    lock.releaseLock();
  }
}

function addPending_(id, error) {
  updatePending_(function (p) {
    var cur = p[id] || { attempts: 0, since: new Date().toISOString() };
    cur.attempts = (cur.attempts || 0) + 1;
    cur.lastError = String(error || '').slice(0, 200);
    p[id] = cur;
  });
}

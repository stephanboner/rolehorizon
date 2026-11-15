/**
 * RoleHorizon – Google Apps Script backend.
 * Verwendet ausschliesslich das vorhandene Google Sheet als Datenquelle.
 * Web-App bitte mit Zugriff "Nur ich" bereitstellen.
 */
const ROLEHORIZON_CONFIG = Object.freeze({
  spreadsheetId: PropertiesService.getScriptProperties().getProperty('ROLEHORIZON_SHEET_ID') || '',
  sheetName: 'Stellen',
  columns: [
    'Firma', 'Jobtitel', 'Über die Firma', 'Jobbeschreibung',
    'Anforderungen', 'Einschätzung', 'Beworben',
    'Bemerkungen', 'Link'
  ]
});

/** Only non-secret URLs are returned to the user interface. */
function getPublicConfig() {
  const props = PropertiesService.getScriptProperties();
  const sheetId = String(props.getProperty('ROLEHORIZON_SHEET_ID') || '').trim();
  const formUrl = String(props.getProperty('ROLEHORIZON_FORM_URL') || '').trim();
  return {
    sheetUrl: sheetId ? 'https://docs.google.com/spreadsheets/d/' + encodeURIComponent(sheetId) + '/edit' : '',
    formUrl: /^https:\/\//i.test(formUrl) ? formUrl : ''
  };
}

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('RoleHorizon – meine Stellen')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function sheet_() {
  if (!ROLEHORIZON_CONFIG.spreadsheetId) throw new Error('Configure ROLEHORIZON_SHEET_ID in Script Properties.');
  const ss = SpreadsheetApp.openById(ROLEHORIZON_CONFIG.spreadsheetId);
  const sheet = ss.getSheetByName(ROLEHORIZON_CONFIG.sheetName);
  if (!sheet) throw new Error('Tab "Stellen" nicht gefunden.');
  const headers = sheet.getRange(1, 1, 1, 9).getDisplayValues()[0];
  ROLEHORIZON_CONFIG.columns.forEach((expected, index) => {
    if (headers[index].trim() !== expected) {
      throw new Error(
        'Unerwartete Spalte ' + (index + 1) + ': "' + headers[index] +
        '" statt "' + expected + '". Bitte Tabellenüberschriften prüfen.'
      );
    }
  });
  const trackingHeaders = sheet.getRange(1, 11, 1, 3).getDisplayValues()[0];
  ['Workflowstatus', 'Unterlagen erstellt am', 'iCloud-Ablage'].forEach((expected, index) => {
    if (String(trackingHeaders[index] || '').trim() !== expected) {
      throw new Error('Unerwartete Tracking-Spalte ' + (index + 11) + ': Erwartet "' + expected + '".');
    }
  });
  return sheet;
}

function revision_(cells) {
  const digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    JSON.stringify(cells.map(v => String(v || ''))),
    Utilities.Charset.UTF_8
  );
  return digest.map(b => ((b + 256) % 256).toString(16).padStart(2, '0')).join('');
}

function itemFromRow_(r, rowNumber) {
  const a = r.map(v => String(v == null ? '' : v));
  const url = a[8].trim();
  const needsReview = /^\s*⚠|AUTOMATISCH PRUEFEN|FEHLER|FAILED/i.test(a[7]) || !a[1].trim();
  return {
    rowHint: rowNumber,
    company: a[0],
    title: a[1],
    about: a[2],
    description: a[3],
    requirements: a[4],
    rating: a[5],
    applied: a[6],
    notes: a[7],
    url: url,
    workflowStatus: a[10] || '',
    preparedAt: a[11] || '',
    icloudFolder: a[12] || '',
    needsReview: needsReview,
    revision: revision_(a.slice(5, 8)),
    // Nur die ersten 9 Spalten: n8n-Aktualisierungen von K-M
    // duerfen sichere Benutzeraktionen nicht unnoetig blockieren.
    deleteRevision: revision_(a.slice(0, 9))
  };
}

/** Liste aller nichtleeren Stellen. Kein Schreibzugriff. */
function getJobs() {
  const sheet = sheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return { jobs: [], fetchedAt: new Date().toISOString() };

  const data = sheet.getRange(2, 1, lastRow - 1, 13).getDisplayValues();
  const jobs = [];
  data.forEach((r, index) => {
    if (r.slice(0, 9).some(v => String(v || '').trim())) {
      jobs.push(itemFromRow_(r, index + 2));
    }
  });
  return { jobs: jobs, fetchedAt: new Date().toISOString() };
}

/**
 * Schreibt NUR die manuell gepflegten Spalten F-H.
 * Die automatisch extrahierten Inhalte A-E und die Identität I bleiben unangetastet.
 */
function saveJob(patch) {
  if (!patch || typeof patch !== 'object') throw new Error('Leere Änderung.');
  const rating = String(patch.rating == null ? '' : patch.rating).trim();
  const applied = String(patch.applied == null ? '' : patch.applied).trim();
  const notes = String(patch.notes == null ? '' : patch.notes);
  const link = String(patch.url || '').trim();

  if (!['', 'Top', 'Mittel', 'Too stretchy', 'langweilig', 'Falscher Ort'].includes(rating)) {
    throw new Error('Ungültige Einschätzung.');
  }
  if (!['', 'Nein', 'In Vorbereitung', 'Später', 'Ja', 'Eingeladen', 'Abgelehnt', 'Archiviert'].includes(applied)) {
    throw new Error('Ungültiger Bewerbungsstatus.');
  }
  if (notes.length > 20000) throw new Error('Bemerkung ist zu lang (max. 20 000 Zeichen).');
  const rowHint = Number(patch.rowHint);
  if (!Number.isSafeInteger(rowHint) || rowHint < 2) throw new Error('Ungültige Zeilenreferenz.');

  const lock = LockService.getScriptLock();
  lock.waitLock(12000);
  try {
    const sheet = sheet_();
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) throw new Error('Keine Stellen mehr in der Tabelle.');

    // Die Zeilennummer allein ist unsicher: Nach Sortieren könnte eine
    // andere Stelle dort stehen. Deshalb immer anhand des Links suchen.
    let rowNumber;
    if (link) {
      const links = sheet.getRange(2, 9, lastRow - 1, 1).getDisplayValues();
      const found = [];
      links.forEach((r, i) => {
        if (String(r[0]).trim() === link) found.push(i + 2);
      });
      if (found.length === 0) {
        throw new Error('Stelle wurde verändert oder gelöscht. Bitte die Liste aktualisieren.');
      }
      if (found.length > 1) {
        throw new Error('Dieser Link kommt mehrfach vor. Bitte Duplikate in Google Sheets klären.');
      }
      rowNumber = found[0];
    } else {
      // Fallback für eine fehlerhafte Zeile ohne URL – nur zulassen,
      // wenn die Zeile noch genau zur geladenen Firma/Titel-Kombination passt.
      if (rowHint > lastRow) throw new Error('Zeile existiert nicht mehr. Bitte aktualisieren.');
      const identity = sheet.getRange(rowHint, 1, 1, 2).getDisplayValues()[0];
      const same = identity[0] === String(patch.company || '') &&
        identity[1] === String(patch.title || '');
      const stillNoLink = !String(sheet.getRange(rowHint, 9).getDisplayValue()).trim();
      if (!same || !stillNoLink) {
        throw new Error('Stelle hat sich verschoben. Bitte zuerst aktualisieren.');
      }
      rowNumber = rowHint;
    }

    const current = sheet.getRange(rowNumber, 6, 1, 3).getDisplayValues()[0];
    if (patch.revision && revision_(current) !== String(patch.revision)) {
      throw new Error('Diese Stelle wurde inzwischen bearbeitet. Bitte zuerst aktualisieren.');
    }

    sheet.getRange(rowNumber, 6, 1, 2).setValues([[rating, applied]]);
    // RichText bewahrt auch Eingaben wie "=SUM(...)" als reinen Text,
    // statt eine Tabellenformel auszuführen.
    if (notes === '') {
      sheet.getRange(rowNumber, 8).clearContent();
    } else {
      sheet.getRange(rowNumber, 8).setRichTextValue(
        SpreadsheetApp.newRichTextValue().setText(notes).build()
      );
    }
    SpreadsheetApp.flush();
    const updated = sheet.getRange(rowNumber, 1, 1, 13).getDisplayValues()[0];
    return itemFromRow_(updated, rowNumber);
  } finally {
    lock.releaseLock();
  }
}


/**
 * Archiviert ausschliesslich die von der App angezeigten und explizit
 * bestaetigten Stellen (Status in Spalte G).
 *
 * Jedes Ziel wird vor dem Schreiben eindeutig identifiziert und auf
 * zwischenzeitliche Bearbeitungen geprueft. Wenn EIN Ziel nicht mehr
 * stimmt, wird KEINE Stelle archiviert.
 *
 * Die Zeilen bleiben erhalten; andere Spalten und Workflows bleiben
 * unveraendert. Maximal 500 Stellen pro Aufruf.
 */
function bulkArchiveDisplayedJobs(targets) {
  if (!Array.isArray(targets) || targets.length < 1 || targets.length > 500) {
    throw new Error('Bitte 1 bis maximal 500 angezeigte Stellen auswählen.');
  }

  const patches = targets.map((target) => {
    if (!target || typeof target !== 'object') {
      throw new Error('Ungültige Stelle in der Auswahl. Bitte aktualisieren.');
    }
    const patch = {
      url: String(target.url || '').trim(),
      company: String(target.company || ''),
      title: String(target.title || ''),
      rowHint: Number(target.rowHint),
      revision: String(target.revision || ''),
      deleteRevision: String(target.deleteRevision || '')
    };
    if (!Number.isSafeInteger(patch.rowHint) || patch.rowHint < 2 ||
        !/^[a-f0-9]{64}$/i.test(patch.revision)) {
      throw new Error('Die Auswahl enthält eine veraltete Stelle. Bitte aktualisieren.');
    }
    if (!patch.url && !/^[a-f0-9]{64}$/i.test(patch.deleteRevision)) {
      throw new Error('Eine Stelle ohne Link kann nicht sicher identifiziert werden. Bitte aktualisieren.');
    }
    return patch;
  });

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sheet = sheet_();
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) throw new Error('Keine Stellen zum Archivieren vorhanden.');

    const rows = sheet.getRange(2, 1, lastRow - 1, 9).getDisplayValues();
    const byUrl = new Map();
    rows.forEach((r, index) => {
      const url = String(r[8] || '').trim();
      if (url) {
        if (!byUrl.has(url)) byUrl.set(url, []);
        byUrl.get(url).push(index);
      }
    });

    const indexes = [];
    const selected = new Set();
    for (const patch of patches) {
      let index;
      if (patch.url) {
        const matches = byUrl.get(patch.url) || [];
        if (matches.length !== 1) {
          throw new Error('Ein Stellenlink fehlt oder ist mehrfach vorhanden. Bitte zuerst die Liste aktualisieren.');
        }
        index = matches[0];
      } else {
        index = patch.rowHint - 2;
        const candidate = rows[index];
        if (!candidate || String(candidate[8] || '').trim() ||
            revision_(candidate) !== patch.deleteRevision) {
          throw new Error('Eine Stelle ohne Link wurde verändert oder verschoben. Bitte aktualisieren.');
        }
        const sameRows = rows.filter(r =>
          !String(r[8] || '').trim() && revision_(r) === patch.deleteRevision
        );
        if (sameRows.length !== 1) {
          throw new Error('Eine Stelle ohne Link ist nicht eindeutig. Bitte im Sheet klären.');
        }
      }

      if (selected.has(index)) {
        throw new Error('Eine Stelle ist mehrfach ausgewählt. Bitte aktualisieren.');
      }
      const current = rows[index].map(v => String(v == null ? '' : v));
      if (current[0] !== patch.company || current[1] !== patch.title ||
          revision_(current.slice(5, 8)) !== patch.revision) {
        throw new Error('Mindestens eine Stelle wurde inzwischen geändert. Nichts archiviert – bitte aktualisieren.');
      }
      if (current[6] === 'Archiviert') {
        throw new Error('Eine Stelle wurde bereits archiviert. Nichts geändert – bitte aktualisieren.');
      }

      selected.add(index);
      indexes.push(index);
    }

    // Nur die exakt geprüften Statuszellen in Spalte G ändern.
    // Die komplette Auswahl wird vor dem ersten Schreibzugriff geprüft.
    sheet.getRangeList(indexes.map(index => 'G' + (index + 2))).setValue('Archiviert');
    SpreadsheetApp.flush();
    const statuses = sheet.getRange(2, 7, lastRow - 1, 1).getDisplayValues();
    if (indexes.some(index => String(statuses[index][0]) !== 'Archiviert')) {
      throw new Error('Archivierung konnte nicht vollständig verifiziert werden. Bitte neu laden.');
    }
    return { archived: indexes.length };
  } finally {
    lock.releaseLock();
  }
}


/**
 * Löscht genau eine vollständige Tabellenzeile (inkl. aller Spalten).
 * - Die übermittelte Zeilennummer ist nur ein Hinweis: mit URL wird
 *   IMMER die eindeutige aktuelle Zeile über die Original-URL gesucht.
 * - Der Vollzeilen-Fingerabdruck verhindert das Löschen einer inzwischen
 *   geänderten Stelle, z. B. nach einem n8n-Update.
 * - Ohne URL nur löschen, wenn die Position und der Fingerabdruck
 *   eindeutig zur geladenen Zeile passen.
 */
function deleteJob(patch) {
  if (!patch || typeof patch !== 'object') {
    throw new Error('Keine Stelle zum Löschen angegeben.');
  }

  const link = String(patch.url || '').trim();
  const company = String(patch.company || '');
  const title = String(patch.title || '');
  const deleteRevision = String(patch.deleteRevision || '');
  const rowHint = Number(patch.rowHint);

  if (!Number.isSafeInteger(rowHint) || rowHint < 2) {
    throw new Error('Ungültige Zeilenreferenz. Bitte neu laden.');
  }
  if (!/^[a-f0-9]{64}$/i.test(deleteRevision)) {
    throw new Error('Sicherheitsprüfung fehlgeschlagen. Bitte die Stellenliste aktualisieren.');
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(12000);
  try {
    const sheet = sheet_();
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) {
      throw new Error('Die Stelle ist nicht mehr in Google Sheets vorhanden.');
    }

    const rows = sheet.getRange(2, 1, lastRow - 1, 9).getDisplayValues();
    let index = -1;

    if (link) {
      const matches = [];
      rows.forEach((row, i) => {
        if (String(row[8] || '').trim() === link) matches.push(i);
      });
      if (matches.length === 0) {
        throw new Error('Die Stelle wurde verschoben, geändert oder bereits gelöscht. Bitte aktualisieren.');
      }
      if (matches.length > 1) {
        throw new Error('Dieser Link kommt mehrfach vor. Bitte die Duplikate in Google Sheets klären.');
      }
      index = matches[0];
    } else {
      // Fehlerhafte Einträge ohne Link dürfen nicht anhand einer
      // nach dem Sortieren möglicherweise falschen Zeile gelöscht werden.
      index = rowHint - 2;
      if (index >= rows.length || String(rows[index][8] || '').trim()) {
        throw new Error('Die Stelle hat sich verschoben. Bitte aktualisieren.');
      }
      const equalRows = rows.filter(row =>
        !String(row[8] || '').trim() && revision_(row) === deleteRevision
      );
      if (equalRows.length !== 1) {
        throw new Error('Stelle ohne URL ist nicht eindeutig. Bitte in Google Sheets klären.');
      }
    }

    const current = rows[index].map(v => String(v == null ? '' : v));
    if (current[0] !== company || current[1] !== title ||
        revision_(current) !== deleteRevision) {
      throw new Error('Diese Stelle wurde inzwischen verändert. Bitte erst aktualisieren.');
    }

    // Ausschliesslich das Blatt «Stellen» ist betroffen.
    // Die komplette Zeile wird gelöscht und nachfolgende Zeilen rücken auf.
    sheet.deleteRow(index + 2);
    SpreadsheetApp.flush();
    return { deleted: true, url: link };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Startet die Bewerbung direkt aus der RoleHorizon-Web-App.
 * Der Browser bekommt weder den n8n-Webhook-Key noch die Webhook-URL.
 * Der n8n-Webhook nimmt den Auftrag entgegen; die Erstellung erfolgt danach asynchron.
 *
 * Wichtig: Apps-Script-Schreibzugriffe loesen KEINEN onEdit-Trigger aus.
 * Deshalb rufen wir n8n selbst auf, statt die Checkbox in Spalte J zu setzen.
 */
function startApplicationFromApp(request) {
  if (!request || typeof request !== 'object') throw new Error('Keine Stelle angegeben.');

  const url = String(request.url || '').trim();
  const rowHint = Number(request.rowHint);
  const fingerprint = String(request.deleteRevision || '');
  if (!/^https:\/\/[^\s]+$/i.test(url)) {
    throw new Error('Ohne gueltige HTTPS-Originalausschreibung kann keine Bewerbung gestartet werden.');
  }
  if (!Number.isSafeInteger(rowHint) || rowHint < 2 ||
      !/^[a-f0-9]{64}$/i.test(fingerprint)) {
    throw new Error('Stellenreferenz ungueltig. Bitte die App aktualisieren.');
  }

  // Bei einem eigenstaendigen Web-App-Script sind das eigene Script Properties.
  // Sie sind nicht automatisch mit dem Google-Sheets-onEdit-Script geteilt.
  const properties = PropertiesService.getScriptProperties();
  const webhookUrl = String(properties.getProperty('ROLEHORIZON_N8N_WEBHOOK_URL') || '').trim();
  const webhookKey = String(properties.getProperty('ROLEHORIZON_N8N_WEBHOOK_KEY') || '').trim();
  if (!/^https:\/\/[^\s]+$/i.test(webhookUrl) || !webhookKey) {
    throw new Error(
      'Webhook noch nicht in den Script Properties der RoleHorizon-App konfiguriert. ' +
      'ROLEHORIZON_N8N_WEBHOOK_URL und ROLEHORIZON_N8N_WEBHOOK_KEY fehlen.'
    );
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(12000);
  try {
    const sheet = sheet_();
    const lastRow = sheet.getLastRow();
    if (lastRow <= 1) throw new Error('Keine Stellen in Google Sheets gefunden.');

    // Die Zeilennummer alleine ist nach Sortieren unsicher:
    // wir finden die Stelle erneut ueber die eindeutige Original-URL.
    const rows = sheet.getRange(2, 1, lastRow - 1, 9).getDisplayValues();
    const matches = [];
    rows.forEach((row, index) => {
      if (String(row[8] || '').trim() === url) matches.push(index);
    });
    if (matches.length !== 1) {
      throw new Error('Stellenlink fehlt oder kommt mehrfach vor. Bitte die Stellenliste aktualisieren.');
    }

    const index = matches[0];
    const current = rows[index];
    if (String(current[0] || '') !== String(request.company || '') ||
        String(current[1] || '') !== String(request.title || '') ||
        revision_(current) !== fingerprint) {
      throw new Error('Diese Stelle wurde zwischenzeitlich bearbeitet. Bitte aktualisieren.');
    }

    // Absichtlich KEINE Zusammenfassung senden. Der Worker liest den
    // vollstaendigen Originaltext direkt von job_url und erstellt daraus das PDF.
    const body = {
      company: String(current[0] || '').trim(),
      position: String(current[1] || '').trim(),
      job_description: '',
      job_url: url,
      notes: String(current[7] || ''),
      spreadsheet_id: ROLEHORIZON_CONFIG.spreadsheetId,
      sheet_name: ROLEHORIZON_CONFIG.sheetName,
      row: index + 2
    };

    let response;
    try {
      response = UrlFetchApp.fetch(webhookUrl, {
        method: 'post',
        contentType: 'application/json',
        headers: { 'X-Webhook-Key': webhookKey },
        payload: JSON.stringify(body),
        muteHttpExceptions: true,
        followRedirects: false
      });
    } catch (err) {
      throw new Error('n8n ist zurzeit nicht erreichbar: ' + String(err.message || err));
    }
    const httpStatus = response.getResponseCode();
    if (httpStatus < 200 || httpStatus >= 300) {
      throw new Error('n8n hat die Bewerbung nicht angenommen (HTTP ' + httpStatus + ').');
    }

    // Erst nach erfolgreicher Annahme in n8n den Status setzen.
    // Die eigentliche Fertigstellung wird damit NICHT behauptet.
    sheet.getRange(index + 2, 7).setValue('In Vorbereitung');
    if (String(sheet.getRange(1, 11).getDisplayValue()).trim() === 'Workflowstatus') {
      sheet.getRange(index + 2, 11).setValue('Aus App gestartet');
    }
    SpreadsheetApp.flush();
    const updated = sheet.getRange(index + 2, 1, 1, 13).getDisplayValues()[0];
    return { accepted: true, job: itemFromRow_(updated, index + 2) };
  } finally {
    lock.releaseLock();
  }
}


/**
 * Neuen Arbeitgeber als Firmenquelle hinzufuegen:
 * - N8N analysiert nur einen unvertrauenswuerdigen Stellenlink/-text.
 * - Der Benutzer bestaetigt Name, Board-URL, Scanner-Typ und Aktivierung.
 * - Erst saveCompanySource schreibt ins bestehende Google Sheet.
 * Die geheime X-Webhook-Key-Eigenschaft bleibt ausschliesslich serverseitig.
 */
const COMPANY_SOURCE_TYPES = Object.freeze([
  'Auto', 'Greenhouse', 'Lever', 'Lever EU',
  'Ashby', 'HTML', 'Workable', 'Recruitee'
]);

function sourceSheet_() {
  const ss = SpreadsheetApp.openById(ROLEHORIZON_CONFIG.spreadsheetId);
  const sheet = ss.getSheetByName('Firmenquellen');
  if (!sheet) throw new Error('Tab "Firmenquellen" nicht gefunden.');
  const expected = ['Firma','Karriereseite','Typ','Kennung (falls nötig)','Aktiv'];
  const actual = sheet.getRange(1,1,1,5).getDisplayValues()[0];
  expected.forEach((name,i) => {
    if (actual[i] !== name) throw new Error('Unerwarteter Aufbau der Firmenquellen-Spalte '+(i+1));
  });
  return sheet;
}

/** Nur HTTPS, kein interner Host, keine Credentials im Link. */
function canonicalCompanySourceUrl_(candidate) {
  const url = String(candidate || '').trim().replace(/#.*$/, '');
  if (url.length > 1800 || !/^https:\/\/[a-z0-9.-]+(?::443)?(?:[/?][^\s]*)?$/i.test(url)) {
    throw new Error('Bitte eine gueltige oeffentliche HTTPS-Karriereseite eingeben.');
  }
  const hostname = (url.match(/^https:\/\/([^/:?]+)/i) || [,''])[1].toLowerCase();
  if (!hostname.includes('.') || hostname === 'localhost' ||
      /\.(local|internal|test|localhost)$/i.test(hostname) ||
      /^\d+\.\d+\.\d+\.\d+$/.test(hostname) ||
      hostname.includes('..') || url.includes('@') ||
      /[\u0000-\u001f<>"']/.test(url)) {
    throw new Error('Private oder ungueltige Karriereseiten sind nicht erlaubt.');
  }
  const normalized = url.replace(/\/+$/, '');
  return normalized;
}

function boardTypeFromUrl_(url) {
  const u = String(url || '').toLowerCase();
  if (/^https:\/\/jobs\.ashbyhq\.com\/[a-z0-9_-]+(?:\/|$)/.test(u)) return 'Ashby';
  if (/^https:\/\/jobs\.lever\.co\/[a-z0-9_-]+(?:\/|$)/.test(u)) return 'Lever';
  if (/^https:\/\/jobs\.eu\.lever\.co\/[a-z0-9_-]+(?:\/|$)/.test(u)) return 'Lever EU';
  if (/^https:\/\/(?:job-boards|boards)\.greenhouse\.io\/[a-z0-9_-]+(?:\/|$)/.test(u)) return 'Greenhouse';
  if (/^https:\/\/apply\.workable\.com\/[a-z0-9_-]+(?:\/|$)/.test(u)) return 'Workable';
  if (/^https:\/\/[a-z0-9-]+\.recruitee\.com(?:\/|$)/.test(u)) return 'Recruitee';
  return 'HTML';
}

/** Erlaubt bei bekannten ATS-Typen nur das Firmenboard, nicht ein Einzelinserat. */
function boardRootUrl_(url) {
  const u = canonicalCompanySourceUrl_(url);
  let m = u.match(/^https:\/\/jobs\.ashbyhq\.com\/([a-z0-9_-]+)/i);
  if (m) return 'https://jobs.ashbyhq.com/' + m[1];
  m = u.match(/^https:\/\/jobs\.lever\.co\/([a-z0-9_-]+)/i);
  if (m) return 'https://jobs.lever.co/' + m[1];
  m = u.match(/^https:\/\/jobs\.eu\.lever\.co\/([a-z0-9_-]+)/i);
  if (m) return 'https://jobs.eu.lever.co/' + m[1];
  m = u.match(/^https:\/\/(?:job-boards|boards)\.greenhouse\.io\/([a-z0-9_-]+)/i);
  if (m) return 'https://job-boards.greenhouse.io/' + m[1];
  m = u.match(/^https:\/\/apply\.workable\.com\/([a-z0-9_-]+)/i);
  if (m) return 'https://apply.workable.com/' + m[1];
  m = u.match(/^https:\/\/([a-z0-9-]+\.recruitee\.com)(?:\/|$)/i);
  if (m) return 'https://' + m[1];
  return null;
}

function findExistingSource_(sheet, company, url) {
  const last = sheet.getLastRow();
  if (last < 2) return null;
  const rows = sheet.getRange(2,1,last-1,2).getDisplayValues();
  const norm = s => String(s || '').trim().replace(/\/+$/, '').toLowerCase();
  const companyKey = norm(company);
  const urlKey = norm(url);
  for (let i = 0; i < rows.length; i++) {
    if (companyKey && norm(rows[i][0]) === companyKey) return {row:i+2,company:rows[i][0],url:rows[i][1],match:'Firma'};
    if (urlKey && norm(rows[i][1]) === urlKey) return {row:i+2,company:rows[i][0],url:rows[i][1],match:'Karriereseite'};
  }
  return null;
}

function researchCompanySource(request) {
  const input = String(request && request.input || '').trim();
  if (input.length < 12 || input.length > 18000) {
    throw new Error('Bitte einen Stellenlink oder einen Stellenbeschreibungstext mit 12 bis 18 000 Zeichen eingeben.');
  }
  const key = String(PropertiesService.getScriptProperties().getProperty('ROLEHORIZON_N8N_WEBHOOK_KEY') || '').trim();
  if (!key) throw new Error('ROLEHORIZON_N8N_WEBHOOK_KEY fehlt in den Apps-Script-Projekteinstellungen.');
  const webhookUrl = String(PropertiesService.getScriptProperties().getProperty('ROLEHORIZON_COMPANY_SOURCE_WEBHOOK_URL') || '').trim();
  if (!/^https:\/\/[^\s]+$/i.test(webhookUrl)) throw new Error('Configure ROLEHORIZON_COMPANY_SOURCE_WEBHOOK_URL in Script Properties.');

  let response;
  try {
    response = UrlFetchApp.fetch(webhookUrl, {
      method:'post',contentType:'application/json',
      headers:{'X-Webhook-Key':key},
      payload:JSON.stringify({input:input}),
      muteHttpExceptions:true,
      followRedirects:false
    });
  } catch (e) {
    throw new Error('Die Quellenrecherche in n8n ist derzeit nicht erreichbar: '+String(e.message||e));
  }
  if (response.getResponseCode() !== 200) {
    throw new Error('n8n hat die Quellenrecherche nicht abgeschlossen (HTTP '+response.getResponseCode()+').');
  }
  let result;
  try { result = JSON.parse(response.getContentText()); }
  catch (e) { throw new Error('Unlesbare Antwort der Quellenrecherche. Bitte erneut versuchen.'); }
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error('Die Quellenrecherche hat keine gueltige Antwort geliefert.');
  }
  const company = String(result.company || '').trim().slice(0,140);
  let url = '';
  let type = 'Auto';
  if (result.careers_url) {
    try {
      url = canonicalCompanySourceUrl_(result.careers_url);
      type = boardTypeFromUrl_(url);
    } catch (e) {
      // Keine unsicheren Links zur Vorschau oder Speicherung anbieten.
      url = '';
    }
  }
  const sheet = sourceSheet_();
  const existing = findExistingSource_(sheet,company,url);
  return {
    company:company,
    careersUrl:url,
    type:type,
    active:result.active_suggestion === 'Ja' && !existing ? 'Ja' : 'Nein',
    confidence:['high','medium','low'].includes(result.confidence) ? result.confidence : 'low',
    reason:String(result.reason || '').slice(0,750),
    evidenceUrl:/^https:\/\//i.test(String(result.evidence_url || '')) ? String(result.evidence_url).slice(0,1500) : '',
    duplicate:existing
  };
}

/** Einzige schreibende Serverfunktion: fuegt nach Benutzerbestaetigung genau eine Quelle hinzu. */
function saveCompanySource(request) {
  if (!request || typeof request !== 'object') throw new Error('Keine neue Firmenquelle angegeben.');
  const company = String(request.company || '').trim().replace(/\s+/g,' ');
  const url = canonicalCompanySourceUrl_(request.careersUrl);
  const type = String(request.type || '').trim();
  const active = String(request.active || 'Nein').trim();
  if (company.length < 2 || company.length > 140 || /^[=+@]/.test(company) ||
      /[\u0000-\u001f]/.test(company)) throw new Error('Bitte einen gueltigen Firmennamen angeben.');
  if (!COMPANY_SOURCE_TYPES.includes(type)) throw new Error('Ungueltiger Scanner-Typ.');
  if (!['Ja','Nein'].includes(active)) throw new Error('Aktiv muss Ja oder Nein sein.');
  const platformType = boardTypeFromUrl_(url);
  const fullBoard = boardRootUrl_(url);
  if (fullBoard && fullBoard.toLowerCase() !== url.toLowerCase()) {
    throw new Error('Bitte die Board-Uebersicht statt einer Einzelstelle verwenden: ' + fullBoard);
  }
  if (platformType !== 'HTML' && platformType !== type) {
    throw new Error('Die Karriereseite gehoert zum Typ '+platformType+'; bitte diesen Typ auswaehlen.');
  }
  if (active === 'Ja' && ['Workable','Recruitee'].includes(type)) {
    throw new Error(type+' wird derzeit nicht zuverlaessig automatisch gescannt. Bitte vorerst Aktiv = Nein waehlen.');
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const sheet = sourceSheet_();
    const existing = findExistingSource_(sheet,company,url);
    if (existing) throw new Error('Die Firmenquelle ist bereits vorhanden (Zeile '+existing.row+', Uebereinstimmung: '+existing.match+').');
    const row = sheet.getLastRow() + 1;
    if (row > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(),1);
    sheet.getRange(row,1,1,5).setValues([[company,url,type,'',active]]);
    sheet.getRange(row,2).setRichTextValue(
      SpreadsheetApp.newRichTextValue().setText(url).setLinkUrl(url).build()
    );
    SpreadsheetApp.flush();
    const saved = sheet.getRange(row,1,1,5).getDisplayValues()[0];
    if (saved[0] !== company || saved[1] !== url || saved[2] !== type || saved[4] !== active) {
      throw new Error('Firmenquelle wurde nicht wie erwartet geschrieben. Bitte Sheet pruefen.');
    }
    return {saved:true,row:row,company:saved[0],careersUrl:saved[1],type:saved[2],active:saved[4]};
  } finally {
    lock.releaseLock();
  }
}

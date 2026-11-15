/**
 * RoleHorizon workspace initializer.
 * Run once after setting Script Property ROLEHORIZON_SHEET_ID.
 * It creates missing tabs and headers; it never clears existing data.
 */
const ROLEHORIZON_SHEETS = Object.freeze({
  Stellen: [
    'Firma', 'Jobtitel', 'Über die Firma', 'Jobbeschreibung', 'Anforderungen',
    'Einschätzung', 'Beworben', 'Bemerkungen', 'Link',
    'Bewerbung vorbereiten', 'Workflowstatus', 'Unterlagen erstellt am', 'iCloud-Ablage'
  ],
  Firmenquellen: ['Firma', 'Karriereseite', 'Typ', 'Kennung (falls nötig)', 'Aktiv'],
  Scanprotokoll: ['Zeitpunkt', 'Firma', 'Karriereseite', 'Typ', 'Gefundene Jobs', 'Status', 'Hinweis']
});

function setupRoleHorizonWorkbook() {
  const spreadsheetId = String(PropertiesService.getScriptProperties()
    .getProperty('ROLEHORIZON_SHEET_ID') || '').trim();
  if (!spreadsheetId) throw new Error('Set ROLEHORIZON_SHEET_ID in Project Settings > Script Properties first.');
  const ss = SpreadsheetApp.openById(spreadsheetId);
  const outcome = [];

  Object.keys(ROLEHORIZON_SHEETS).forEach(tabName => {
    const headers = ROLEHORIZON_SHEETS[tabName];
    let sheet = ss.getSheetByName(tabName);
    const created = !sheet;
    if (!sheet) sheet = ss.insertSheet(tabName);
    if (sheet.getMaxColumns() < headers.length) {
      sheet.insertColumnsAfter(sheet.getMaxColumns(), headers.length - sheet.getMaxColumns());
    }
    const range = sheet.getRange(1, 1, 1, headers.length);
    const actual = range.getDisplayValues()[0].map(value => String(value).trim());
    if (actual.some(Boolean) && actual.some((value, index) => value !== headers[index])) {
      throw new Error('Tab "' + tabName + '" has unexpected headers. No data was overwritten.');
    }
    if (!actual.some(Boolean)) range.setValues([headers]);
    sheet.setFrozenRows(1);
    range.setBackground('#17264b').setFontColor('#ffffff').setFontWeight('bold')
      .setVerticalAlignment('middle');
    sheet.setRowHeight(1, 34);
    sheet.getRange(1, 1, sheet.getMaxRows(), headers.length)
      .setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP);
    sheet.setColumnWidths(1, headers.length, 170);
    outcome.push(tabName + (created ? ' (created)' : ' (checked)'));
  });

  const jobs = ss.getSheetByName('Stellen');
  jobs.setColumnWidth(2, 300);
  jobs.setColumnWidths(3, 3, 340);
  jobs.setColumnWidth(8, 300);
  jobs.setColumnWidth(9, 420);
  const ratingRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(['Top', 'Mittel', 'Too stretchy', 'langweilig', 'Falscher Ort'], true)
    .setAllowInvalid(false).build();
  jobs.getRange(2, 6, jobs.getMaxRows() - 1, 1).setDataValidation(ratingRule);
  const statusRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(['Nein', 'In Vorbereitung', 'Später', 'Ja', 'Eingeladen', 'Abgelehnt', 'Archiviert'], true)
    .setAllowInvalid(false).build();
  jobs.getRange(2, 7, jobs.getMaxRows() - 1, 1).setDataValidation(statusRule);

  const companies = ss.getSheetByName('Firmenquellen');
  const typeRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(['Auto', 'Ashby', 'Lever', 'Lever EU', 'Greenhouse', 'Workable', 'Recruitee', 'HTML'], true)
    .setAllowInvalid(false).build();
  companies.getRange(2, 3, companies.getMaxRows() - 1, 1).setDataValidation(typeRule);
  companies.getRange(2, 5, companies.getMaxRows() - 1, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(['Ja', 'Nein'], true)
      .setAllowInvalid(false).build());
  companies.setColumnWidth(2, 440);
  Logger.log('RoleHorizon setup: ' + outcome.join(', '));
  return outcome;
}

/** Optional, never called automatically; inserts fictional sample data. */
function addRoleHorizonDemoData() {
  const id = String(PropertiesService.getScriptProperties()
    .getProperty('ROLEHORIZON_SHEET_ID') || '').trim();
  if (!id) throw new Error('Set ROLEHORIZON_SHEET_ID first.');
  const ss = SpreadsheetApp.openById(id);
  const sheet = ss.getSheetByName('Stellen');
  if (!sheet) throw new Error('Run setupRoleHorizonWorkbook first.');
  const url = 'https://example.com/careers/example-role';
  const last = sheet.getLastRow();
  if (last > 1 && sheet.getRange(2, 9, last - 1, 1).getDisplayValues()
    .some(row => row[0] === url)) return 'Demo row already exists';
  sheet.appendRow([
    'Example Systems', 'Solutions Engineer', 'Fictional B2B software company',
    'Build customer-facing integrations.', 'JavaScript and technical communication',
    'Top', 'Nein', 'Synthetic demo row — safe to delete', url, '', '', '', ''
  ]);
  return 'Inserted one fictional demo row';
}

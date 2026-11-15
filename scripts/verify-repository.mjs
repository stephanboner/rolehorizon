import fs from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import path from 'node:path';

const root = path.resolve('.');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const required = [
  'README.md', 'docs/SETUP.md', 'SECURITY.md', 'docs/index.html',
  'apps-script/Code.gs', 'apps-script/Index.html',
  'apps-script/Setup.gs', 'apps-script/appsscript.json',
  'templates/Stellen.csv', 'templates/Firmenquellen.csv', 'templates/Scanprotokoll.csv',
  'automation/job-discovery.json', 'automation/company-source-research.json',
  'automation/application-preparation-optional.json',
  'worker/app.py', 'worker/job_source.py', 'worker/Dockerfile', 'worker/requirements.txt',
];
for (const filename of required) assert.ok(fs.existsSync(path.join(root, filename)), 'Missing ' + filename);

const sheetHeaders = {
  Stellen: ['Firma', 'Jobtitel', 'Über die Firma', 'Jobbeschreibung', 'Anforderungen', 'Einschätzung', 'Beworben', 'Bemerkungen', 'Link', 'Bewerbung vorbereiten', 'Workflowstatus', 'Unterlagen erstellt am', 'iCloud-Ablage'],
  Firmenquellen: ['Firma', 'Karriereseite', 'Typ', 'Kennung (falls nötig)', 'Aktiv'],
  Scanprotokoll: ['Zeitpunkt', 'Firma', 'Karriereseite', 'Typ', 'Gefundene Jobs', 'Status', 'Hinweis'],
};
for(const [name, headers] of Object.entries(sheetHeaders)){
 const text=read('templates/'+name+'.csv').trimEnd();
 assert.deepEqual(text.split(','), headers, name + ' header mismatch');
}
const backend=read('apps-script/Code.gs');
const setup=read('apps-script/Setup.gs');
new vm.Script(backend, {filename:'Code.gs'});
new vm.Script(setup, {filename:'Setup.gs'});
const html = read('apps-script/Index.html');
const inlineScripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)];
assert.ok(inlineScripts.length>=1, 'No inline app script found');
for (const match of inlineScripts) new vm.Script(match[1], {filename:'Index.html <script>'});
assert.ok(backend.includes('ROLEHORIZON_SHEET_ID'), 'Sheet property not used');
assert.ok(backend.includes('LockService.getScriptLock'), 'Mutations are not locked');
assert.ok(html.includes('rolehorizonInputLink') && html.includes('rolehorizonSheetLink'));
assert.ok(setup.includes('function setupRoleHorizonWorkbook'));

const expectations=[
 ['automation/job-discovery.json',16],
 ['automation/company-source-research.json',5],
 ['automation/application-preparation-optional.json',13]
];
for (const [filename,count] of expectations) {
  const wf=JSON.parse(read(filename));
  assert.equal(wf.active, false, filename + ' must not be enabled on import');
  assert.equal(wf.nodes.length,count);
  const names=new Set(wf.nodes.map(n=>n.name));
  assert.equal(names.size,count, filename + ': duplicate node names');
  for(const node of wf.nodes){
    assert.equal(typeof node.type,'string');
    assert.equal(typeof node.id,'string');
    assert.equal(node.credentials,undefined,filename+': credential ID included');
  }
  for(const [from,connections] of Object.entries(wf.connections||{})){
    assert.ok(names.has(from), filename+' missing source '+from);
    for(const outputs of Object.values(connections||{})){
      for(const branch of outputs||[]){
        for(const link of branch||[]) assert.ok(names.has(link.node), filename+' missing target '+link.node);
      }
    }
  }
}
const manifest=JSON.parse(read('apps-script/appsscript.json'));
assert.equal(manifest.webapp.access,'MYSELF');
assert.equal(manifest.runtimeVersion,'V8');

const scanFiles = required.filter(x=>!['README.md','docs/SETUP.md','SECURITY.md'].includes(x));
for(const filename of scanFiles){
 const src=read(filename);
 for(const forbidden of [/n8n\.stephanboner\.ch/i,/13tCLQ-KYQVYFxrnH/i,/1rMrPPzRZ/i,/sk-proj-[A-Za-z0-9]/i,/ghp_[A-Za-z0-9]{15}/i]){
  assert.ok(!forbidden.test(src), filename+' contains a potentially private source identifier');
 }
}
console.log('RoleHorizon repository consistency checks passed.');

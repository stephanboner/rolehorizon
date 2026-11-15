# Install and deploy RoleHorizon

This is a reproducible **single-user starter**, not a public SaaS service. Everything below starts with fresh, separate accounts/resources. **Never connect this showcase to the author's personal production installation.**

## Prerequisites

- A Google account with permission to create a Google Sheet and Google Apps Script project.
- A self-hosted n8n instance with Google Sheets OAuth and an OpenAI API credential. n8n must be able to fetch public career pages over HTTPS.
- An OpenAI API account with billing enabled for AI extraction/research (requests incur charges).
- Optional: Docker, Python worker credentials, a private rclone remote and documents on that remote if application-draft generation is wanted.

## 1. Create a new Google Sheet

1. Create a **blank** Google Sheet, preferably called *RoleHorizon — Job Tracker*. Copy the document ID between `/d/` and `/edit` in its URL. Do **not** use a sheet from someone else's installation.
2. Create a new **standalone** Google Apps Script project at [script.google.com](https://script.google.com/) named RoleHorizon.
3. In the Apps Script editor, copy `apps-script/Code.gs` into a script file named `Code` and add `apps-script/Setup.gs` as another script file named `Setup`. Add an HTML file named **`Index`** containing `apps-script/Index.html`.
4. In Project Settings, enable **Show 'appsscript.json' manifest file** and replace its content with `apps-script/appsscript.json`.
5. Under Project Settings → **Script Properties**, add `ROLEHORIZON_SHEET_ID` with the new Google Sheet ID.
6. From the Apps Script function selector run **`setupRoleHorizonWorkbook`** once and authorize the requested Google Sheets permissions. The function creates/validates `Stellen`, `Firmenquellen`, `Scanprotokoll`; it does **not** wipe existing data. The default empty `Sheet1` can be deleted manually.
7. Optional: run `addRoleHorizonDemoData` to insert one **fictional** role. This is never executed automatically.

The exact header rows are also available as individual CSV templates in [`templates/`](../templates/). **Keep the original column order and spelling.** In particular, the public version uses `Einschätzung`, *not* the original private sheet's personalized column name.

### Tables

| Sheet tab | Columns / purpose |
| --- | --- |
| `Stellen` | A–E imported information, F `Einschätzung`, G `Beworben`, H `Bemerkungen`, I unique `Link`, J optional preparation trigger, K `Workflowstatus`, L `Unterlagen erstellt am`, M `iCloud-Ablage` |
| `Firmenquellen` | `Firma`, `Karriereseite`, `Typ`, `Kennung (falls nötig)`, `Aktiv` |
| `Scanprotokoll` | `Zeitpunkt`, `Firma`, `Karriereseite`, `Typ`, `Gefundene Jobs`, `Status`, `Hinweis` |

A company source should begin with `Aktiv=Nein`; manually confirm its official company board and supported type before enabling.

## 2. Import n8n workflows safely

1. In n8n choose **New workflow → Import from file** and select [`automation/job-discovery.json`](../automation/job-discovery.json).
2. Import [`automation/company-source-research.json`](../automation/company-source-research.json) as a *second* workflow.
3. Both imports should remain **inactive**. The source JSON deliberately removes credential IDs and account-specific configuration.
4. In **every Google Sheets node**, choose your own Google Sheets OAuth2 credential and **select your newly created spreadsheet**. Find/replace `REPLACE_WITH_GOOGLE_SHEET_ID` where present. Verify the selected tabs: `Stellen`, `Firmenquellen`, `Scanprotokoll`. For `appendOrUpdate`, match by `Link`.
5. In the **OpenAI** node(s), select your own OpenAI credential. Inspect the request model, output parsing expectations and cost before running. Some node types may need updating for your n8n version.
6. In `Company source research`, configure a **header authentication** credential for its Webhook (for instance header `X-Webhook-Key` with a unique random secret). Keep the webhook disabled until the app is configured. The response is a **suggestion**, not an automatic database write.
7. The default daily schedule in the discovery workflow is **07:15**; set the workflow timezone appropriately in n8n (e.g. `Europe/Zurich`). Disable or adjust the schedule until manual import and tests pass.
8. Inspect the workflow's access to third-party websites. An ATS listing may be incomplete or blocked; do not treat missing text as a reliable description.

**Note:** the repository ships actual adapted n8n workflow definitions, not just diagrams. They contain code and field mappings, but are not connected to accounts on import. n8n versions and imported node settings may differ: no claim of one-click deployment.

## 3. Configure Apps Script

Set these **Script Properties** in your new Apps Script project:

| Key | Value | Required |
| --- | --- | --- |
| `ROLEHORIZON_SHEET_ID` | The ID of **your** new Google Sheet | Yes |
| `ROLEHORIZON_FORM_URL` | The n8n manual-intake form URL from your new discovery workflow | Only for the “Add role” link |
| `ROLEHORIZON_N8N_WEBHOOK_URL` | The **production** webhook URL of your separately configured optional application preparation workflow | Optional |
| `ROLEHORIZON_N8N_WEBHOOK_KEY` | The shared, strong webhook header secret used in the relevant n8n webhook credentials | Required if using optional research/preparation webhook actions |
| `ROLEHORIZON_COMPANY_SOURCE_WEBHOOK_URL` | The **production** webhook URL generated by your new company-source-research workflow | If using AI company-source research |

The app exposes only the sheet URL and form URL to its own authenticated browser. The **header secret remains server-side** in Apps Script Properties. If company research and document preparation use different secrets, align the corresponding authentication settings before activation; this adapter currently assumes the same value for both.

### Deploy the app

1. In Apps Script click **Deploy → New deployment → Web app**.
2. Set **Execute as: Me** and **Who has access: Only myself**. Do not expose this private job-search database to all users.
3. Deploy, authorize if needed, and open the resulting URL while signed in as the deployer.
4. Confirm a blank list or your fictional example appears. Change the rating/notes, refresh, and verify that only columns F–H of the corresponding `Stellen` row changed.
5. Check the Add-role link (it appears only after setting `ROLEHORIZON_FORM_URL`) and the open-Sheet link.
6. Changes to code require **Deploy → Manage deployments → Edit → New version → Deploy**; merely saving in the editor does not update the existing deployment.

**Automation deployment:** The GitHub showcase deliberately does **not** include a GitHub Action that pushes to a live Apps Script project. This prevents accidental updates to private deployments. Owners who want CI/CD can use `clasp` with a new Script ID and separate credentials; never commit `.clasp.json` or `.clasprc.json` if they contain sensitive identifiers or OAuth tokens.

## 4. Test ingestion end to end

1. Keep the schedule inactive. In the n8n form trigger, manually input one role URL from a website whose terms allow this use, using your own n8n access.
2. Confirm **URL normalization** and **duplicate filtering** behave as intended, especially URLs with and without tracking parameters.
3. Inspect the **OpenAI extraction output** for expected keys `ok`, `firma`, `jobtitel`, `ueber_die_firma`, `jobbeschreibung`, `anforderungen`, `hinweis`. The workflow validates completeness and may mark failures for review.
4. Verify exactly one row is appended/updated in `Stellen` and that `Bemerkungen` signals any extraction error. Confirm a manually assigned `Einschätzung` and `Beworben` are not overwritten on a repeat.
5. Only after that, add a source to `Firmenquellen`, initially `Aktiv=Nein`, then enable it and run one controlled scan. Check `Scanprotokoll`.
6. When the scans are satisfactory, activate the workflow and enable its scheduled trigger.

**No automatic applications:** Tracking `Beworben=Ja` is a manual user decision; generating a draft must not set it.

## 5. Optional document preparation and private worker

This component is **not required** to run RoleHorizon discovery and review. Only enable it if you understand the additional privacy, storage and AI costs.

1. Import [`automation/application-preparation-optional.json`](../automation/application-preparation-optional.json) as inactive.
2. Build the private FastAPI worker in [`worker/`](../worker/). See [`WORKER.md`](WORKER.md) for Docker, rclone and profile-file setup.
3. Configure worker HTTP request nodes to use the private worker address (default example `http://rolehorizon-worker:8080` inside a trusted Docker network), with a header credential `X-Worker-Token`. **Do not publish the worker port to the public internet.**
4. Select your Google Sheets credential and Sheet again, configure OpenAI, and use a unique header credential on the n8n Webhook. Set `ROLEHORIZON_N8N_WEBHOOK_URL` and `ROLEHORIZON_N8N_WEBHOOK_KEY` in Apps Script.
5. Test with **fictional CV and sample job data only** before using any actual personal records. Verify the workflow distinguishes *accepted*, *generated* and *submitted* states.

The worker is tailored to a private rclone-compatible remote, originally used for iCloud documents. Other storage backends require changes; the system does not automate submitting applications.

## 6. Publish the separate public demo with GitHub Pages

The demo is at [`docs/index.html`](index.html), runs on fictional data and **does not call any private API**.

In GitHub: **Settings → Pages → Build and deployment → Deploy from a branch → main → /docs → Save**.

The public URL will normally be `https://stephanboner.github.io/rolehorizon/` after Pages deployment. Do **not** replace it with the authenticated Apps Script production URL.

## Common issues

| Symptom | Check |
| --- | --- |
| Web app: missing Sheet or wrong columns | `ROLEHORIZON_SHEET_ID`, correct header spelling, run setup initializer |
| n8n Google Sheet errors | Re-select Google OAuth credential, document ID and correct sheet tab; validate `Link` match column |
| Manual intake link not working | `ROLEHORIZON_FORM_URL` is missing or the imported n8n form has not been published |
| Company research fails | Configure n8n header auth credential and both Apps Script webhook properties |
| 403 / empty job posting | Website blocks automated access; review manually, do not claim a valid extraction |
| AI JSON parse fails | Verify model credential, structured output settings, and expected keys |
| Revisions conflict after sorting | Reload the app; do not bypass the URL/revision safety checks |
| Application-preparation accepted but no file appears | Inspect worker/n8n execution; acceptance is not completion |
| Production app unexpectedly public | Redeploy web app with **Only myself**, review sharing permissions |

## What is deliberately not included

Real Google Sheets contents, private CVs, real job application status, production OAuth credentials, actual webhooks, and private deployment identifiers. A full unattended end-to-end deploy would be unsafe without first supplying your own service accounts, permissions, and storage resources.

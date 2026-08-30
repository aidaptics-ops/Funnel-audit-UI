# Connecting Google Sheets

Six steps, about ten minutes. You need a Google account; you do **not** need
Google Workspace, billing, or a paid Cloud plan — the Sheets API is free at
this volume.

The app authenticates as a **service account**: a robot Google account with its
own email address. You share your spreadsheet with that address exactly as you
would with a colleague. Nothing here uses your personal Google login, so no
OAuth consent screen and no token refresh dance.

---

## 1. Create a Google Cloud project

Go to <https://console.cloud.google.com/projectcreate>.

Name it anything (`funnel-audit` is fine) and click **Create**. Wait for the
notification, then make sure the project is selected in the top bar.

## 2. Enable the Sheets API

Go to <https://console.cloud.google.com/apis/library/sheets.googleapis.com>,
confirm your project is selected, and click **Enable**.

> If you skip this, every write fails with *"Google Sheets API has not been used
> in project ... before or it is disabled"*. That message names the project, so
> it is easy to spot.

## 3. Create the service account

Go to <https://console.cloud.google.com/iam-admin/serviceaccounts> →
**Create service account**.

- **Name:** `funnel-audit-writer`
- **Grant this service account access to project:** skip it. Click **Continue**,
  then **Done**.

Project-level IAM roles are irrelevant here — access to a spreadsheet comes
from sharing the file, not from a role. Granting Editor on the project would
give this key far more access than it needs.

You now have a row with an email like:

```
funnel-audit-writer@funnel-audit-123456.iam.gserviceaccount.com
```

**Copy that address.** You need it in step 5.

## 4. Download a JSON key

Click the service account → **Keys** tab → **Add key** → **Create new key** →
**JSON** → **Create**.

A `.json` file downloads. It contains a private key: treat it like a password.
Do not commit it, and do not paste it into a chat window (including this one).

## 5. Create the spreadsheet and share it

Create a new sheet at <https://sheets.new>.

1. Rename the tab at the bottom to **`Funnels`** (or anything, as long as it
   matches `GOOGLE_SHEETS_WORKSHEET`).
2. Click **Share**, paste the service account email from step 3, set it to
   **Editor**, and untick "Notify people". Click **Share**.
3. Copy the spreadsheet id out of the URL:

```
https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz1234567890/edit
                                       └────────── this is the id ──────────┘
```

Leave the sheet completely empty. The app writes its own header row the first
time it saves. If the sheet already has a header, the app reads it and matches
your column names instead — it never rearranges columns you created.

> **The single most common failure** is forgetting step 5.2. A 403 from Sheets
> almost always means the file was never shared with the robot account. The app
> says so explicitly in that case.

## 6. Fill in the environment

The JSON key contains a PEM private key full of newlines, which `.env` files
handle badly. Base64-encode it first — one long line, no quotes, no newlines:

**PowerShell**

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("$HOME\Downloads\funnel-audit-123456-abc.json"))
```

**Bash / macOS / Linux**

```bash
base64 -w0 ~/Downloads/funnel-audit-123456-abc.json
```

Paste the output into `dashboard/.env.local`:

```dotenv
GOOGLE_SERVICE_ACCOUNT=ewogICJ0eXBlIjogInNlcnZpY2VfYWNjb3VudCIsCiAg...
GOOGLE_SHEETS_ID=1AbCdEfGhIjKlMnOpQrStUvWxYz1234567890
GOOGLE_SHEETS_WORKSHEET=Funnels
```

Restart the dev server. `GET /api/status` should now report:

```json
{ "sheets": { "configured": true } }
```

Analyse a funnel, approve the email, and click **Save**. The header row plus
your first record appear in the sheet.

---

## How writing behaves

- **Keyed on `funnel_url`.** Saving the same URL twice updates that row instead
  of appending a duplicate.
- **Header-driven.** Columns are matched by name, never by position, so you can
  reorder them, insert your own, or rename the tab. A column the app does not
  recognise is left untouched; a column the app holds but your sheet lacks is
  simply not written.
- **Sequential.** The queue analyses one funnel at a time, so there are no
  concurrent writes to reconcile.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `403 ... does not have permission` | Step 5.2 — the sheet was never shared with the service account email. |
| `Sheets API has not been used in project` | Step 2 — the API is not enabled. |
| `Invalid JWT Signature` | The key was truncated or re-encoded. Re-download and re-encode it. |
| `Unable to parse range: Funnels!A:ZZ` | `GOOGLE_SHEETS_WORKSHEET` does not match the tab name (it is case-sensitive). |
| `Requested entity was not found` | `GOOGLE_SHEETS_ID` is wrong — check you copied the id, not the whole URL. |

## If the key ever leaks

Delete it in the Cloud console (service account → **Keys** → bin icon) and
create a new one. Revoking a key is instant, and the spreadsheet's sharing
settings are unaffected.

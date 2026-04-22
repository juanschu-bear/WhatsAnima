# CFO Setup — Jordan Cash Receipt Pipeline

When a user sends an image to the **Jordan Cash** avatar, `/api/chat` runs a
background pipeline that:

1. Extracts structured data from the receipt with GPT-4 Vision
2. Uploads the original image to Google Drive under `CFO_Receipts/{YYYY}/{MM}/`
3. Appends a row to a Google Sheet
4. Writes a row into the `cfo_transactions` Supabase table
5. Posts a follow-up message from Jordan into the conversation

This doc explains the environment variables that power steps 2–4 and how to
provision the Google Service Account that Drive and Sheets use.

## Required environment variables

Set all of these in Vercel (or your local `.env.local`):

| Variable | Purpose |
|---|---|
| `OPENAI_API_KEY` | Used by the receipt extraction step. Required. |
| `OPENAI_CHAT_MODEL` | Optional. Defaults to `gpt-4o-mini`. Any chat-completions model with vision support works. |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Full JSON key for a Google service account, as a single string. Newlines in `private_key` may be encoded as `\n` — the code normalizes them. |
| `GOOGLE_DRIVE_CFO_FOLDER_ID` | ID of the root folder inside Google Drive where receipts land. The pipeline creates `YYYY/MM/` subfolders under it automatically. |
| `GOOGLE_SHEETS_CFO_ID` | ID of the Google Sheet that tracks transactions. |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | Standard Supabase admin credentials — already required by the rest of the app. |

If any of the Google-specific vars is missing, the chat flow still works and
the Supabase row is still written; the missing step is simply skipped and the
follow-up message tells the user what got saved.

## Google Service Account

1. Go to [Google Cloud Console](https://console.cloud.google.com/) and either
   pick an existing project or create a new one (e.g. `whatsanima-cfo`).
2. Enable these APIs on the project:
   - **Google Drive API**
   - **Google Sheets API**
3. In **IAM & Admin → Service Accounts**, click **Create service account**.
   Name it something like `cfo-receipts`. No roles are needed at the project
   level — access is granted per-resource below.
4. Open the service account, go to **Keys → Add key → Create new key → JSON**.
   Download the file. The service account's email looks like
   `cfo-receipts@<project-id>.iam.gserviceaccount.com`.
5. Paste the **entire JSON** (single-line or multi-line both work) into the
   `GOOGLE_SERVICE_ACCOUNT_JSON` environment variable.

## Google Drive folder

1. In Drive, create a folder (e.g. `CFO Receipts`).
2. Share it with the service account's email. Role: **Editor**.
3. Grab the folder ID from the URL
   (`https://drive.google.com/drive/folders/<THIS_IS_THE_ID>`) and set it as
   `GOOGLE_DRIVE_CFO_FOLDER_ID`.

The pipeline creates `CFO_Receipts/{YYYY}/{MM}/` subfolders inside this root on
first use per month. Each receipt is stored as
`{YYYY-MM-DD}_{merchant}_{total}{currency}.{ext}`.

## Google Sheet

1. Create a new Google Sheet (e.g. `CFO Transactions`).
2. Share it with the service account's email. Role: **Editor**.
3. Rename the first tab to exactly `Transactions` (case-sensitive).
4. Put this header row in `A1:K1`:

   | Datum | Händler | Betrag | MwSt | Kategorie | Geschäftsausgabe | Steuerrelevant | Zahlungsmethode | Tags | Drive Link | WhatsAnima Link |

5. Grab the Sheet ID from the URL
   (`https://docs.google.com/spreadsheets/d/<THIS_IS_THE_ID>/edit`) and set it
   as `GOOGLE_SHEETS_CFO_ID`.

The pipeline appends new rows below the last populated row via the Sheets API.
The header row is not re-written — set it up once when you create the sheet.

## Database

The `cfo_transactions` table is created and extended by two migrations:

- `migrations/022_cfo_transactions.sql` — base schema
- `migrations/023_cfo_transactions_google_integrations.sql` — adds `drive_url`
  and `sheets_row_index`

Apply both to Supabase before deploying the code that writes to the table.

## Failure handling

Each step logs to the function output with a `[CFO]` prefix:

- `[CFO] Drive upload failed: …` — Drive failed; Supabase row and Sheets row still get written; `drive_url` stays null.
- `[CFO] Sheets append failed: …` — same idea; `sheets_row_index` stays null.
- `[CFO] Failed to save transaction: …` — Supabase insert failed (the pipeline's canonical store); treat as an incident.
- `[CFO] Failed to post follow-up message: …` — user won't get the confirmation in chat; the transaction itself is unaffected.

The follow-up message Jordan posts adapts its wording to what actually
succeeded — it won't claim "Gespeichert in Drive und Sheets" if only one of the
two worked.

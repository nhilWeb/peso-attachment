# PESO San Miguel Travel Attachment System deployment

This version stores transaction field values in Google Sheets. It does not upload generated PDF or Excel files to Google Drive. Printing, PDF saving, and Excel export remain browser-only operations.

## Architecture

1. GitHub Pages serves the HTML, CSS, JavaScript, images, and icons.
2. Cloudflare Access authenticates PESO personnel.
3. A Cloudflare Worker validates the Access JWT, restricts origins, applies an optional rate limit, and forwards requests.
4. Google Apps Script validates the Worker secret and reads or writes Google Sheets.

The browser contains only the public Worker URL. The Apps Script URL and gateway secret must never be committed to GitHub.

## 1. Create the spreadsheet and Apps Script service

1. Create a blank Google Spreadsheet owned by the official account that will maintain the database.
2. Copy the spreadsheet ID from the URL between `/d/` and `/edit`.
3. Create a standalone Apps Script project or open **Extensions > Apps Script** from the spreadsheet.
4. Replace the editor contents with [`apps-script/Code.gs`](apps-script/Code.gs).
5. Open **Project Settings > Script Properties** and add:
   - `SPREADSHEET_ID`: the spreadsheet ID
   - `GATEWAY_SECRET`: a long random value of at least 32 bytes
6. Select `setup` in the Apps Script editor and run it once. Approve Spreadsheet access. It creates the `Transactions` and `Settings` worksheets.
7. Select **Deploy > New deployment > Web app**:
   - Execute as: the deploying/official account
   - Who has access: Anyone
8. Copy the deployed `/exec` URL. Direct requests are still rejected unless they contain the Worker-only gateway secret.

Apps Script needs Spreadsheet permission only. No Google Drive storage or Drive permission is used.

## 2. Deploy the Cloudflare Worker

1. Install Node.js if needed and authenticate Wrangler with `npx wrangler login`.
2. Edit [`cloudflare-worker/wrangler.toml`](cloudflare-worker/wrangler.toml):
   - `ALLOWED_ORIGIN`: the exact public frontend origin, without a trailing slash
   - `ACCESS_TEAM_DOMAIN`: for example `your-team.cloudflareaccess.com`
   - `ACCESS_AUD`: the Application Audience tag from the Cloudflare Access application
3. From `cloudflare-worker`, set the two encrypted secrets:

   ```powershell
   npx wrangler secret put APPS_SCRIPT_URL
   npx wrangler secret put GATEWAY_SECRET
   ```

   Enter the Apps Script `/exec` URL and the exact same random gateway secret used in Script Properties.
4. Deploy:

   ```powershell
   npx wrangler deploy
   ```

5. Recommended production routing: attach the Worker only to `attachments.example.gov.ph/api/*`. The rest of that hostname continues to serve GitHub Pages.
6. In Cloudflare Zero Trust, create an Access self-hosted application for the attachment-system hostname and allow only approved PESO email addresses or the official Workspace group.

The Worker validates the Access JWT itself. A forged email header is not accepted.

### Optional rate limiting

Create a Cloudflare Workers rate-limiter namespace, then uncomment the `[[ratelimits]]` block in `wrangler.toml`. The code automatically uses the binding when it exists and limits by authenticated user rather than shared office IP address.

## 3. Publish the frontend

1. Push the repository to GitHub.
2. In the GitHub repository, open **Settings > Pages** and publish from the branch containing these files.
3. Configure the custom domain and enforce HTTPS.
4. If the Worker is routed at the same hostname under `/api/*`, keep this value in [`config.js`](config.js):

   ```js
   apiBaseUrl: '/api'
   ```

   If using a separate Worker hostname, set the full API URL ending in `/api` and add the frontend origin to `ALLOWED_ORIGIN`.

No secret belongs in `config.js`, the HTML, or any browser JavaScript.

## 4. Test before entering production data

1. Visit the published site and complete the Cloudflare Access login.
2. Confirm the blue connection message changes to “Google Sheets database connected.”
3. Create a test transaction and verify that exactly one row appears in `Transactions`.
4. Reload the site and open the saved transaction. Confirm the form and itinerary are reconstructed from the sheet.
5. Edit it and confirm the same row is updated rather than duplicated.
6. Change a template completion mark and confirm `templateCompletionJson` and `status` change.
7. Delete the transaction and confirm `deletedAt` is populated. Deleted records remain hidden in the application for audit/recovery.
8. Export Excel or print to PDF and confirm that no file is created in Google Drive.

## Spreadsheet columns

The `Transactions` worksheet stores regular input fields in individual columns. The itinerary and five template completion marks are JSON text because they contain repeated/nested values. Server-controlled columns include the unique ID, calculated total, status, timestamps, authenticated user emails, and soft-delete timestamp.

Do not rename or reorder the generated worksheet headers. Use a separate worksheet or spreadsheet for reports and formulas.

## Updating Apps Script

After editing `Code.gs`, create a new deployment version or edit the existing deployment to use a new version. Confirm the Worker still holds the current `/exec` URL. Never use the `/dev` testing URL in production.

# AfterLogout

A small CLI for comparing browser evidence across logout and account switching.

Give it a distinctive string from account A's private test data. It records where
that string appears after logout and after signing in as account B: browser
storage, captured responses, or rendered page text.

## Setup

Node.js 22 or newer is required.

```sh
npm install
npx playwright install chromium
npm run build
```

## Run

```sh
node dist/cli.js https://your-test-app.example \
  --marker 'private-invoice-a-4821'
```

Use a unique marker from a record only account A should see. Avoid shared names,
public data, or common words. A marker present in both accounts is not useful.

The tool opens a fresh Chromium session. Use the original tab for each step:

1. Sign in as A and open the private record. Press Enter in the terminal.
2. Log out through the application. Press Enter.
3. Sign in as B and open the view being tested. Press Enter.

Login is manual, including MFA. Both accounts use the same browser context so
storage can survive the switch. This tests a shared-browser scenario; it does not
demonstrate access from another device.

Output goes in a new `evidence/<timestamp>/` directory. Use `--out <directory>` to
choose another location. Existing directories are refused. Each completed stage
is saved immediately, including an updated report.

## Output

| File | Contents |
| --- | --- |
| `account-a.json`, `logged-out.json`, `account-b.json` | Raw storage entries, page text, timestamps, and capture warnings |
| Stage `.png` files | Raw viewport screenshots |
| `network.json` | Same-origin response URLs, status, source, and available text bodies |
| `report.html`, `report.json` | Marker observations without raw values or response bodies |
| `manifest.json` | SHA-256 hashes of the other saved files |

Raw evidence can include session cookies, tokens, personal information, and
private documents. Keep it local. Reports omit raw values and remove URL queries
and fragments, but storage names and URL paths can still contain private data.
Review reports before submitting them. Screenshots are not embedded in the report.

On systems that support Unix permissions, the run directory is created with mode
700 and evidence files with mode 600. Evidence is not encrypted. A hash manifest
can detect changes against a trusted copy; it is not a signed chain of custody.

## Reading the results

- `stored-marker`: the marker exists in browser storage. This alone does not
  establish unauthorized access.
- `visible-marker`: the marker appears in page text at a later stage. Confirm the
  account identity and check the screenshot for actual impact.
- `response-marker`: a later response body contains the marker. Inspect the raw
  response and the workflow before treating it as a finding.

The account labels are yours; the tool cannot verify which account is logged in.
It does not automatically assign severity or declare a vulnerability. If the
marker was never recorded under A, the report says the baseline is missing.

Network bodies and cache entries containing the marker provide leads for manual
correlation. The tool does not claim to prove which response created a storage
entry. Captures are sequential, not an atomic view of the browser.
Network stages follow when a request started, so a slow response from A is not
mistaken for a request made after logout.

## Try the demo

In one terminal:

```sh
npm run demo
```

In another:

```sh
node dist/cli.js http://127.0.0.1:4173 \
  --marker 'a-private-invoice-4821'
```

Click **Log in as A**, then **Open invoice**, and capture A. Log out and capture.
Log in as B, open the invoice again, and capture B. The buggy demo keeps a cache
entry shared by both accounts, so B sees A's invoice.

Repeat with `http://127.0.0.1:4173/?safe=1` for the fixed demo. It clears storage on
logout, and B receives B's invoice. The demo only listens on loopback and uses fake
accounts and invoices.

## Development

```sh
npm test
npm run build
```

Tests run real Chromium against the buggy and fixed demo, verify storage capture
and account switching, and check report escaping and evidence hashes. The CLI
test opens a browser window and drives all three prompts. On a Linux system
without a display, run `xvfb-run --auto-servernum npm test`.

The source is five files: CLI, capture, comparison, report, and shared types.
Playwright is the only runtime dependency. Evidence uses JSON files rather than a
database so a run can be inspected without another tool.

## Current limits

- Chromium only, original tab only, exact target origin only. Other tabs, iframe
  origins, and identity-provider traffic are not recorded. This is a capture
  filter, not a network firewall; the browser can still load external resources.
- Cookies are selected by target domain, including parent-domain cookies.
- IndexedDB values use JSON serialization. Binary data and special object types
  are not faithfully represented. This does not parse disk databases, recover
  deleted records, or inspect browser memory.
- Cache Storage means the web Cache API, not Chromium's entire HTTP disk cache.
  HTTP responses expose browser cache/service-worker source flags when available.
- Storage is limited to 1,000 non-cookie entries per snapshot. Values and cache
  bodies have a 1 MiB limit; oversized entries are omitted with warnings.
- Up to 500 network responses per run. Only supported text bodies up to 1 MiB
  are saved. Unavailable or skipped bodies are recorded explicitly. Requests,
  request headers, WebSockets, and streaming bodies are not captured.
- Page text is limited to 1 MiB. Screenshots cover the viewport. Canvas content,
  CSS-hidden text, and cross-origin frame content are not included in text checks.
- No request replay, token-validity checks, automatic login, or automatic
  vulnerability classification.

Use test accounts and targets covered by your testing permission.

## License

MIT.

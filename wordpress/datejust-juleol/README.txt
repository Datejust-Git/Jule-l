Datejust Juleølsmaking 1.1.1

Install the ZIP containing this directory as a WordPress plugin, then activate it.
The app is served at /juleolsmaking/ with no menu, theme or homepage changes.
The path is an isolated app page; it is not a WordPress post, so no page list or
standard sitemap entry is created. The response also sets noindex/nofollow.

The original Norwegian UI is built from public/ with scripts/build-wordpress.mjs.
WordPress stores sessions in its own datejust_juleol database table (InnoDB).
Row locks protect simultaneous scoring. Tokens are stored as SHA-256 hashes.
Phones and TV poll for updates every 2.5 seconds (6 seconds in background tabs).
QR codes are generated locally in the browser; no external QR service is used.
The host can add, replace or remove an optional photo for each beer. The browser
offers "Ta bilde" with a rear-camera capture hint on mobile, and a separate
"Velg bilde" option for an existing photo. Camera support follows the browser;
desktop browsers can fall back to their normal file chooser. The browser
reduces the image to 400 pixels and exports JPEG before uploading. The endpoint
requires the host token, validates size, type and dimensions, and stores the
JPEG with a random name in WordPress uploads. Only the image URL is in live state.
Removing or replacing a photo preserves its uploaded file; no media is deleted.

Host access stays in the browser that created the tasting. Joining needs the
six-character code. Participants can see names and results, so use first names
or nicknames. The page is accessible to people who know its address.

Deactivation disables this app only and preserves tasting data. Uninstall does
not automatically delete the table. Existing content and navigation are untouched.

QR generator: Kazuhiko Arase, https://github.com/kazuhikoarase/qrcode-generator
Distributed under the MIT license; see assets/LICENSE-qrcode.txt.

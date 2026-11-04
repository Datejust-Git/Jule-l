Datejust Juleølsmaking 1.3.0

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

The evening overview shows each participant's average given score and number of
beers rated. The group average weights every submitted rating equally. Missing
ratings are excluded; editing a vote replaces its earlier contribution.

Build shared UI assets with npm run build:wordpress. Validate the PHP domain,
REST uploads and averages with test/wordpress-domain.test.php,
test/wordpress-upload.test.php and test/wordpress-averages.test.php.

Host access is remembered separately on each authorized device. An existing host
can generate a private organizer code, then another device selects "Fortsett som
arrangør" and enters the tasting code plus the organizer code. Each device gets
its own random access token; the original host remains authorized. New organizer
codes replace old codes for future sign-ins without logging existing hosts out.
The organizer code is shown only when generated, stays in page memory, and never
enters participant links or QR codes. Existing tastings can enable this without
losing votes or photos. Test this with test/wordpress-host-access.test.php.

Joining as a participant needs the six-character tasting code. Participants can
see names and results, so use first names or nicknames. The page is accessible
to people who know its address. The tasting code alone does not grant host access.

Deactivation disables this app only and preserves tasting data. Uninstall does
not automatically delete the table. Existing content and navigation are untouched.

QR generator: Kazuhiko Arase, https://github.com/kazuhikoarase/qrcode-generator
Distributed under the MIT license; see assets/LICENSE-qrcode.txt.

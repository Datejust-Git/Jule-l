<?php
/**
 * Plugin Name: Datejust Juleølsmaking
 * Description: Egen juleølapp med mobilpoeng, QR-kode og TV-visning på /juleolsmaking/. Ingen meny- eller temaendringer.
 * Version: 1.1.0
 * Requires at least: 6.0
 * Requires PHP: 7.4
 * Author: Kennel Datejust
 * License: GPL-2.0-or-later
 */
if (!defined('ABSPATH')) { exit; }
require_once __DIR__ . '/domain.php';

final class Datejust_Juleol_App {
    const NS = 'datejust-juleol/v1';
    private static function table() { global $wpdb; return $wpdb->prefix . 'datejust_juleol'; }
    public static function install() {
        global $wpdb;
        require_once ABSPATH . 'wp-admin/includes/upgrade.php';
        $table = self::table(); $charset = $wpdb->get_charset_collate();
        dbDelta("CREATE TABLE $table (
            code varchar(6) NOT NULL,
            payload longtext NOT NULL,
            updated_at datetime NOT NULL,
            PRIMARY KEY  (code)
        ) ENGINE=InnoDB $charset;");
        if ($wpdb->get_var($wpdb->prepare('SHOW TABLES LIKE %s', $wpdb->esc_like($table))) !== $table) {
            throw new RuntimeException('Kunne ikke opprette lagring for juleølsmakingen.');
        }
    }
    public static function routes() {
        foreach (array('/health', '/sessions', '/sessions/(?P<code>[A-Za-z0-9]{6})',
            '/sessions/(?P<code>[A-Za-z0-9]{6})/(?P<action>me|join|beers|round|scores)',
            '/sessions/(?P<code>[A-Za-z0-9]{6})/beers/(?P<beer>[a-f0-9]{32})',
            '/sessions/(?P<code>[A-Za-z0-9]{6})/beers/(?P<beer>[a-f0-9]{32})/(?P<image>image)',
            '/sessions/(?P<code>[A-Za-z0-9]{6})/round/(?P<close>close)') as $route) {
            register_rest_route(self::NS, $route, array('methods' => 'GET,POST,DELETE',
                'permission_callback' => '__return_true', 'callback' => array(__CLASS__, 'api')));
        }
    }
    private static function rate($key, $max, $seconds) {
        $ip = isset($_SERVER['REMOTE_ADDR']) ? (string) $_SERVER['REMOTE_ADDR'] : 'unknown';
        $key = 'djol_' . substr(wp_hash($ip . '|' . $key . '|' . floor(time() / $seconds)), 0, 32);
        $count = (int) get_transient($key);
        if ($count >= $max) { throw new Datejust_Juleol_Error(429, 'For mange forsøk. Vent litt og prøv igjen.'); }
        set_transient($key, $count + 1, $seconds + 1);
    }
    private static function data($code, $lock = false) {
        global $wpdb; $table = self::table();
        $json = $wpdb->get_var($wpdb->prepare("SELECT payload FROM $table WHERE code = %s" . ($lock ? ' FOR UPDATE' : ''), $code));
        if ($json === null) { throw new Datejust_Juleol_Error(404, 'Fant ikke smakingen. Kontroller koden.'); }
        $data = json_decode($json, true);
        if (!is_array($data)) { throw new RuntimeException('Ugyldig lagret smaking.'); }
        return $data;
    }
    public static function api($req) {
        global $wpdb; $table = self::table(); $transaction = false;
        try {
            $method = $req->get_method(); $route = $req->get_route();
            $origin = $req->get_header('origin');
            if ($method !== 'GET' && $origin && $origin !== rtrim(home_url(), '/')) {
                throw new Datejust_Juleol_Error(403, 'Åpne smakingen på dette nettstedet.');
            }
            $input = array();
            if ($method !== 'GET') {
                if (strlen($req->get_body()) > ($req['image'] ? 180000 : 16384)) { throw new Datejust_Juleol_Error(413, 'Forespørselen er for stor.'); }
                if ($req->get_body() !== '') {
                    if (!preg_match('/^application\/json(?:\s*;|$)/i', $req->get_header('content-type'))) { throw new Datejust_Juleol_Error(415, 'Send forespørselen som JSON.'); }
                    $decoded = json_decode($req->get_body());
                    if (!is_object($decoded) || json_last_error() !== JSON_ERROR_NONE) { throw new Datejust_Juleol_Error(400, 'Forespørselen inneholder ugyldig JSON.'); }
                    $input = (array) $decoded;
                }
            }
            if ($route === '/' . self::NS . '/health' && $method === 'GET') { $result = array('status' => 'ok'); }
            elseif ($route === '/' . self::NS . '/sessions' && $method === 'POST') {
                self::rate('create', 20, 3600);
                for ($i = 0; $i < 10; $i++) {
                    list($data, $result) = Datejust_Juleol_Domain::create($input, Datejust_Juleol_Domain::new_code());
                    $ok = $wpdb->insert($table, array('code' => $data['code'], 'payload' => wp_json_encode($data), 'updated_at' => current_time('mysql', true)), array('%s', '%s', '%s'));
                    if ($ok !== false) { return self::response($result, 201); }
                    if (stripos($wpdb->last_error, 'duplicate') === false) { throw new RuntimeException('Kunne ikke lagre smakingen.'); }
                }
                throw new RuntimeException('Kunne ikke velge en ledig kode.');
            } else {
                $code = strtoupper((string) $req['code']); $action = (string) $req['action'];
                if (!$code) { throw new Datejust_Juleol_Error(404, 'Fant ikke denne adressen.'); }
                $token = $req->get_header('x-datejust-token');
                if ($method === 'GET' && $action === '') { $result = array('session' => Datejust_Juleol_Domain::session(self::data($code))); }
                elseif ($method === 'GET' && $action === 'me') { $result = Datejust_Juleol_Domain::me(self::data($code), $token); }
                else {
                    if ($method === 'POST' && $req['image']) { $action = 'image'; }
                    elseif ($method === 'DELETE' && $req['beer'] && !$req['image']) { $action = 'delete'; }
                    elseif ($method === 'POST' && $req['close']) { $action = 'close'; }
                    elseif ($method !== 'POST' || !in_array($action, array('join', 'beers', 'round', 'scores'), true)) { throw new Datejust_Juleol_Error(405, 'Metoden støttes ikke.'); }
                    self::rate($action, $action === 'join' ? 120 : 600, $action === 'join' ? 900 : 60);
                    if ($wpdb->query('START TRANSACTION') === false) { throw new RuntimeException('Kunne ikke starte lagring.'); }
                    $transaction = true;
                    $data = self::data($code, true);
                    if ($action === 'image') {
                        if (Datejust_Juleol_Domain::me($data, $token)['role'] !== 'admin') { throw new Datejust_Juleol_Error(403, 'Bare arrangøren kan laste opp bilder.'); }
                        $exists = false;
                        foreach ($data['beers'] as $beer) { if ($beer['id'] === $req['beer']) { $exists = true; break; } }
                        if (!$exists) { throw new Datejust_Juleol_Error(404, 'Fant ikke ølet i denne smakingen.'); }
                        self::rate('image', 30, 60);
                        $image = $input['image'] ?? null;
                        if ($image === '') { $input = array('imageUrl' => ''); }
                        else {
                            if (!is_string($image) || !preg_match('#^data:image/jpeg;base64,([A-Za-z0-9+/=]+)$#D', $image, $match)) { throw new Datejust_Juleol_Error(400, 'Bruk et gyldig JPEG-bilde.'); }
                            $bytes = base64_decode($match[1], true);
                            $size = $bytes !== false ? @getimagesizefromstring($bytes) : false;
                            if ($bytes === false || strlen($bytes) > 120000 || !$size || $size[2] !== IMAGETYPE_JPEG || $size[0] < 1 || $size[1] < 1 || $size[0] > 512 || $size[1] > 512) {
                                throw new Datejust_Juleol_Error(400, 'Bildet må være et lite JPEG-bilde på maksimalt 512 × 512 piksler.');
                            }
                            $upload = wp_upload_bits('juleol-' . bin2hex(random_bytes(16)) . '.jpg', null, $bytes);
                            if (!empty($upload['error'])) { throw new Datejust_Juleol_Error(500, 'Kunne ikke lagre bildet. Prøv igjen.'); }
                            $input = array('imageUrl' => esc_url_raw($upload['url']));
                        }
                    }
                    $result = Datejust_Juleol_Domain::mutate($data, $action, $input, $token, $req['beer']);
                    $ok = $wpdb->update($table, array('payload' => wp_json_encode($data), 'updated_at' => current_time('mysql', true)), array('code' => $code), array('%s', '%s'), array('%s'));
                    if ($ok === false || $wpdb->query('COMMIT') === false) { throw new RuntimeException('Kunne ikke lagre endringen.'); }
                    $transaction = false;
                    return self::response($result, in_array($action, array('join', 'beers'), true) ? 201 : 200);
                }
            }
            return self::response($result);
        } catch (Datejust_Juleol_Error $error) {
            if ($transaction) { $wpdb->query('ROLLBACK'); }
            return self::response(array('error' => $error->getMessage()), $error->status);
        } catch (Throwable $error) {
            if ($transaction) { $wpdb->query('ROLLBACK'); }
            return self::response(array('error' => 'Noe gikk galt med lagringen. Prøv igjen.'), 500);
        }
    }
    private static function response($data, $status = 200) {
        return new WP_REST_Response($data, $status, array('Cache-Control' => 'no-store, private, max-age=0',
            'X-Robots-Tag' => 'noindex, nofollow, noarchive', 'X-Content-Type-Options' => 'nosniff'));
    }
    public static function page() {
        $path = wp_parse_url(isset($_SERVER['REQUEST_URI']) ? $_SERVER['REQUEST_URI'] : '', PHP_URL_PATH);
        $base = wp_parse_url(home_url('/juleolsmaking/'), PHP_URL_PATH);
        if (rtrim((string) $path, '/') !== rtrim($base, '/')) { return; }
        if (!in_array(isset($_SERVER['REQUEST_METHOD']) ? $_SERVER['REQUEST_METHOD'] : '', array('GET', 'HEAD'), true)) { status_header(405); exit; }
        status_header(200); nocache_headers();
        header('Content-Type: text/html; charset=UTF-8');
        header('X-Robots-Tag: noindex, nofollow, noarchive');
        header('X-Content-Type-Options: nosniff');
        header('X-Frame-Options: SAMEORIGIN');
        header('Referrer-Policy: same-origin');
        $nonce = base64_encode(random_bytes(18));
        header("Content-Security-Policy: default-src 'self'; script-src 'self' 'nonce-$nonce'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'self'; form-action 'self'");
        $assets = plugins_url('assets/', __FILE__);
        $html = file_get_contents(__DIR__ . '/assets/index.html');
        $html = str_replace(array('href="/favicon.svg"', 'href="/styles.css"', 'src="/app.js"'),
            array('href="' . esc_url($assets . 'favicon.svg') . '"', 'href="' . esc_url($assets . 'styles.css?ver=1.1.0') . '"', 'src="' . esc_url($assets . 'app.js?ver=1.1.0') . '"'), $html);
        $config = array('base' => home_url('/juleolsmaking/'), 'api' => untrailingslashit(rest_url(self::NS)));
        $scripts = '<script nonce="' . esc_attr($nonce) . '">window.DATEJUST_JULEOL=' . wp_json_encode($config, JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT) . ';</script>';
        $scripts .= '<script src="' . esc_url($assets . 'qrcode.js') . '"></script>';
        $html = str_replace('</head>', $scripts . '</head>', $html);
        if ($_SERVER['REQUEST_METHOD'] !== 'HEAD') { echo $html; }
        exit;
    }
}
register_activation_hook(__FILE__, array('Datejust_Juleol_App', 'install'));
add_action('rest_api_init', array('Datejust_Juleol_App', 'routes'));
add_action('template_redirect', array('Datejust_Juleol_App', 'page'), 0);

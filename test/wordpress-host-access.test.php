<?php
/** Domain rules plus the real REST dispatch; external WordPress/DB I/O is stubbed. */
define('ABSPATH', __DIR__ . '/');
function add_action() {}
function register_activation_hook() {}
$registered_routes = array();
function register_rest_route($namespace, $route, $options) { global $registered_routes; $registered_routes[] = $route; }
function home_url() { return 'https://datejust.no'; }
function wp_hash($value) { return hash('sha256', $value); }
$transients = array();
function get_transient($key) { global $transients; return $transients[$key] ?? false; }
function set_transient($key, $value, $expiry) { global $transients; $transients[$key] = $value; }
function wp_json_encode($value) { return json_encode($value); }
function current_time() { return '2026-11-04 14:00:00'; }
class WP_REST_Response {
    public $data; public $status; public $headers;
    public function __construct($data, $status, $headers) { $this->data = $data; $this->status = $status; $this->headers = $headers; }
}
class HostAccessDB {
    public $prefix = 'wp_'; public $last_error = ''; public $rows = array(); public $queries = array();
    public function prepare($sql, ...$args) { return array($sql, $args); }
    public function get_var($prepared) {
        $this->queries[] = $prepared[0];
        $code = $prepared[1][0];
        return isset($this->rows[$code]) ? json_encode($this->rows[$code]) : null;
    }
    public function query($sql) { $this->queries[] = $sql; return 1; }
    public function update($table, $values, $where, $formats, $whereFormats) {
        $this->rows[$where['code']] = json_decode($values['payload'], true); return 1;
    }
}
class HostAccessRequest extends ArrayObject {
    private $input; private $token; private $method;
    public function __construct($code, $action, $input = array(), $token = null, $method = 'POST') {
        parent::__construct(array('code' => $code, 'action' => $action, 'beer' => null, 'image' => null, 'close' => null));
        $this->input = $input; $this->token = $token; $this->method = $method;
    }
    public function get_method() { return $this->method; }
    public function get_route() { return '/datejust-juleol/v1/sessions/' . $this['code'] . '/' . $this['action']; }
    public function get_body() { return $this->method === 'GET' ? '' : json_encode((object) $this->input); }
    public function get_header($name) { return array('origin' => 'https://datejust.no', 'content-type' => 'application/json', 'x-datejust-token' => $this->token)[$name] ?? ''; }
}
require __DIR__ . '/../wordpress/datejust-juleol/datejust-juleol.php';
$checks = 0;
function check($condition, $label) { global $checks; if (!$condition) { throw new RuntimeException($label); } $checks++; }
function rejects($status, $operation, $label) {
    try { $operation(); } catch (Datejust_Juleol_Error $e) { check($e->status === $status, $label); return $e->getMessage(); }
    throw new RuntimeException($label . ': invalid operation accepted');
}
list($data, $created) = Datejust_Juleol_Domain::create(array('name' => 'Flere arrangører'), 'ABC234');
$creator = $created['adminToken'];
check($created['session']['hostCodeGeneration'] === 0 && $data['hostCodeGeneration'] === 0, 'new payload starts with generation zero');
unset($data['hostCodeGeneration']);
check(Datejust_Juleol_Domain::session($data)['hostCodeGeneration'] === 0, 'legacy payload defaults to generation zero');
// An old payload has neither of the new fields and must keep its creator access.
check(!isset($data['adminHashes']) && !isset($data['hostCodeHash']), 'old payload remains supported');
check(Datejust_Juleol_Domain::me($data, $creator)['role'] === 'admin', 'original creator recognized');
$participant = Datejust_Juleol_Domain::mutate($data, 'join', array('name' => 'Nora'));
rejects(401, function () use (&$data) { Datejust_Juleol_Domain::mutate($data, 'host-code', array()); }, 'guest cannot generate host code');
rejects(403, function () use (&$data, $participant) { Datejust_Juleol_Domain::mutate($data, 'host-code', array(), $participant['participantToken']); }, 'participant cannot generate host code');
$missing = rejects(401, function () use (&$data) { Datejust_Juleol_Domain::mutate($data, 'host-login', array()); }, 'missing code rejected');
$rev = $data['revision'];
$generated = Datejust_Juleol_Domain::mutate($data, 'host-code', array(), $creator);
$hostCode = $generated['hostCode'];
check(preg_match('/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/D', $hostCode) === 1, 'random eight-character host code');
check($data['revision'] === $rev + 1, 'code rotation advances revision');
check($data['hostCodeHash'] === hash('sha256', $hostCode), 'host code stored only as hash');
check($data['hostCodeGeneration'] === 1 && $generated['session']['hostCodeGeneration'] === 1, 'first rotation stores and exposes generation one');
$wrong = rejects(401, function () use (&$data) { Datejust_Juleol_Domain::mutate($data, 'host-login', array('hostCode' => '00000000')); }, 'wrong code rejected');
check($missing === $wrong, 'wrong and missing codes have the same generic error');
$wrongValidCode = ($hostCode[0] === 'A' ? 'B' : 'A') . substr($hostCode, 1);
rejects(401, function () use (&$data, $wrongValidCode) { Datejust_Juleol_Domain::mutate($data, 'host-login', array('hostCode' => $wrongValidCode)); }, 'valid-format wrong code rejected by hash comparison');
$formatted = strtolower(substr($hostCode, 0, 4) . '- ' . substr($hostCode, 4));
$firstLogin = Datejust_Juleol_Domain::mutate($data, 'host-login', array('hostCode' => $formatted));
$firstHost = $firstLogin['adminToken'];
check(Datejust_Juleol_Domain::me($data, $firstHost)['role'] === 'admin', 'new device gains host access');
check($data['revision'] === $rev + 2, 'host login advances revision');
check($firstLogin['session']['hostCodeGeneration'] === 1, 'host login does not change code generation');
check($data['adminHashes'][0] === hash('sha256', $firstHost), 'additional host token stored as hash');
check($data['adminHash'] === hash('sha256', $creator), 'original creator hash preserved');
$beer = Datejust_Juleol_Domain::mutate($data, 'beers', array('name' => 'Julebokk'), $firstHost);
Datejust_Juleol_Domain::mutate($data, 'round', array('beerId' => $beer['beerId']), $creator);
Datejust_Juleol_Domain::mutate($data, 'scores', array('beerId' => $beer['beerId'], 'score' => 8), $participant['participantToken']);
check(Datejust_Juleol_Domain::session($data)['hostCodeGeneration'] === 1, 'votes and normal mutations do not change code generation');
Datejust_Juleol_Domain::mutate($data, 'image', array('imageUrl' => 'https://datejust.no/beer.jpg'), $firstHost, $beer['beerId']);
$secondLogin = Datejust_Juleol_Domain::mutate($data, 'host-login', array('hostCode' => $hostCode));
$secondHost = $secondLogin['adminToken'];
check($firstHost !== $secondHost, 'devices receive independent tokens');
$rotated = Datejust_Juleol_Domain::mutate($data, 'host-code', array(), $secondHost);
$newCode = $rotated['hostCode'];
check($newCode !== $hostCode, 'rotating replaces invitation code');
check($rotated['session']['hostCodeGeneration'] === 2 && $data['hostCodeGeneration'] === 2, 'next rotation advances generation to two');
rejects(401, function () use (&$data, $hostCode) { Datejust_Juleol_Domain::mutate($data, 'host-login', array('hostCode' => $hostCode)); }, 'old invitation code no longer works');
foreach (array($creator, $firstHost, $secondHost) as $token) {
    check(Datejust_Juleol_Domain::me($data, $token)['role'] === 'admin', 'issued host tokens survive invitation rotation');
}
$restored = json_decode(json_encode($data), true);
check(Datejust_Juleol_Domain::session($restored)['hostCodeGeneration'] === 2, 'generation survives JSON persistence and restore');
check(Datejust_Juleol_Domain::me($restored, $firstHost)['role'] === 'admin', 'additional host survives JSON persistence');
check(Datejust_Juleol_Domain::session($restored)['beers'][0]['averageScore'] == 8, 'votes survive host sharing');
check(Datejust_Juleol_Domain::session($restored)['beers'][0]['imageUrl'] === 'https://datejust.no/beer.jpg', 'photos survive host sharing');
$public = json_encode(array(Datejust_Juleol_Domain::session($data), Datejust_Juleol_Domain::me($data, $creator), Datejust_Juleol_Domain::me($data, $firstHost), Datejust_Juleol_Domain::me($data, $participant['participantToken'])));
foreach (array('hostCodeHash', 'adminHashes', 'adminHash', $hostCode, $newCode, $creator, $firstHost, $secondHost, $data['hostCodeHash']) as $private) {
    check(strpos($public, $private) === false, 'public state and identities exclude private host data');
}
$capped = $data;
$capped['adminHashes'] = array_fill(0, 100, hash('sha256', 'another secure host token'));
rejects(409, function () use (&$capped, $newCode) { Datejust_Juleol_Domain::mutate($capped, 'host-login', array('hostCode' => $newCode)); }, 'additional token cap enforced');
check(Datejust_Juleol_Domain::me($capped, $creator)['role'] === 'admin', 'token cap does not revoke creator');

// Exercise action routing, persistence and the exact IP/session rate buckets.
Datejust_Juleol_App::routes();
check(strpos(implode(' ', $registered_routes), '|host-code|host-login') !== false, 'REST routes include host sharing');
$wpdb = new HostAccessDB(); $wpdb->rows['ABC234'] = $data;
$_SERVER['REMOTE_ADDR'] = '192.0.2.24';
$transients = array();
$response = Datejust_Juleol_App::api(new HostAccessRequest('ABC234', 'host-login', array('hostCode' => $newCode)));
check($response->status === 200 && isset($response->data['adminToken']), 'unauthenticated host login dispatched inside transaction');
check(Datejust_Juleol_Domain::me($wpdb->rows['ABC234'], $response->data['adminToken'])['role'] === 'admin', 'new REST host persisted');
check(in_array('START TRANSACTION', $wpdb->queries, true) && in_array('COMMIT', $wpdb->queries, true), 'REST login retains locked storage transaction');
check(strpos(implode(' ', $wpdb->queries), 'FOR UPDATE') !== false, 'REST login locks the persisted session row');
check($response->headers['Cache-Control'] === 'no-store, private, max-age=0', 'host response is not cacheable');
$transients = array();
for ($i = 0; $i < 10; $i++) {
    $response = Datejust_Juleol_App::api(new HostAccessRequest('ABC234', 'host-login', array('hostCode' => '00000000')));
    check($response->status === 401, 'invalid attempt counted in session bucket');
}
$response = Datejust_Juleol_App::api(new HostAccessRequest('ABC234', 'host-login', array('hostCode' => $newCode)));
check($response->status === 429, 'eleventh login limited per session and IP');
$transients = array();
foreach (array('ABC234', 'BCD234', 'CDE234', 'DEF234', 'EFG234', 'FGH234') as $code) {
    $wpdb->rows[$code] = $data; $wpdb->rows[$code]['code'] = $code;
    for ($i = 0; $i < 10; $i++) {
        check(Datejust_Juleol_App::api(new HostAccessRequest($code, 'host-login', array('hostCode' => '00000000')))->status === 401, 'global bucket counts attempts across sessions');
    }
}
$wpdb->rows['GHJ234'] = $data; $wpdb->rows['GHJ234']['code'] = 'GHJ234';
check(Datejust_Juleol_App::api(new HostAccessRequest('GHJ234', 'host-login', array('hostCode' => $newCode)))->status === 429, 'sixty-first global login limited');
$transients = array();
for ($i = 0; $i < 20; $i++) {
    check(Datejust_Juleol_App::api(new HostAccessRequest('ABC234', 'host-code', array(), $creator))->status === 200, 'authorized rotation allowed within hourly bucket');
}
check(Datejust_Juleol_App::api(new HostAccessRequest('ABC234', 'host-code', array(), $creator))->status === 429, 'twenty-first rotation limited per session/IP');
check(Datejust_Juleol_App::api(new HostAccessRequest('ABC234', 'host-code', array(), $participant['participantToken']))->status === 403, 'rotation permission checked before rate bucket');
check(Datejust_Juleol_App::api(new HostAccessRequest('ABC234', 'host-login', array(), null, 'GET'))->status === 405, 'host login only accepts POST');
echo "$checks WordPress host-access checks passed.\n";

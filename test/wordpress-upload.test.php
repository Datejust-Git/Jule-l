<?php
/** Exercise the real REST adapter; only external WordPress/DB I/O is stubbed. */
define('ABSPATH', __DIR__ . '/');
function add_action() {}
function register_activation_hook() {}
function home_url() { return 'https://datejust.no'; }
function wp_hash($value) { return hash('sha256', $value); }
function get_transient() { return 0; }
function set_transient() {}
function wp_json_encode($value) { return json_encode($value); }
function current_time() { return '2026-11-04 13:00:00'; }
function esc_url_raw($url) { return $url; }
$uploaded = 0;
function wp_upload_bits($name, $unused, $bytes) {
    global $uploaded; $uploaded++;
    return array('url' => 'https://datejust.no/wp-content/uploads/' . $name, 'error' => false);
}
class WP_REST_Response {
    public $data; public $status;
    public function __construct($data, $status, $headers) { $this->data = $data; $this->status = $status; }
}
class FakeTastingDB {
    public $prefix = 'wp_'; public $last_error = ''; public $data;
    public function prepare($sql, ...$args) { return $sql; }
    public function get_var($sql) { return json_encode($this->data); }
    public function query($sql) { return 1; }
    public function update($table, $values, $where, $formats, $whereFormats) { $this->data = json_decode($values['payload'], true); return 1; }
}
class TastingRequest extends ArrayObject {
    private $input; private $token;
    public function __construct($input, $token, $beer) {
        parent::__construct(array('code' => 'ABC234', 'image' => 'image', 'beer' => $beer, 'action' => null, 'close' => null));
        $this->input = $input; $this->token = $token;
    }
    public function get_method() { return 'POST'; }
    public function get_route() { return '/datejust-juleol/v1/sessions/ABC234/beers/' . $this['beer'] . '/image'; }
    public function get_body() { return json_encode($this->input); }
    public function get_header($name) { return array('origin' => 'https://datejust.no', 'content-type' => 'application/json', 'x-datejust-token' => $this->token)[$name] ?? ''; }
}
require __DIR__ . '/../wordpress/datejust-juleol/datejust-juleol.php';
list($data, $created) = Datejust_Juleol_Domain::create(array('name' => 'Foto-test'), 'ABC234');
$host = $created['adminToken'];
$person = Datejust_Juleol_Domain::mutate($data, 'join', array('name' => 'Nora'));
Datejust_Juleol_Domain::mutate($data, 'beers', array('name' => 'Testøl'), $host);
$beer = $data['beers'][0]['id'];
$wpdb = new FakeTastingDB(); $wpdb->data = $data;
$jpeg = '/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAAYABADASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCMATFcAB//2Q==';
$image = 'data:image/jpeg;base64,' . $jpeg;
$cases = array(
    array(null, array('image' => $image), 401),
    array($person['participantToken'], array('image' => $image), 403),
    array($host, array('image' => 'data:image/png;base64,AAAA'), 400),
    array($host, array('image' => 'data:image/jpeg;base64,AAAA'), 400),
    array($host, array('image' => str_repeat('A', 180001)), 413),
    array($host, array('imageUrl' => 'https://evil.example/x.jpg'), 400),
    array($host, array('image' => $image), 200),
);
foreach ($cases as $index => $case) {
    $response = Datejust_Juleol_App::api(new TastingRequest($case[1], $case[0], $beer));
    if ($response->status !== $case[2]) { throw new RuntimeException('Upload case ' . $index . ' returned ' . $response->status . ': ' . json_encode($response->data)); }
}
if ($uploaded !== 1) { throw new RuntimeException('Invalid uploads wrote image files.'); }
if (strpos($wpdb->data['beers'][0]['imageUrl'], 'https://datejust.no/wp-content/uploads/juleol-') !== 0) { throw new RuntimeException('Missing uploaded URL.'); }
echo count($cases) . " REST upload cases passed.\n";

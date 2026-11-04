<?php
require __DIR__ . '/../wordpress/datejust-juleol/domain.php';
$checks = 0;
function check($condition, $label) { global $checks; if (!$condition) { throw new RuntimeException($label); } $checks++; }
function rejects($status, $operation, $label) {
    try { $operation(); } catch (Datejust_Juleol_Error $e) { check($e->status === $status, $label . ': status'); return; }
    throw new RuntimeException($label . ': accepted invalid action');
}
list($data, $created) = Datejust_Juleol_Domain::create(array('name' => 'Juleøl hos oss'), 'ABC234');
$host = $created['adminToken'];
check($created['session']['name'] === 'Juleøl hos oss', 'tasting created');
check(strpos(json_encode($data), $host) === false, 'host secret stored as hash');
check(strpos(json_encode($created['session']), 'adminHash') === false, 'public state excludes host hash');
rejects(401, function () use (&$data) { Datejust_Juleol_Domain::mutate($data, 'beers', array('name' => 'A')); }, 'guest cannot add beer');
$a = Datejust_Juleol_Domain::mutate($data, 'join', array('name' => 'Nora'));
$b = Datejust_Juleol_Domain::mutate($data, 'join', array('name' => 'Emil'));
rejects(409, function () use (&$data) { Datejust_Juleol_Domain::mutate($data, 'join', array('name' => 'nora')); }, 'duplicate names blocked');
rejects(403, function () use (&$data, $a) { Datejust_Juleol_Domain::mutate($data, 'beers', array('name' => 'A'), $a['participantToken']); }, 'participant cannot manage tasting');
Datejust_Juleol_Domain::mutate($data, 'beers', array('name' => 'Juleøl A', 'brewery' => 'Testbryggeri', 'abv' => 6.5), $host);
Datejust_Juleol_Domain::mutate($data, 'beers', array('name' => 'Juleøl B'), $host);
$first = $data['beers'][0]['id']; $second = $data['beers'][1]['id'];
Datejust_Juleol_Domain::mutate($data, 'round', array('beerId' => $first), $host);
check(Datejust_Juleol_Domain::session($data)['missingCount'] === 2, 'two missing votes');
foreach (array(0, 11, 1.5, '8') as $bad) {
    rejects(400, function () use (&$data, $a, $first, $bad) { Datejust_Juleol_Domain::mutate($data, 'scores', array('beerId' => $first, 'score' => $bad), $a['participantToken']); }, 'invalid score blocked');
}
Datejust_Juleol_Domain::mutate($data, 'scores', array('beerId' => $first, 'score' => 8), $a['participantToken']);
$result = Datejust_Juleol_Domain::mutate($data, 'scores', array('beerId' => $first, 'score' => 10), $b['participantToken']);
check(abs($result['session']['beers'][0]['averageScore'] - 9) < 0.000001, 'shared average is nine');
check($result['session']['missingCount'] === 0, 'all participants voted');
Datejust_Juleol_Domain::mutate($data, 'scores', array('beerId' => $first, 'score' => 6), $a['participantToken']);
$public = Datejust_Juleol_Domain::session($data);
check(abs($public['beers'][0]['averageScore'] - 8) < 0.000001, 'updated score replaces old score');
check($public['beers'][0]['scoreCount'] === 2, 'updated score not double counted');
rejects(403, function () use (&$data, $host, $first) { Datejust_Juleol_Domain::mutate($data, 'scores', array('beerId' => $first, 'score' => 9), $host); }, 'host cannot cast participant vote');
Datejust_Juleol_Domain::mutate($data, 'round', array('beerId' => $second), $host);
check(Datejust_Juleol_Domain::session($data)['missingCount'] === 2, 'new round resets pending list');
rejects(409, function () use (&$data, $a, $first) { Datejust_Juleol_Domain::mutate($data, 'scores', array('beerId' => $first, 'score' => 8), $a['participantToken']); }, 'stale vote rejected');
Datejust_Juleol_Domain::mutate($data, 'close', array(), $host);
rejects(409, function () use (&$data, $a) { Datejust_Juleol_Domain::mutate($data, 'scores', array('score' => 8), $a['participantToken']); }, 'closed round rejects vote');
rejects(409, function () use (&$data, $host, $first) { Datejust_Juleol_Domain::mutate($data, 'delete', array(), $host, $first); }, 'scored beer cannot be deleted');
Datejust_Juleol_Domain::mutate($data, 'delete', array(), $host, $second);
check(count($data['beers']) === 1, 'unscored beer can be deleted');
$restored = json_decode(json_encode($data), true);
check(Datejust_Juleol_Domain::session($restored) === Datejust_Juleol_Domain::session($data), 'JSON persistence roundtrip');
check(((array) Datejust_Juleol_Domain::me($restored, $a['participantToken'])['scores'])[$first] === 6, 'own vote survives restore');
list($other, $otherCreated) = Datejust_Juleol_Domain::create(array('name' => 'Annen kveld'), 'XYZ789');
rejects(401, function () use (&$other, $host) { Datejust_Juleol_Domain::me($other, $host); }, 'token cannot access another tasting');
check(!preg_match('/adminHash|tokenHash|nameKey/', json_encode(Datejust_Juleol_Domain::session($data))), 'no private fields in public state');
echo "$checks WordPress domain checks passed.\n";

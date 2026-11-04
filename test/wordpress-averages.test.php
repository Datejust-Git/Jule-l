<?php
/** Public average fields must match the Node application, including old saved JSON. */
require __DIR__ . '/../wordpress/datejust-juleol/domain.php';
$checks = 0;
function average_check($condition, $label) {
    global $checks;
    if (!$condition) { throw new RuntimeException($label); }
    $checks++;
}
function average_near($actual, $expected, $label) {
    average_check(is_numeric($actual) && abs($actual - $expected) < 0.000001, $label);
}
function average_person($session, $id) {
    foreach ($session['participants'] as $person) { if ($person['id'] === $id) { return $person; } }
    throw new RuntimeException('Missing participant');
}
list($data, $created) = Datejust_Juleol_Domain::create(array('name' => 'Snitt gjennom kvelden'), 'ABC234');
$host = $created['adminToken'];
average_check($created['session']['groupAverageScore'] === null, 'empty tasting has no group average');
average_check($created['session']['groupScoreCount'] === 0, 'empty tasting has zero group votes');
$a = Datejust_Juleol_Domain::mutate($data, 'join', array('name' => 'Nora'));
$b = Datejust_Juleol_Domain::mutate($data, 'join', array('name' => 'Emil'));
$c = Datejust_Juleol_Domain::mutate($data, 'join', array('name' => 'Venter'));
foreach ($c['session']['participants'] as $person) {
    average_check($person['averageScore'] === null && $person['scoreCount'] === 0 && $person['totalScore'] === 0, 'unscored participant has null average and zero totals');
}
$first = Datejust_Juleol_Domain::mutate($data, 'beers', array('name' => 'Første øl'), $host);
$firstId = $first['beerId'];
average_check($firstId === $first['session']['beers'][0]['id'], 'new beer response identifies exact added beer');
average_check($first['session']['beers'][0]['imageUrl'] === null, 'old-style beer data gets explicit null image URL');
$second = Datejust_Juleol_Domain::mutate($data, 'beers', array('name' => 'Andre øl'), $host);
$secondId = $second['beerId'];
average_check($firstId !== $secondId && $secondId === $second['session']['beers'][1]['id'], 'second add returns second beer ID');
Datejust_Juleol_Domain::mutate($data, 'round', array('beerId' => $firstId), $host);
Datejust_Juleol_Domain::mutate($data, 'scores', array('beerId' => $firstId, 'score' => 10), $a['participantToken']);
Datejust_Juleol_Domain::mutate($data, 'scores', array('beerId' => $firstId, 'score' => 8), $b['participantToken']);
Datejust_Juleol_Domain::mutate($data, 'round', array('beerId' => $secondId), $host);
$rated = Datejust_Juleol_Domain::mutate($data, 'scores', array('beerId' => $secondId, 'score' => 2), $a['participantToken']);
$session = $rated['session'];
$nora = average_person($session, $a['participantId']);
$emil = average_person($session, $b['participantId']);
$waiting = average_person($session, $c['participantId']);
average_near($nora['averageScore'], 6, 'participant mean spans both beers');
average_check($nora['scoreCount'] === 2 && $nora['totalScore'] === 12, 'participant totals span distinct beers');
average_near($emil['averageScore'], 8, 'participant with one score keeps that score as mean');
average_check($emil['scoreCount'] === 1 && $emil['totalScore'] === 8, 'other participant totals remain separate');
average_check($waiting['averageScore'] === null && $waiting['scoreCount'] === 0, 'missing votes never become zero scores');
average_near($session['groupAverageScore'], 20 / 3, 'group mean weights all individual scores');
average_check($session['groupScoreCount'] === 3, 'group count includes all distinct participant and beer pairs');
average_check($nora['hasScored'] === true && $emil['hasScored'] === false, 'current round completion remains independent of evening totals');
average_check($session['scoredCount'] === 1 && $session['missingCount'] === 2, 'pending TV status still describes current beer');
$updated = Datejust_Juleol_Domain::mutate($data, 'scores', array('beerId' => $secondId, 'score' => 4), $a['participantToken']);
average_near($updated['session']['groupAverageScore'], 22 / 3, 'editing a vote replaces its group contribution');
$nora = average_person($updated['session'], $a['participantId']);
average_check($nora['scoreCount'] === 2 && $nora['totalScore'] === 14, 'editing a vote does not increase participant count');
average_near($nora['averageScore'], 7, 'editing a vote updates participant average');
average_check($updated['session']['groupScoreCount'] === 3, 'editing a vote does not increase group count');
$closed = Datejust_Juleol_Domain::mutate($data, 'close', array(), $host);
average_near($closed['session']['groupAverageScore'], 22 / 3, 'closing a round preserves the group mean');
average_check($closed['session']['scoredCount'] === 0 && $closed['session']['missingCount'] === 0, 'closed round has no pending completion state');
$image = Datejust_Juleol_Domain::mutate($data, 'image', array('imageUrl' => 'https://datejust.no/wp-content/uploads/test.jpg'), $host, $firstId);
average_near($image['session']['groupAverageScore'], 22 / 3, 'changing a scored beer photo preserves group votes');
average_check($image['session']['beers'][0]['imageUrl'] === 'https://datejust.no/wp-content/uploads/test.jpg', 'existing uploaded photo remains public');
$cleared = Datejust_Juleol_Domain::mutate($data, 'image', array('imageUrl' => ''), $host, $firstId);
average_check($data['beers'][0]['imageUrl'] === '' && $cleared['session']['beers'][0]['imageUrl'] === null, 'legacy empty image storage becomes null only in public state');
$restored = json_decode(json_encode($data), true);
average_check(Datejust_Juleol_Domain::session($restored) === Datejust_Juleol_Domain::session($data), 'averages derive correctly after durable JSON roundtrip');
$own = (array) Datejust_Juleol_Domain::me($restored, $a['participantToken'])['scores'];
average_check($own[$firstId] === 10 && $own[$secondId] === 4, 'private per-beer votes are preserved');
list($other, $unused) = Datejust_Juleol_Domain::create(array('name' => 'En annen kveld'), 'XYZ789');
average_check(Datejust_Juleol_Domain::session($other)['groupAverageScore'] === null, 'averages do not leak into another tasting');
echo "$checks WordPress average checks passed.\n";

<?php
/** Pure tasting rules; the WordPress adapter supplies durable, locked storage. */
if (!defined('ABSPATH') && PHP_SAPI !== 'cli') { exit; }

class Datejust_Juleol_Error extends RuntimeException {
    public $status;
    public function __construct($status, $message) { parent::__construct($message); $this->status = $status; }
}

final class Datejust_Juleol_Domain {
    private static function fail($status, $message) { throw new Datejust_Juleol_Error($status, $message); }
    private static function text($value, $label, $max, $optional = false) {
        if ($optional && ($value === null || $value === '')) { return ''; }
        if (!is_string($value)) { self::fail(400, $label . ' må være tekst.'); }
        $value = trim($value);
        if (class_exists('Normalizer')) { $value = Normalizer::normalize($value, Normalizer::FORM_C); }
        $length = function_exists('mb_strlen') ? mb_strlen($value, 'UTF-8') : strlen($value);
        if (!$length || $length > $max || preg_match('/[\x00-\x1f\x7f]/u', $value)) {
            self::fail(400, $label . ' må inneholde mellom 1 og ' . $max . ' tegn.');
        }
        return $value;
    }
    private static function token() { return bin2hex(random_bytes(32)); }
    private static function id() { return bin2hex(random_bytes(16)); }
    private static function now() { return gmdate('Y-m-d\TH:i:s\Z'); }
    public static function new_code() {
        $alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; $result = '';
        for ($i = 0; $i < 6; $i++) { $result .= $alphabet[random_int(0, strlen($alphabet) - 1)]; }
        return $result;
    }
    private static function new_host_code() {
        $alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; $result = '';
        for ($i = 0; $i < 8; $i++) { $result .= $alphabet[random_int(0, strlen($alphabet) - 1)]; }
        return $result;
    }
    public static function create($input, $code) {
        $token = self::token();
        $data = array('code' => $code, 'name' => self::text($input['name'] ?? null, 'Navnet på smakingen', 80),
            'adminHash' => hash('sha256', $token), 'activeBeerId' => null, 'createdAt' => self::now(),
            'revision' => 0, 'hostCodeGeneration' => 0, 'beers' => array(), 'participants' => array(), 'scores' => array());
        return array($data, array('code' => $code, 'adminToken' => $token, 'session' => self::session($data)));
    }
    public static function session($data) {
        $beers = array(); $participants = array(); $scored = 0;
        $beerIds = array(); $groupTotal = 0; $groupCount = 0;
        foreach ($data['beers'] as $beer) {
            $beerIds[$beer['id']] = true;
            $total = 0; $count = 0;
            foreach ($data['scores'] as $votes) {
                if (isset($votes[$beer['id']])) { $count++; $total += $votes[$beer['id']]; }
            }
            $publicBeer = $beer;
            $publicBeer['imageUrl'] = !empty($beer['imageUrl']) ? $beer['imageUrl'] : null;
            $beers[] = $publicBeer + array('scoreCount' => $count, 'totalScore' => $total, 'averageScore' => $count ? $total / $count : null);
            $groupTotal += $total; $groupCount += $count;
        }
        foreach ($data['participants'] as $person) {
            $has = $data['activeBeerId'] !== null && isset($data['scores'][$person['id']][$data['activeBeerId']]);
            if ($has) { $scored++; }
            $total = 0; $count = 0;
            foreach (($data['scores'][$person['id']] ?? array()) as $beerId => $score) {
                if (isset($beerIds[$beerId])) { $total += $score; $count++; }
            }
            $participants[] = array('id' => $person['id'], 'name' => $person['name'], 'hasScored' => $has,
                'scoreCount' => $count, 'totalScore' => $total, 'averageScore' => $count ? $total / $count : null);
        }
        return array('code' => $data['code'], 'name' => $data['name'], 'createdAt' => $data['createdAt'],
            'revision' => $data['revision'], 'hostCodeGeneration' => (int) ($data['hostCodeGeneration'] ?? 0),
            'activeBeerId' => $data['activeBeerId'], 'beers' => $beers,
            'participants' => $participants, 'participantCount' => count($participants), 'scoredCount' => $scored,
            'missingCount' => $data['activeBeerId'] === null ? 0 : count($participants) - $scored,
            'groupAverageScore' => $groupCount ? $groupTotal / $groupCount : null, 'groupScoreCount' => $groupCount);
    }
    private static function identity($data, $token) {
        if (!is_string($token) || strlen($token) < 20 || strlen($token) > 200) { self::fail(401, 'Du må logge inn på smakingen på nytt.'); }
        $digest = hash('sha256', $token);
        if (hash_equals($data['adminHash'], $digest)) { return array('role' => 'admin'); }
        foreach (($data['adminHashes'] ?? array()) as $adminHash) {
            if (hash_equals($adminHash, $digest)) { return array('role' => 'admin'); }
        }
        foreach ($data['participants'] as $person) {
            if (hash_equals($person['tokenHash'], $digest)) { return array('role' => 'participant', 'participantId' => $person['id']); }
        }
        self::fail(401, 'Tilgangen er ugyldig. Bli med på smakingen på nytt.');
    }
    public static function me($data, $token) {
        $identity = self::identity($data, $token);
        if ($identity['role'] === 'participant') { $identity['scores'] = (object) ($data['scores'][$identity['participantId']] ?? array()); }
        return $identity;
    }
    private static function beer($data, $id) {
        foreach ($data['beers'] as $beer) { if ($beer['id'] === $id) { return $beer; } }
        self::fail(404, 'Fant ikke ølet i denne smakingen.');
    }
    public static function mutate(&$data, $action, $input, $token = null, $id = null) {
        $extra = array();
        if ($action !== 'join' && $action !== 'host-login') {
            $identity = self::identity($data, $token);
            if ($action !== 'scores' && $identity['role'] !== 'admin') { self::fail(403, 'Bare arrangøren kan gjøre dette.'); }
        }
        switch ($action) {
            case 'host-code':
                $hostCode = self::new_host_code();
                $data['hostCodeHash'] = hash('sha256', $hostCode);
                $data['hostCodeGeneration'] = (int) ($data['hostCodeGeneration'] ?? 0) + 1;
                $extra = array('hostCode' => $hostCode);
                break;
            case 'host-login':
                $hostCode = isset($input['hostCode']) && is_string($input['hostCode'])
                    ? preg_replace('/[\s-]+/u', '', $input['hostCode']) : '';
                $hostCode = is_string($hostCode) ? strtoupper($hostCode) : '';
                if (!preg_match('/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/D', $hostCode)
                    || empty($data['hostCodeHash']) || !hash_equals($data['hostCodeHash'], hash('sha256', $hostCode))) {
                    self::fail(401, 'Vertskoden er feil. Kontroller koden og prøv igjen.');
                }
                $adminHashes = $data['adminHashes'] ?? array();
                if (count($adminHashes) >= 100) { self::fail(409, 'Smakingen har nådd grensen på 100 ekstra arrangørtilganger.'); }
                $adminToken = self::token();
                $adminHashes[] = hash('sha256', $adminToken);
                $data['adminHashes'] = $adminHashes;
                $extra = array('adminToken' => $adminToken);
                break;
            case 'join':
                $name = self::text($input['name'] ?? null, 'Navnet ditt', 40);
                $key = class_exists('Normalizer') ? Normalizer::normalize($name, Normalizer::FORM_KC) : $name;
                $key = function_exists('mb_strtolower') ? mb_strtolower($key, 'UTF-8') : strtolower($key);
                foreach ($data['participants'] as $person) { if ($person['nameKey'] === $key) { self::fail(409, 'Navnet er allerede i bruk. Velg et annet navn.'); } }
                if (count($data['participants']) >= 100) { self::fail(409, 'Smakingen har nådd grensen på 100 deltakere.'); }
                $participantToken = self::token(); $participantId = self::id();
                $data['participants'][] = array('id' => $participantId, 'name' => $name, 'nameKey' => $key, 'tokenHash' => hash('sha256', $participantToken));
                $extra = array('participantToken' => $participantToken, 'participantId' => $participantId);
                break;
            case 'beers':
                if (count($data['beers']) >= 100) { self::fail(409, 'Du kan legge til maksimalt 100 øl i én smaking.'); }
                $name = self::text($input['name'] ?? null, 'Ølnavnet', 100);
                $brewery = self::text($input['brewery'] ?? null, 'Bryggeriet', 80, true);
                $abv = $input['abv'] ?? null;
                if ($abv === '') { $abv = null; }
                if ($abv !== null && ((!is_int($abv) && !is_float($abv)) || !is_finite((float) $abv) || $abv < 0 || $abv > 100)) {
                    self::fail(400, 'Alkoholprosenten må være et tall mellom 0 og 100.');
                }
                $position = 1;
                foreach ($data['beers'] as $beer) { $position = max($position, $beer['order'] + 1); }
                $beerId = self::id();
                $data['beers'][] = array('id' => $beerId, 'name' => $name, 'brewery' => $brewery, 'abv' => $abv, 'order' => $position);
                $extra['beerId'] = $beerId;
                break;
            case 'delete':
                self::beer($data, $id);
                if ($data['activeBeerId'] === $id) { self::fail(409, 'Øl som smakes nå eller har fått poeng, kan ikke slettes.'); }
                foreach ($data['scores'] as $votes) { if (isset($votes[$id])) { self::fail(409, 'Øl som har fått poeng, kan ikke slettes.'); } }
                $data['beers'] = array_values(array_filter($data['beers'], function ($beer) use ($id) { return $beer['id'] !== $id; }));
                break;
            case 'round':
                $beer = self::beer($data, $input['beerId'] ?? null); $data['activeBeerId'] = $beer['id'];
                break;
            case 'image':
                self::beer($data, $id);
                $imageUrl = $input['imageUrl'] ?? '';
                if (!is_string($imageUrl) || strlen($imageUrl) > 2048 || ($imageUrl !== '' && !preg_match('#^https?://#', $imageUrl))) {
                    self::fail(400, 'Ugyldig bildeadresse.');
                }
                foreach ($data['beers'] as &$beer) { if ($beer['id'] === $id) { $beer['imageUrl'] = $imageUrl; break; } }
                unset($beer);
                break;
            case 'close': $data['activeBeerId'] = null; break;
            case 'scores':
                if ($identity['role'] !== 'participant') { self::fail(403, 'Bli med som deltaker for å gi poeng.'); }
                if ($data['activeBeerId'] === null) { self::fail(409, 'Ingen øl er åpent for poeng akkurat nå.'); }
                if (isset($input['beerId']) && $input['beerId'] !== $data['activeBeerId']) { self::fail(409, 'Arrangøren har byttet øl. Last inn det nye ølet før du gir poeng.'); }
                $score = $input['score'] ?? null;
                if (!is_int($score) || $score < 1 || $score > 10) { self::fail(400, 'Velg et helt antall poeng fra 1 til 10.'); }
                $data['scores'][$identity['participantId']][$data['activeBeerId']] = $score;
                break;
            default: self::fail(404, 'Fant ikke denne adressen.');
        }
        $data['revision']++;
        return $extra + array('session' => self::session($data));
    }
}

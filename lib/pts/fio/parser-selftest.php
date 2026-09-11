<?php
// Run with PHP and the pinned PTS 10.8.4 source directory as argv[1]. No benchmark is executed.
error_reporting(E_ERROR | E_PARSE);
define('PTS_MODE', 'SILENT');
define('PTS_AUTO_LOAD_OBJECTS', true);
define('PTS_AUTO_LOAD_ALL_OBJECTS', true);
require $argv[1] . '/pts-core/phoronix-test-suite.php';
define('PTS_TEST_PROFILE_PATH', dirname(__DIR__, 3) . '/packages/schema/src/pts-profiles/');
$cases = [
    ['1024KiB/s', '17', 1.048576, 17],
    ['9758MiB/s', '9756', 10232.004608, 9756],
    ['12.9GiB/s', '13.2k', 13851.2695296, 13200],
];
foreach ($cases as [$bandwidth, $iops, $expectedBandwidth, $expectedIops]) {
    $profile = new pts_test_profile('fio-2.1.0', null, false);
    $result = new pts_test_result($profile);
    $log = tempnam(sys_get_temp_dir(), 'fio-parser-');
    try {
        file_put_contents($log, "  read: IOPS=$iops, BW=$bandwidth (10.2GB/s)(572GiB/60004msec)\n   READ: bw=$bandwidth (10.2GB/s), io=572GiB (614GB), run=60004-60004msec\n");
        pts_test_result_parser::parse_result($result, $log);
        $actual = [];
        foreach ($result->generated_result_buffers as $entry) {
            $actual[$entry->test_profile->get_result_scale()] = $entry->active->results;
        }
        foreach (['MB/s' => $expectedBandwidth, 'IOPS' => $expectedIops] as $scale => $expected) {
            if (!isset($actual[$scale]) || count($actual[$scale]) !== 1 || abs($actual[$scale][0] - $expected) > 0.000001) {
                throw new RuntimeException("$bandwidth: incorrect $scale samples: " . json_encode($actual));
            }
        }
    } finally {
        unlink($log);
    }
}
echo "PTS fio parser: KiB/s, MiB/s, GiB/s and IOPS passed\n";

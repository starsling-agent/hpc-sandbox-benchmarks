<?php
// Narrow repair for PTS 10.8.4: equal values from distinct metric identities are not duplicates.
// Usage: php result-parser.php /path/to/pts_test_result_parser.php
$path = $argv[1] ?? '';
$source = @file_get_contents($path);
if ($source === false) {
    throw new RuntimeException('Cannot read the pinned PTS result parser');
}
$originalHash = '12705541b1876fda4790210997b39265994e4991d18dbd13cbfe830d8b0bea92';
$before = [
    'if(in_array($test_result, $avoid_duplicates))',
    '$avoid_duplicates[] = $test_result;',
];
$after = [
    'if(in_array($test_result, $avoid_duplicates[$tr->get_comparison_hash(true, false)] ?? array()))',
    '$avoid_duplicates[$tr->get_comparison_hash(true, false)][] = $test_result;',
];
// Accept only the original pinned bytes or exactly this repair; never patch an unknown version.
$restored = str_replace($after, $before, $source, $restoredCount);
if ($restoredCount === 2 && hash('sha256', $restored) === $originalHash) {
    exit(0);
}
if (hash('sha256', $source) !== $originalHash) {
    throw new RuntimeException('Unsupported PTS result parser revision');
}
$patched = str_replace($before, $after, $source, $count);
if ($count !== 2) {
    throw new RuntimeException('PTS result parser repair did not match');
}
$temporary = tempnam(dirname($path), '.pts-parser-');
try {
    if ($temporary === false || file_put_contents($temporary, $patched) !== strlen($patched)
        || !chmod($temporary, fileperms($path) & 0777) || !rename($temporary, $path)) {
        throw new RuntimeException('Could not persist PTS result parser repair');
    }
} finally {
    if ($temporary !== false && is_file($temporary)) {
        unlink($temporary);
    }
}

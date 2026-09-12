# PTS result identity repair

PTS 10.8.4 deduplicates results by numeric value across all parser blocks. Two different metrics
with equal numbers therefore lose one observation. The repair keys that existing deduplication by
PTS's own comparison hash, which already identifies each result buffer. Equal values within one
metric remain deduplicated; equal values across different metrics survive unchanged.

The PHP patcher accepts only the exact upstream 10.8.4 parser or its own repaired bytes. Unknown
revisions fail before measurement. Replacement is atomic and preserves file permissions. The
benchmark invokes it against the supported packaged PTS installation before each PTS measurement;
repeated calls are harmless. This does not reconstruct lost historical data.

To verify offline, copy a PTS 10.8.4 source tree, apply the repair, then run the real parser regression:

```sh
php lib/pts/patches/result-parser.php /path/to/pts/pts-core/objects/pts_test_result_parser.php
php lib/pts/fio/parser-selftest.php /path/to/pts
```

The equal-value fixture must retain both 1 MB/s and 1 IOPS. The unmodified parser drops IOPS.

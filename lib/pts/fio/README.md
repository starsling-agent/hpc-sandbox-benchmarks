# fio result parser repair

The pinned upstream fio profile drops bandwidth trials reported in GiB/s. Its older KiB/s and MiB/s
conversions also do not match the declared decimal MB/s scale. The vendored parser converts KiB/s,
MiB/s, and GiB/s to MB/s using 0.001024, 1.048576, and 1073.741824 respectively; IOPS stays unchanged.
The benchmark stages these definitions after installation, preserving the installed fio executable.

This is a prospective measurement revision, bound to the source revision in each new experiment.
It does not rewrite historical values or supply missing historical samples. Compare runs only within
matching workload revisions. The separate direct/buffered eligibility contract and PTS's cross-scale
numeric deduplication remain independent concerns.

Exercise the actual pinned PTS parser without running a benchmark:

```sh
php lib/pts/fio/parser-selftest.php /path/to/phoronix-test-suite-10.8.4
```

The self-test requires PHP with XML support and the PTS 10.8.4 source tree. It checks exact conversions
for all three bandwidth units and preserves numeric and abbreviated IOPS values. The ordinary Bun
suite also verifies that staging replaces stale definitions without deleting the installed executable.

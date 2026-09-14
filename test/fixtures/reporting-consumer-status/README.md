`canonical-rc3.json` is an unmodified protocol schema from AdCP main
`98fa207cb81c14b745f66a90d0b82cb6fad82f4b`, at
[`static/schemas/source/core/reporting-consumer-status.json`](https://github.com/adcontextprotocol/adcp/blob/98fa207cb81c14b745f66a90d0b82cb6fad82f4b/static/schemas/source/core/reporting-consumer-status.json).
It contains the `content_mismatch` contract inherited from AdCP #7465. The
schema in #7508's bundle at `c59427cde5025f273126cc639885f5ce85984df0` differs
only in `$id` (the rc.4 versioned URI).

This fixture exercises forward generation while the SDK retains its rc.2 pin.
It is protocol input, not a replacement for regenerating and qualifying the
whole SDK against the immutable candidate bundle.

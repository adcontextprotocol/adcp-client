"""Resolve the AdCP protocol the TypeScript seller actor must run.

Kept dependency-free and separate from the orchestrators so it can be exercised
directly: the orchestrators import psycopg and are not importable in a unit
test, and three verbatim copies of an identity gate can silently diverge.

The actors in the reporting-interop gate do NOT share one protocol:

  * TypeScript seller      - this SDK's own adcp_version (moves with adoption)
  * core Python buyer      - pins.adcp_schema_version (immutable wheel/harness)
  * managed / GCS buyers   - the evidence fixture's adcp_schema_version

Conflating the first two is what broke the gate when the SDK adopted 3.2.5:
the seller was told to claim the protocol an unrelated, immutable Python
artifact had been verified against.
"""

import json
from pathlib import Path


class ProtocolIdentityError(Exception):
    """Raised when the seller's protocol identity cannot be established."""


def typescript_protocol(package, script_path):
    """Return the seller protocol, or raise if checkout and install disagree.

    Requiring checkout == installed preserves the identity guarantee the old
    shared-pin assertion provided: a stale or substituted install still fails
    closed, it just fails against the correct reference.

    Presence is asserted before equality. Two absent values compare equal, so
    without this the gate would pass vacuously against no protocol at all.
    """
    checkout = json.loads((Path(script_path).parents[2] / "package.json").read_bytes()).get("adcp_version")
    installed = package.get("adcp_version")
    if not checkout:
        raise ProtocolIdentityError("checkout package.json is missing adcp_version")
    if not installed:
        raise ProtocolIdentityError("installed @adcp/sdk is missing adcp_version")
    if installed != checkout:
        raise ProtocolIdentityError(
            f"installed SDK adcp_version {installed} must equal checkout {checkout}"
        )
    return installed

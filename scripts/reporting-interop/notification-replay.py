"""A fresh installed-wheel verifier must reject a nonce claimed by its peer."""
import base64
import hashlib
import importlib
import json
from pathlib import Path
import sys

from psycopg_pool import ConnectionPool
from adcp.signing import PgReplayStore
from adcp.signing.errors import SignatureVerificationError
from adcp.signing.jwks import StaticJwksResolver
from adcp.signing.webhook_verifier import WebhookVerifyOptions, verify_webhook_signature


def main():
    settings = json.loads(sys.stdin.readline())
    capture = json.loads(Path(settings["capture"]).read_bytes())
    origin = Path(importlib.import_module("adcp.signing.pg.replay_store").__file__).resolve()
    if "site-packages" not in origin.parts:
        raise RuntimeError("installed verifier origin")
    with ConnectionPool(settings["conninfo"], min_size=1, max_size=2,
                        kwargs={"connect_timeout": 10, "options": "-c statement_timeout=15000"}) as pool:
        replay = PgReplayStore(pool=pool)
        options = WebhookVerifyOptions(jwks_resolver=StaticJwksResolver({"keys": [capture["public_key"]]}),
            sender_url="https://seller.example.test/adcp", replay_store=replay)
        try:
            verify_webhook_signature(method="POST", url=capture["target"], headers=capture["headers"],
                body=base64.b64decode(capture["body"], validate=True), options=options)
        except SignatureVerificationError as error:
            if error.code != "webhook_signature_replayed":
                raise RuntimeError("fresh verifier replay rejection") from None
        else:
            raise RuntimeError("fresh verifier accepted a captured signature")
        return {"status": "passed", "code": "webhook_signature_replayed",
                "live_nonce_count": replay.live_count(capture["public_key"]["kid"]),
                "installed_replay_store_sha256": hashlib.sha256(origin.read_bytes()).hexdigest()}


if __name__ == "__main__":
    try:
        print(json.dumps(main()))
    except Exception as error:
        print(json.dumps({"status": "failed", "error_type": type(error).__name__}), file=sys.stderr)
        sys.exit(1)

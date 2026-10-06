"""Actual TS signed deliveries, verified by the installed Python SDK.

The HTTP fixture routes a fixed HTTPS signing target to an owned loopback
receiver. It qualifies signed bytes, shared replay storage and PostgreSQL
process restart recovery. Activity mode also qualifies committed reporting
ledger/activity composition; public DNS, TLS and key discovery remain outside
this fixture.
"""
import base64
import contextlib
import hashlib
import importlib.metadata
import importlib.util
import json
import os
from pathlib import Path
import secrets
import signal
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import psycopg
from psycopg import sql
from psycopg.conninfo import conninfo_to_dict, make_conninfo
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from psycopg_pool import ConnectionPool
from adcp.signing import PgReplayStore
from adcp.signing.errors import SignatureVerificationError
from adcp.signing.jwks import StaticJwksResolver
from adcp.signing.webhook_verifier import WebhookVerifyOptions, verify_webhook_signature
from adcp.reporting.canonical_json import canonical_json_utf8_v1
from adcp.types.generated_poc.core.reporting_ledger_changed_webhook import ReportingLedgerChangedWebhook

here = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("owned_runtime", here / "managed.py")
owned = importlib.util.module_from_spec(spec)
spec.loader.exec_module(owned)


def run(installation, node, output, mode="standalone"):
    owned.require(mode in ("standalone", "activity"), "notification mode")
    output.mkdir()
    pins = json.loads((here / "pins.json").read_bytes())
    owned.require(importlib.metadata.version("adcp") == pins["python_version"], "installed Python version")
    key = Ed25519PrivateKey.generate()
    encode = lambda body: base64.urlsafe_b64encode(body).rstrip(b"=").decode()
    public = {"kty": "OKP", "crv": "Ed25519", "x": encode(key.public_key().public_bytes(
        serialization.Encoding.Raw, serialization.PublicFormat.Raw)), "kid": "reverse-notification-key",
        "alg": "ed25519", "use": "sig", "adcp_use": "request-signing", "key_ops": ["verify"]}
    private = {**public, "key_ops": ["sign"], "d": encode(key.private_bytes(
        serialization.Encoding.Raw, serialization.PrivateFormat.Raw, serialization.NoEncryption()))}
    signer = {"keyid": public["kid"], "alg": "ed25519", "privateKey": private}
    target = "https://buyer.example.test/reporting-events"
    resolver = StaticJwksResolver({"keys": [public]})
    options = WebhookVerifyOptions(jwks_resolver=resolver, sender_url="https://seller.example.test/adcp")
    attempts, failures = [], []
    expected_account = "reporting_core_lab" if mode == "activity" else "account-test"
    expected_revision = "revision-august-official" if mode == "activity" else "revision-test"

    def reject(body, headers, verify_options, url=target):
        try:
            verify_webhook_signature(method="POST", url=url, headers=headers, body=body, options=verify_options)
        except SignatureVerificationError as error:
            return error.code
        raise owned.GateError("invalid signature accepted")

    class Receiver(BaseHTTPRequestHandler):
        timeout = 5
        def log_message(self, *_args):
            pass

        def do_POST(self):
            try:
                self.connection.settimeout(5)
                owned.require(self.path == "/events", "receiver route")
                length = int(self.headers.get("Content-Length", "0"))
                owned.require(0 < length <= 65536, "receiver body bound")
                body = self.rfile.read(length)
                owned.require(len(body) == length, "complete receiver body")
                headers = dict(self.headers)
                owned.require(all(len(self.headers.get_all(name, [])) == 1 for name in
                                  ("Signature", "Signature-Input", "Content-Digest", "Content-Type")), "single signature headers")
                # Failures use fresh nonce stores so a replay rejection cannot
                # hide a digest or target-binding defect.
                fresh = lambda: WebhookVerifyOptions(jwks_resolver=resolver, sender_url=options.sender_url)
                tamper = reject(body + b" ", headers, fresh())
                forged_headers = {name: value for name, value in headers.items() if name.lower() != "content-digest"}
                forged_headers["Content-Digest"] = "sha-256=:" + base64.b64encode(
                    hashlib.sha256(body + b" ").digest()).decode() + ":"
                forged_digest = reject(body + b" ", forged_headers, fresh())
                wrong_target = reject(body, headers, fresh(), target + "/other")
                wrong_origin = reject(body, headers, fresh(), "https://other.example.test/reporting-events")
                fixture_route = reject(body, headers, fresh(), route)
                unknown_key = reject(body, headers, WebhookVerifyOptions(
                    jwks_resolver=StaticJwksResolver({"keys": []}), sender_url=options.sender_url))
                wrong_purpose = reject(body, headers, WebhookVerifyOptions(jwks_resolver=StaticJwksResolver(
                    {"keys": [{**public, "adcp_use": "encryption"}]}), sender_url=options.sender_url))
                verified = verify_webhook_signature(method="POST", url=target, headers=headers, body=body, options=options)
                owned.require(verified.key_id == public["kid"], "authenticated signing key")
                event = ReportingLedgerChangedWebhook.model_validate_json(body)
                owned.require(event.account_id == expected_account and event.reporting_revision_id == expected_revision
                              and event.subscriber_id == "python-buyer" and event.change_kind == "revision_published"
                              and event.finality == "official" and json.loads(body)["notification_type"] == "reporting.ledger_changed",
                              "recipient and event binding")
                replay = reject(body, headers, options)
                (output / f"capture-{len(attempts)}.json").write_text(json.dumps({
                    "target": target, "headers": headers, "body": base64.b64encode(body).decode(), "public_key": public,
                }))
                attempts.append({"body_sha256": hashlib.sha256(body).hexdigest(),
                                 "canonical_body_sha256": hashlib.sha256(canonical_json_utf8_v1(json.loads(body))).hexdigest(),
                                 "idempotency_key": event.idempotency_key, "notification_id": event.notification_id,
                                 "signature_input": self.headers["Signature-Input"],
                                 "tampered_body_code": tamper, "wrong_target_code": wrong_target,
                                 "forged_digest_code": forged_digest,
                                 "wrong_origin_code": wrong_origin, "fixture_route_code": fixture_route,
                                 "wrong_purpose_code": wrong_purpose, "unknown_key_code": unknown_key, "replay_code": replay})
                # First verified delivery gets a real transient response. The
                # second arrives after the sending process has exited.
                self.send_response(503 if len(attempts) == 1 else 204)
            except Exception as error:
                failures.append({"error_type": type(error).__name__, "code": getattr(error, "code", None),
                                 "stage": str(error) if isinstance(error, owned.GateError) else None,
                                 "validation": [{"loc": item["loc"], "type": item["type"]}
                                                for item in error.errors()] if hasattr(error, "errors") else None})
                self.send_response(400)
            self.end_headers()

    admin = os.environ["REPORTING_INTEROP_PG_URL"]
    database = "adcp_reverse_notification_" + secrets.token_hex(8)
    fields = conninfo_to_dict(admin)
    fields["dbname"] = database
    conninfo = make_conninfo(**fields)
    url = owned.node_database_url(fields)
    with contextlib.ExitStack() as owner:
        owner.callback(owned.scrub, output, (admin, url, conninfo, private["d"], fields.get("password", "")))
        owner.callback(owned.drop, admin, database)
        with psycopg.connect(admin, autocommit=True, connect_timeout=10) as connection:
            connection.execute(sql.SQL("CREATE DATABASE {} TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'").format(sql.Identifier(database)))
        replay_pool = owner.enter_context(ConnectionPool(conninfo, min_size=1, max_size=2,
            kwargs={"connect_timeout": 10, "options": "-c statement_timeout=15000"}))
        replay_store = PgReplayStore(pool=replay_pool)
        replay_store.create_schema()
        options = WebhookVerifyOptions(jwks_resolver=resolver, sender_url=options.sender_url, replay_store=replay_store)
        receiver = HTTPServer(("127.0.0.1", 0), Receiver)
        owner.callback(receiver.server_close)
        thread = threading.Thread(target=receiver.serve_forever, daemon=True)
        thread.start()
        owner.callback(thread.join, 10)
        owner.callback(receiver.shutdown)
        route = f"http://127.0.0.1:{receiver.server_port}/events"
        input_body = json.dumps({"signer": signer, "target": target, "route": route})
        destination = output / "destination"
        destination.mkdir()
        phases = []
        fresh_verifiers = []
        for phase in ("emit", "recover"):
            process = subprocess.run([str(node), str(here / "notification-seller.cjs"), str(installation), phase, mode],
                                     input=input_body, capture_output=True, text=True, timeout=60,
                                     env=owned.environment(DATABASE_URL=url, REPORTING_INTEROP_DESTINATION=str(destination)))
            (output / f"{phase}.stderr.log").write_text(process.stderr)
            (output / "receiver-failures.json").write_text(json.dumps(failures))
            owned.require(process.returncode == 0, "installed notification sender " + phase)
            phases.append(json.loads(process.stdout))
            owned.require(len(attempts) == len(phases) and not failures, "verified delivery count")
            peer = subprocess.run([sys.executable, "-I", str(here / "notification-replay.py")],
                input=json.dumps({"conninfo": conninfo, "capture": str(output / f"capture-{len(attempts)-1}.json")}),
                capture_output=True, text=True, timeout=90, env=owned.environment())
            (output / f"{phase}-peer.stderr.log").write_text(peer.stderr)
            owned.require(peer.returncode == 0, "fresh verifier rejects durable nonce replay")
            fresh_verifiers.append(json.loads(peer.stdout))
            owned.require(fresh_verifiers[-1]["status"] == "passed" and
                          fresh_verifiers[-1]["live_nonce_count"] == len(attempts), "shared nonce persistence")
        owned.require(phases[0]["generation"] == phases[1]["generation"], "persisted subscription")
        first, second = attempts
        (output / "attempts.json").write_text(json.dumps(attempts, indent=2))
        for name in ("canonical_body_sha256", "idempotency_key", "notification_id"):
            owned.require(first[name] == second[name], "stable retry " + name)
        owned.require(first["signature_input"] != second["signature_input"], "fresh retry signature")
        for attempt in attempts:
            owned.require(attempt["tampered_body_code"] == "webhook_signature_digest_mismatch", "tamper rejection")
            owned.require(attempt["forged_digest_code"] == "webhook_signature_invalid", "signed digest rejection")
            owned.require(attempt["wrong_target_code"] == "webhook_signature_invalid", "target rejection")
            owned.require(attempt["wrong_origin_code"] == "webhook_signature_invalid", "origin rejection")
            owned.require(attempt["fixture_route_code"] == "webhook_signature_invalid", "fixture route rejection")
            owned.require(attempt["wrong_purpose_code"] == "webhook_signature_key_purpose_invalid", "key purpose rejection")
            owned.require(attempt["unknown_key_code"] == "webhook_signature_key_unknown", "key rejection")
            owned.require(attempt["replay_code"] == "webhook_signature_replayed", "replay rejection")
        with psycopg.connect(conninfo, connect_timeout=10) as connection:
            pg_version = connection.execute("SHOW server_version").fetchone()[0]
        return {"status": "passed", "python_version": importlib.metadata.version("adcp"),
                "postgres_version": pg_version, "process_restart": True,
                "transport": "owned loopback route for fixed HTTPS signature target",
                "fixture_adapters": ["proof", "delivery_authorization", "destination_validation", "fetch_routing", "trusted_jwk"],
                "mode": mode, "reporting_activity_integration": mode == "activity",
                "attempts": attempts, "phases": phases, "shared_postgres_replay_store": True,
                "fresh_verifier_processes": fresh_verifiers}


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, owned.interrupted)
    try:
        print(json.dumps(run(*(Path(value).resolve() for value in sys.argv[1:4]),
                             sys.argv[4] if len(sys.argv) > 4 else "standalone")))
    except Exception as error:
        print(json.dumps({"status": "failed", "error_type": type(error).__name__,
                          "stage": str(error) if isinstance(error, owned.GateError) else None}), file=sys.stderr)
        sys.exit(1)

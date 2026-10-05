"""Installed TypeScript PostgreSQL producer -> installed Python MCP buyer.

The upstream fixture uses public SDK producer/store/handler/server exports.
Each invocation owns a fresh database, process, readiness proof and credentials.
"""

import contextlib
import hashlib
import json
import os
import secrets
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path

import psycopg
from psycopg import sql
from psycopg.conninfo import conninfo_to_dict, make_conninfo
from urllib.parse import urlencode, quote


class GateError(ValueError):
    """A static harness stage label, safe to retain in aggregate diagnostics."""


def require(condition, label):
    if not condition:
        raise GateError(label)


def interrupted(_signal, _frame):
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    raise RuntimeError("Core gate interrupted")


def narrow_env(**private):
    keys = ("PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "SSL_CERT_FILE", "SSL_CERT_DIR")
    return {**{k: os.environ[k] for k in keys if k in os.environ}, **private}


def stop(process):
    if process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=15)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=10)


def scrub(output, sensitive):
    for log in output.glob("core*"):
        if not log.is_file():
            continue
        body = log.read_text(errors="replace")
        for value in sensitive:
            if value:
                body = body.replace(value, "[redacted]")
        log.write_text(body)


def drop(admin, database):
    with psycopg.connect(admin, autocommit=True, connect_timeout=10) as connection:
        connection.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(database)))


def run(upstream, installation, node, output):
    harness = upstream / "scripts/ci/reporting_interop"
    lock_path = installation / "package-lock.json"
    package = json.loads((installation / "node_modules/@adcp/sdk/package.json").read_bytes())
    lock = json.loads(lock_path.read_bytes())["packages"]["node_modules/@adcp/sdk"]
    pins = json.loads(Path(__file__).with_name("pins.json").read_bytes())
    require(lock["version"] == package["version"], "installed version")
    database = f"adcp_reverse_{secrets.token_hex(8)}"
    admin = os.environ["REPORTING_INTEROP_PG_URL"]
    fields = conninfo_to_dict(admin)
    fields["dbname"] = database
    db_conninfo = make_conninfo(**fields)
    credentials = quote(fields.get("user", ""), safe="")
    if "password" in fields:
        credentials += ":" + quote(fields["password"], safe="")
    url = (f"postgresql://{credentials + '@' if credentials else ''}{fields.get('host', '127.0.0.1')}:"
           f"{fields.get('port', '5432')}/{database}?" +
           urlencode({k: v for k, v in fields.items() if k not in ("host", "port", "user", "password", "dbname")}))
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    token_a, token_b, proof = (secrets.token_urlsafe(32) for _ in range(3))
    ready_file = output / "core.ready.json"
    # All independent cleanup callbacks run even if shutdown or scrubbing fails.
    with contextlib.ExitStack() as owner:
        sensitive = (token_a, token_b, proof, url, admin, db_conninfo, fields.get("password", ""))
        owner.callback(scrub, output, sensitive)
        with psycopg.connect(admin, autocommit=True, connect_timeout=10) as connection:
            connection.execute(sql.SQL("CREATE DATABASE {} TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'").format(sql.Identifier(database)))
        owner.callback(drop, admin, database)
        with (output / "core-seller.stdout.log").open("wb") as stdout, (output / "core-seller.stderr.log").open("wb") as stderr:
            process = subprocess.Popen([
                str(node), str(harness / "ts_core_server.cjs"), "--package-lock", str(lock_path),
                "--expected-version", package["version"], "--expected-integrity", lock["integrity"],
                "--adcp-version", pins["adcp_schema_version"], "--seller-role", "candidate",
                "--port", str(port), "--ready-file", str(ready_file),
            ], cwd=output, stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr,
                env=narrow_env(DATABASE_URL=url, ADCP_INTEROP_TS_CORE_AUTH_TOKEN_A=token_a,
                               ADCP_INTEROP_TS_CORE_AUTH_TOKEN_B=token_b, ADCP_INTEROP_TS_CORE_STARTUP_PROOF=proof))
            owner.callback(stop, process)
            deadline = time.monotonic() + 60
            while True:
                require(process.poll() is None, "seller exited before readiness")
                require(time.monotonic() < deadline, "seller readiness deadline")
                if ready_file.exists():
                    try:
                        ready = json.loads(ready_file.read_bytes())
                        break
                    except json.JSONDecodeError:
                        # The pinned writer creates then writes its owned file.
                        # Wait for that write to finish within the same deadline.
                        pass
                time.sleep(0.1)
            require(ready["pid"] == process.pid and ready["port"] == port, "owned seller process")
            require(ready["startup_proof_sha256"] == hashlib.sha256(proof.encode()).hexdigest(), "startup proof")
            require(ready["seller_package"]["integrity"] == lock["integrity"], "seller artifact")
            require(ready["seller_package"]["protocol"] == pins["adcp_schema_version"], "seller schema version")
            results = []
            for suffix, token in (("a", token_a), ("b", token_b)):
                account = f"interop-account-{suffix}"
                require(ready["auth_binding_sha256"][account] == hashlib.sha256(token.encode()).hexdigest(), "auth binding")
                command = [sys.executable, "-I", str(harness / "python_core_client.py"),
                           "--url", f"http://127.0.0.1:{port}/mcp", "--auth-env", "ADCP_INTEROP_BUYER_TOKEN",
                           "--account", account, "--adcp-version", pins["adcp_schema_version"]]
                client = subprocess.run(command, cwd=output, env=narrow_env(ADCP_INTEROP_BUYER_TOKEN=token),
                                        capture_output=True, text=True, timeout=90)
                (output / f"core-buyer-{suffix}.json").write_text(client.stdout)
                (output / f"core-buyer-{suffix}.stderr.log").write_text(client.stderr)
                require(client.returncode == 0, "Python buyer failed")
                result = json.loads(client.stdout)
                require(result["definitive"] is True and result["typed_status"] == "completed", "Core reconciliation")
                require(result["package"]["version"] == pins["python_version"], "Python artifact version")
                require(len(result["obligations"]) == 1 and result["obligations"][0]["definitive"] is True, "obligation scope")
                results.append({"account": account, "result": result})
            with psycopg.connect(db_conninfo, connect_timeout=10) as connection:
                version = connection.execute("SHOW server_version").fetchone()[0]
            return {"status": "passed", "database": database, "postgres_version": version, "accounts": results}


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, interrupted)
    try:
        print(json.dumps(run(*(Path(value).resolve() for value in sys.argv[1:]))))
    except Exception as error:
        print(json.dumps({"status": "failed", "error_type": type(error).__name__,
                          "stage": str(error) if isinstance(error, GateError) else None}), file=sys.stderr)
        sys.exit(1)

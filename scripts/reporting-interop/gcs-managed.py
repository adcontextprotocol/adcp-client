"""Own a PostgreSQL seller and an installed Python Managed/Billing buyer."""

import contextlib
import hashlib
import html
import json
import os
import secrets
import signal
import socket
import subprocess
import sys
import time
import importlib.metadata
import zipfile
import tarfile
import base64
import re
from pathlib import Path
from urllib.parse import quote, urlencode

import psycopg
from psycopg import sql
from psycopg.conninfo import conninfo_to_dict, make_conninfo


class GateError(ValueError):
    """A static harness stage label, safe to retain in aggregate diagnostics."""


def require(condition, label):
    if not condition:
        raise GateError(label)


def environment(**private):
    keys = ("PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "SSL_CERT_FILE", "SSL_CERT_DIR")
    return {**{key: os.environ[key] for key in keys if key in os.environ}, **private}


def stop(process):
    # Descendants can survive after the leader exits. Own and signal the group,
    # independently of the leader's return code, then reap the leader.
    try: os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        # The owned process group may already have exited.
        pass
    try: process.wait(timeout=15)
    except subprocess.TimeoutExpired:
        # Escalate to SIGKILL below after the graceful shutdown deadline.
        pass
    finally:
        try: os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            # The group can exit between the TERM and KILL signals.
            pass
        process.wait(timeout=10)


def execute(argv, **kwargs):
    # A timed-out helper may have spawned children. Always terminate its owned
    # process group, even after the parent returns successfully.
    timeout = kwargs.pop("timeout")
    process = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, start_new_session=True, **kwargs)
    try:
        stdout, stderr = process.communicate(timeout=timeout)
        return subprocess.CompletedProcess(argv, process.returncode, stdout, stderr)
    finally:
        stop(process)


def scrub(output, private):
    # Preserve exact evidence bytes unless a private value actually occurs.
    values = {variant.encode() for value in private if value for variant in
              (value, quote(value, safe=""), json.dumps(value)[1:-1], repr(value)[1:-1], html.escape(value, quote=True))}
    for file in output.rglob("*"):
        if file.is_file():
            body = file.read_bytes()
            clean = body
            for value in sorted(values, key=len, reverse=True):
                clean = clean.replace(value, b"[redacted]")
            if clean != body:
                file.write_bytes(clean)


def credential_literals(value):
    found = []
    if isinstance(value, dict):
        for key, item in value.items():
            if key in ("token", "refresh_token", "client_secret", "private_key") and isinstance(item, str):
                found.append(item)
            else: found.extend(credential_literals(item))
    elif isinstance(value, list):
        for item in value: found.extend(credential_literals(item))
    return found


def scrub_private_credentials(output, captured, credential_files, other):
    # Finish redaction before delivering a second termination signal.
    previous = signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGTERM, signal.SIGINT})
    try:
        for filename in credential_files:
            try: captured.extend(credential_literals(json.loads(Path(filename).read_bytes())))
            except (OSError, ValueError):
                # Startup literals and bearer patterns still scrub logs when
                # a credential file is unavailable or being rotated.
                pass
        scrub(output, (*other, *captured))
        for file in output.rglob("*"):
            if file.is_file():
                body = file.read_bytes()
                body = re.sub(rb"ya29\.[A-Za-z0-9._-]+", b"[redacted]", body)
                body = re.sub(rb"(?i)Bearer[ \t]+[^\s\"'<>]+", b"Bearer [redacted]", body)
                file.write_bytes(body)
    finally:
        signal.pthread_sigmask(signal.SIG_SETMASK, previous)


def drop(admin, database):
    with psycopg.connect(admin, autocommit=True, connect_timeout=10) as connection:
        connection.execute("SET statement_timeout = '15s'")
        connection.execute(sql.SQL("DROP DATABASE IF EXISTS {} WITH (FORCE)").format(sql.Identifier(database)))


def node_database_url(fields):
    # The gate uses an explicit TCP PostgreSQL endpoint, shared by both SDKs.
    host = fields.get("host", "")
    require(bool(host) and not host.startswith("/") and "," not in host and "hostaddr" not in fields,
            "explicit single TCP PostgreSQL host required")
    authority = f"[{host}]" if ":" in host else host
    credentials = quote(fields.get("user", ""), safe="")
    if "password" in fields:
        credentials += ":" + quote(fields["password"], safe="")
    return (f"postgresql://{credentials + '@' if credentials else ''}{authority}:{fields.get('port', '5432')}/"
            f"{quote(fields['dbname'], safe='')}?" + urlencode({key: value for key, value in fields.items()
                 if key not in ("host", "port", "user", "password", "dbname")}))


def run(upstream, installation, node, output, mode, gcs_input, wheel, grant_hook):
    require(mode in ("managed", "billing"), "mode")
    here = Path(__file__).resolve().parent
    supplement = here
    output.mkdir()
    destination = output / "destination"
    destination.mkdir()
    lock_path = installation / "package-lock.json"
    package = json.loads((installation / "node_modules/@adcp/sdk/package.json").read_bytes())
    lock = json.loads(lock_path.read_bytes())["packages"]["node_modules/@adcp/sdk"]
    pins = json.loads((here / "pins.json").read_bytes())
    require(lock["version"] == package["version"], "installed artifact")
    require(gcs_input.stat().st_mode & 0o777 == 0o600, "private GCS input mode")
    gcs = json.loads(gcs_input.read_bytes())
    archive = Path(gcs["typescript_archive_path"])
    require("sha512-" + base64.b64encode(hashlib.sha512(archive.read_bytes()).digest()).decode() == lock["integrity"], "candidate archive integrity")
    with tarfile.open(archive, "r:gz") as candidate:
        members = set()
        for member in candidate.getmembers():
            if member.isfile():
                require(member.name.startswith("package/") and ".." not in member.name.split("/"), "candidate package path")
                members.add(member.name.removeprefix("package/"))
                require((installation / "node_modules/@adcp/sdk" / member.name.removeprefix("package/")).read_bytes() == candidate.extractfile(member).read(), "installed seller matches archive")
    installed_members = {str(file.relative_to(installation / "node_modules/@adcp/sdk")) for file in (installation / "node_modules/@adcp/sdk").rglob("*") if file.is_file()}
    require(installed_members == members, "complete installed seller inventory")
    require(hashlib.sha256(wheel.read_bytes()).hexdigest() == pins["python_wheel_sha256"], "published wheel pin")
    require(importlib.metadata.version("adcp") == pins["python_version"], "installed Python version")
    distribution = importlib.metadata.distribution("adcp")
    with zipfile.ZipFile(wheel) as published:
        members = {name for name in published.namelist() if name.startswith("adcp/") and not name.endswith("/")}
        require(bool(members), "published Python SDK members")
        for name in members:
            require(not any(part in ("", ".", "..") for part in name.split("/")), "wheel member path")
            require(distribution.locate_file(name).read_bytes() == published.read(name), "installed SDK matches published wheel")
        installed = {"adcp/" + str(file.relative_to(distribution.locate_file("adcp"))) for file in distribution.locate_file("adcp").rglob("*") if file.is_file() and "__pycache__" not in file.parts}
        require(installed == members, "complete installed Python file coverage")
    import adcp
    require(Path(adcp.__file__).resolve() == distribution.locate_file("adcp/__init__.py").resolve(), "imported installed Python SDK")
    identity = subprocess.run(["git", "--no-replace-objects", "rev-parse", "HEAD"], cwd=upstream, env=environment(), capture_output=True, text=True, timeout=30, check=True)
    require(identity.stdout.strip() == pins["python_harness_commit"], "pinned official MCP harness")
    clean = subprocess.run(["git", "--no-replace-objects", "-c", "core.fsmonitor=false", "status", "--porcelain", "--untracked-files=no"], cwd=upstream, env=environment(), capture_output=True, text=True, timeout=30, check=True)
    require(not clean.stdout, "unmodified MCP harness")
    for source in (upstream / "scripts/ci/reporting_interop").glob("*.cjs"):
        pinned = subprocess.check_output(["git", "--no-replace-objects", "show", "HEAD:" + str(source.relative_to(upstream))], cwd=upstream, env=environment(), timeout=30)
        require(source.read_bytes() == pinned, "exact pinned wrapper bytes")

    grant_hook_digest = hashlib.sha256(grant_hook.read_bytes()).hexdigest()
    private_input_bytes = gcs_input.read_bytes()
    admin = os.environ["REPORTING_INTEROP_PG_URL"]
    fields = conninfo_to_dict(admin)
    database = f"adcp_reverse_{mode}_{secrets.token_hex(8)}"
    fields["dbname"] = database
    conninfo = make_conninfo(**fields)
    url = node_database_url(fields)
    token, proof = (secrets.token_urlsafe(32) for _ in range(2))
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    ready_file = output / "ready.json"
    # ExitStack runs every cleanup even if process shutdown or log scrubbing
    # fails. The only database it can drop is this invocation's random name.
    with contextlib.ExitStack() as owner:
        credential_values = []
        for filename in (gcs["reader_token_path"], gcs["adc_path"]):
            require(Path(filename).stat().st_mode & 0o777 == 0o600, "private credential file mode")
            values = json.loads(Path(filename).read_bytes())
            credential_values.extend(credential_literals(values))
        owner.callback(scrub_private_credentials, output, credential_values, (gcs["reader_token_path"], gcs["adc_path"]), (token, proof, url, conninfo, admin, fields.get("password", "")))
        owner.callback(drop, admin, database)
        with psycopg.connect(admin, autocommit=True, connect_timeout=10) as connection:
            connection.execute(sql.SQL("CREATE DATABASE {} TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'").format(sql.Identifier(database)))
        stdout = owner.enter_context((output / "seller.stdout.log").open("wb"))
        stderr = owner.enter_context((output / "seller.stderr.log").open("wb"))
        process = subprocess.Popen([
            str(node), str(supplement / "gcs-managed-seller.cjs"), "--upstream", str(upstream), "--mode", mode,
            "--package-lock", str(lock_path), "--expected-version", package["version"],
            "--expected-integrity", lock["integrity"], "--adcp-version", pins["adcp_schema_version"],
            "--port", str(port), "--ready-file", str(ready_file),
        ], cwd=output, stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr,
            env=environment(DATABASE_URL=url, REPORTING_INTEROP_DESTINATION=str(destination),
                            ADCP_INTEROP_TS_STORYBOARD_AUTH_TOKEN=token,
                            ADCP_INTEROP_TS_STORYBOARD_STARTUP_PROOF=proof, REPORTING_INTEROP_GCS_INPUT=str(gcs_input)), start_new_session=True)
        owner.callback(stop, process)
        deadline = time.monotonic() + 60
        while True:
            require(process.poll() is None, "seller exited before readiness")
            require(time.monotonic() < deadline, "readiness deadline")
            if ready_file.exists():
                try:
                    ready = json.loads(ready_file.read_bytes())
                    break
                except json.JSONDecodeError:
                    # Retry a partially written readiness file until the deadline.
                    pass
            time.sleep(0.1)
        require(Path(ready["node"]["executable"]).resolve() == node.resolve(), "owned Node executable")
        require(ready["pid"] == process.pid and ready["port"] == port and ready["mode"] == mode, "owned process")
        require(ready["startup_proof_sha256"] == hashlib.sha256(proof.encode()).hexdigest(), "startup proof")
        require(ready["auth_binding_sha256"] == hashlib.sha256(token.encode()).hexdigest(), "authentication binding")
        require(ready["seller_package"]["integrity"] == lock["integrity"] and
                ready["seller_package"]["adcp_version"] == pins["adcp_schema_version"], "artifact identity")
        preflight = execute([sys.executable, '-I', str(supplement / 'gcs-managed-preflight.py')], env=environment(GCS_PREFLIGHT_URL=f'http://127.0.0.1:{port}/mcp', GCS_PREFLIGHT_MODE=mode, GCS_PREFLIGHT_VERSION=pins['adcp_schema_version'], ADCP_INTEROP_BUYER_TOKEN=token), text=True,timeout=180)
        require(preflight.returncode == 0, 'official MCP preflight')
        grant = execute([sys.executable, '-I', str(grant_hook), str(destination / 'gcs-grant.json')], env=environment(), text=True,timeout=180)
        require(grant.returncode == 0, 'scoped GCS grant readiness')
        require(json.loads(grant.stdout)['status'] == 'passed', 'grant hook result')
        (output / 'grant-readiness.json').write_text(grant.stdout)
        require(gcs_input.read_bytes() == private_input_bytes, "unchanged private GCS configuration")
        require(hashlib.sha256(grant_hook.read_bytes()).hexdigest() == grant_hook_digest, "unchanged grant hook")
        client = execute([
            sys.executable, "-I", str(supplement / "gcs-managed-buyer.py"), f"http://127.0.0.1:{port}/mcp",
            str(destination), str(here.parents[1] / "test/fixtures/reporting-interop"), mode,
        ], cwd=output, env=environment(ADCP_INTEROP_BUYER_TOKEN=token, REPORTING_INTEROP_GCS_READER_TOKEN=gcs["reader_token_path"], REPORTING_INTEROP_GCS_PROJECT=gcs["project_id"]),
            text=True, timeout=180)
        (output / "buyer.json").write_text(client.stdout)
        (output / "buyer.stderr.log").write_text(client.stderr)
        require(client.returncode == 0, "installed buyer failed")
        result = json.loads(client.stdout)
        require(result["status"] == "passed" and result["python_version"] == pins["python_version"], "buyer result")
        with psycopg.connect(conninfo, connect_timeout=10) as connection:
            pg_version = connection.execute("SHOW server_version").fetchone()[0]
        return {"status": "passed", "mode": mode, "postgres_version": pg_version,
                "seller_version": package["version"], "seller_integrity": lock["integrity"],
                "node_version": ready["node"]["version"],
                "storage_peer_version": json.loads((installation / "node_modules/@google-cloud/storage/package.json").read_bytes())["version"],
                "python_dependencies": {name: importlib.metadata.version(name) for name in ("adcp", "mcp", "google-cloud-storage", "google-auth", "psycopg", "pydantic")},
                "typescript_archive_sha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
                "typescript_lock_sha256": hashlib.sha256(lock_path.read_bytes()).hexdigest(),
                "grant_hook_sha256": grant_hook_digest,
                "fixture_sha256": {name: hashlib.sha256((here.parents[1] / "test/fixtures/reporting-interop" / name).read_bytes()).hexdigest() for name in ("evidence-v1.json", "resources/rows.jsonl")},
                "python_wheel_sha256": pins["python_wheel_sha256"], "python_harness_commit": pins["python_harness_commit"],
                "source_file_sha256": {name: hashlib.sha256((here / name).read_bytes()).hexdigest() for name in
                    ("gcs-managed.py", "gcs-managed-buyer.py", "gcs-managed-preflight.py", "gcs-managed-seller.cjs", "managed-seller.cjs", "pins.json")},
                "buyer": result}


def interrupted(_signal, _frame):
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    raise RuntimeError("Managed reporting gate interrupted")


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, interrupted)
    try:
        print(json.dumps(run(*(Path(value).resolve() for value in sys.argv[1:5]), sys.argv[5], *(Path(value).resolve() for value in sys.argv[6:9]))))
    except Exception as error:
        print(json.dumps({"status": "failed", "error_type": type(error).__name__,
                          "stage": str(error) if isinstance(error, GateError) else None}), file=sys.stderr)
        sys.exit(1)

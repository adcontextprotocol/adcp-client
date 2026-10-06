"""Bind installed SDK members to the supplied immutable package artifacts."""

import hashlib
import json
import sys
import tarfile
import zipfile
from importlib.metadata import distribution, distributions
from pathlib import Path


def digest(body):
    return hashlib.sha256(body).hexdigest()


def verify(package_root, archive, wheel):
    installed_root = package_root / "node_modules/@adcp/sdk"
    if installed_root.is_symlink():
        raise ValueError("TypeScript SDK must be installed from an archive")
    with tarfile.open(archive, "r:gz") as stream:
        expected = {}
        for member in stream.getmembers():
            if member.isdir():
                continue
            if not member.isfile() or not member.name.startswith("package/"):
                raise ValueError("unsupported archive member")
            name = member.name.removeprefix("package/")
            if not name or ".." in Path(name).parts or name.startswith("/") or name in expected:
                raise ValueError("unsafe or duplicate archive member")
            expected[name] = digest(stream.extractfile(member).read())
    installed = {p.relative_to(installed_root).as_posix(): digest(p.read_bytes())
                 for p in installed_root.rglob("*") if p.is_file()}
    if not expected or expected != installed:
        raise ValueError("installed TypeScript SDK differs from archive")
    dist = distribution("adcp")
    direct = json.loads(dist.read_text("direct_url.json") or "{}")
    if direct.get("url") != wheel.as_uri():
        raise ValueError("Python SDK was not installed from supplied wheel")
    with zipfile.ZipFile(wheel) as stream:
        names = [name for name in stream.namelist() if name.startswith("adcp/") and not name.endswith("/")]
        if len(set(names)) != len(names):
            raise ValueError("duplicate wheel member")
        expected_py = {name: digest(stream.read(name)) for name in names}
    installed_py = {p.as_posix(): digest(dist.locate_file(p).read_bytes()) for p in dist.files or []
                    if p.as_posix().startswith("adcp/") and not p.as_posix().endswith(".pyc")}
    if not expected_py or expected_py != installed_py:
        raise ValueError("installed Python SDK differs from wheel")
    def manifest_hash(members):
        return digest(json.dumps(members, sort_keys=True, separators=(",", ":")).encode())
    return {
        "typescript_members": len(expected), "python_members": len(expected_py),
        "typescript_member_manifest_sha256": manifest_hash(expected),
        "python_member_manifest_sha256": manifest_hash(expected_py),
        "python_dependencies": sorted((dist.metadata["Name"], dist.version) for dist in distributions()),
    }


if __name__ == "__main__":
    print(json.dumps(verify(*(Path(value).resolve() for value in sys.argv[1:]))))

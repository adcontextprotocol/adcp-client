"""Bind installed SDK and storage package members to the supplied immutable package artifacts."""

import hashlib
import json
import sys
import tarfile
import zipfile
from importlib.metadata import distribution, distributions
from pathlib import Path


def digest(body):
    return hashlib.sha256(body).hexdigest()


def verify_package(package_root, archive, name):
    """Every file of the installed npm package must equal the supplied archive's, with nothing extra."""
    installed_root = package_root / "node_modules" / name
    if installed_root.is_symlink():
        raise ValueError(f"{name} must be installed from an archive")
    with tarfile.open(archive, "r:gz") as stream:
        expected = {}
        for member in stream.getmembers():
            if member.isdir():
                continue
            if not member.isfile() or not member.name.startswith("package/"):
                raise ValueError("unsupported archive member")
            member_name = member.name.removeprefix("package/")
            if not member_name or ".." in Path(member_name).parts or member_name.startswith("/") or member_name in expected:
                raise ValueError("unsafe or duplicate archive member")
            expected[member_name] = digest(stream.extractfile(member).read())
    installed = {p.relative_to(installed_root).as_posix(): digest(p.read_bytes())
                 for p in installed_root.rglob("*") if p.is_file()}
    if not expected or expected != installed:
        raise ValueError(f"installed {name} differs from archive")
    return expected


def verify(package_root, archive, storage_archive, wheel):
    expected = verify_package(package_root, archive, "@adcp/sdk")
    expected_storage = verify_package(package_root, storage_archive, "@adcp/reporting-storage")
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
        "typescript_storage_members": len(expected_storage),
        "typescript_member_manifest_sha256": manifest_hash(expected),
        "typescript_storage_member_manifest_sha256": manifest_hash(expected_storage),
        "python_member_manifest_sha256": manifest_hash(expected_py),
        "python_dependencies": sorted((dist.metadata["Name"], dist.version) for dist in distributions()),
    }


if __name__ == "__main__":
    print(json.dumps(verify(*(Path(value).resolve() for value in sys.argv[1:]))))

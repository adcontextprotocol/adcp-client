"""Export pinned test/harness blobs, excluding the upstream SDK source tree."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tarfile


def run(upstream, archive, destination, commit):
    subprocess.run(["git", "--no-replace-objects", "archive", "--format=tar", "--output=" + str(archive), commit, "scripts", "tests"],
                   cwd=upstream, check=True, capture_output=True, timeout=30)
    listing = subprocess.run(["git", "--no-replace-objects", "ls-tree", "-rz", commit, "--", "scripts", "tests"],
                             cwd=upstream, check=True, capture_output=True, timeout=30).stdout
    expected = {}
    for entry in listing.split(b"\0"):
        if not entry:
            continue
        metadata, name = entry.split(b"\t", 1)
        mode, kind, digest = metadata.decode().split()
        assert kind == "blob" and mode in ("100644", "100755"), "export requires ordinary tracked files"
        expected[name.decode()] = (mode, digest)
    destination.mkdir()
    seen = set()
    with tarfile.open(archive) as source:
        for member in source:
            name = Path(member.name)
            assert not name.is_absolute() and ".." not in name.parts, "export path"
            target = destination / name
            if member.isdir():
                target.mkdir(exist_ok=True, parents=True)
                continue
            assert member.isfile() and member.name in expected and member.name not in seen, "export member"
            body = source.extractfile(member).read()
            # Git blob identity detects local export-ignore/export-subst rules,
            # as well as omitted or changed files, before anything is executed.
            mode, digest = expected[member.name]
            actual = hashlib.sha1(b"blob " + str(len(body)).encode() + b"\0" + body).hexdigest()
            assert actual == digest, "export differs from pinned blob"
            target.parent.mkdir(exist_ok=True, parents=True)
            target.write_bytes(body)
            target.chmod(0o755 if mode == "100755" else 0o644)
            seen.add(member.name)
    assert seen == expected.keys(), "export omitted tracked files"
    return {"sha256": hashlib.sha256(archive.read_bytes()).hexdigest(), "members": len(seen),
            "scope": ["scripts", "tests"], "sdk_source_excluded": True, "git_blob_identities_verified": True}


if __name__ == "__main__":
    try:
        print(json.dumps(run(*(Path(value).resolve() for value in sys.argv[1:4]), sys.argv[4])))
    except Exception as error:
        print(json.dumps({"status": "failed", "error_type": type(error).__name__,
                          "stage": str(error) if isinstance(error, AssertionError) else None}), file=sys.stderr)
        sys.exit(1)

"""Fetch two attributed, checksum-pinned FLEURS recordings for local STT tests."""
import hashlib
import io
import json
import sys
import tarfile
import urllib.request
from pathlib import Path

if len(sys.argv) != 2:
    raise SystemExit("usage: python3 tests/fixtures/saaras-audio.py OUTPUT_DIRECTORY")

output = Path(sys.argv[1])
output.mkdir(mode=0o700, parents=True, exist_ok=True)
root = "https://huggingface.co/datasets/google/fleurs/resolve/main/data"
entries = [
    {
        "name": "english", "language": "en-IN", "file": "en_us.wav",
        "recording": "test/1003119935936341070.wav",
        "sha256": "33aca50159ec2e3cbcc894eb26faa916d6badb1b49fb75994973561540a7f012",
        "text": "However, due to the slow communication channels, styles in the West could lag behind by 25 to 30 years.",
        "expect": "communication|channels|lag behind",
    },
    {
        "name": "hindi", "language": "hi-IN", "file": "hi_in.wav",
        "recording": "test/10011266027513218401.wav",
        "sha256": "217f3abbd8e9cd3767d6e8b87d49fbf82421fc920a103de026b4586d7e644dc5",
        "text": "कुछ अणुओं में अस्थिर केंद्रक होता है जिसका मतलब यह है कि उनमें थोड़े या बिना किसी झटके से टूटने की प्रवृत्ति होती है",
        "expect": "अणु|अस्थिर|केंद्रक|प्रवृत्ति",
    },
]
# Both recordings are the first file in their archives. Limit transfer and
# allocation even when the host ignores HTTP Range. Never extract paths.
for entry in entries:
    destination = output / entry["file"]
    matches = lambda data: hashlib.sha256(data).hexdigest() == entry["sha256"]
    if destination.is_file() and matches(destination.read_bytes()):
        continue
    request = urllib.request.Request(
        f"{root}/{destination.stem}/audio/test.tar.gz",
        headers={"Range": "bytes=0-4194303"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        prefix = response.read(4 * 1024 * 1024)
    with tarfile.open(fileobj=io.BytesIO(prefix), mode="r|gz") as archive:
        first = next(member for member in archive if member.isfile())
        if first.name != entry["recording"] or first.size > 1024 * 1024:
            raise ValueError("FLEURS archive no longer begins with the expected recording")
        audio = archive.extractfile(first).read()
    if not matches(audio):
        raise ValueError("FLEURS recording checksum did not match")
    destination.write_bytes(audio)

(output / "references.json").write_text(json.dumps(entries, ensure_ascii=False, indent=2) + "\n", encoding="utf8")
print("Verified two FLEURS test recordings in", output)

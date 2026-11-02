#!/usr/bin/env python3
"""Build four reviewable portable archives. Never publishes, tags, pushes or copies checkout art."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import struct
import subprocess
import tarfile
import zipfile

RELEASE = "v0.3.3-20p.1"
NODE_VERSION = "22.23.3"
UPSTREAM_FILE = "Stronghold-Protocol-v0.3.3.zip"
UPSTREAM_SHA = "1bfc651096ff4c44b76296717bd605220b5204714722832140a3d407153cd2be"
UPSTREAM_URL = "https://github.com/sganggs/Stronghold-Protocol/releases/download/v0.3.3/" + UPSTREAM_FILE
UPSTREAM_INDEXES = {"data/assets.json", "data/local-assets.json", "data/local-fx.json"}
NODES = {
    "Windows-x64": ("win-x64.zip", "2b0ff57b049cda1bbcea2240eec20467018713c1efe1f7360c2681859b90ed71"),
    "linux-x64": ("linux-x64.tar.xz", "df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de"),
    "darwin-arm64": ("darwin-arm64.tar.gz", "23b25245dcfb9af7262f8ff142e9e2e0af025368117329e7a7458a51e5922f53"),
    "darwin-x64": ("darwin-x64.tar.gz", "8a677b0219178efd6eb0e475457c4afb452b521a92f6e67845a73bd85727f2a8"),
}


def sha_file(p):
    with Path(p).open("rb") as f:
        return hashlib.file_digest(f, "sha256").hexdigest()


def checked_input(p, sha):
    if not p.is_file() or sha_file(p) != sha:
        raise ValueError(f"input missing or SHA-256 mismatch: {p.name}")
    return p


def safe_rel(name):
    if not name or "\\" in name or ":" in name or "\x00" in name:
        raise ValueError(f"unsafe archive path: {name!r}")
    p = PurePosixPath(name)
    if p.is_absolute() or any(x in ("", ".", "..") for x in name.split("/")):
        raise ValueError(f"unsafe archive path: {name!r}")
    if any(x.endswith((" ", ".")) for x in p.parts):
        raise ValueError(f"ambiguous archive path: {name!r}")
    return p.as_posix()


def art_path(rel):
    return rel.startswith(("public/assets/", "public/fonts/")) or rel in UPSTREAM_INDEXES


def denied(rel, upstream=False):
    p = safe_rel(rel)
    parts = p.lower().split("/")
    base = parts[-1]
    return (any(x in {".git", ".cache", "__pycache__", "runtime", "handoff", "review", "logs"} for x in parts)
            or any(x.startswith(".venv") for x in parts) or base == ".env" or base.startswith(".env.")
            or p.lower().startswith(("docs/development/", "public/dev/"))
            or ((p == "data/assets.json" or p.lower().startswith("public/assets/local/") or bool(re.match(r"^data/local[^/]*\.json$", p, re.I)))
                and not (upstream and art_path(p)))
            or base in {"thumbs.db", ".ds_store"} or bool(re.search(r"\.(pyc|pyo|log|tmp)$", base)))


def upstream_art(name):
    name = safe_rel(name)
    prefix = "Stronghold-Protocol/"
    if not name.startswith(prefix):
        return None
    rel = name[len(prefix):]
    return rel if art_path(rel) and not denied(rel, upstream=True) else None


def put(dst, data):
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_bytes(data)


def json_write(p, obj):
    put(p, (json.dumps(obj, ensure_ascii=False, indent=2) + "\n").encode())


def root_doc(text):
    """A copy of app-root Markdown at bundle root must retain working local links."""
    return re.sub(r"\]\(([^)\s]+)\)", lambda m: m.group(0) if re.match(r"^[a-z]+:|^#", m[1], re.I)
                  else "](app/" + m[1] + ")", text)


def server_announcement(notes, changelog):
    """Keep the complete two upstream change sections, then append this fork's changes."""
    blocks = re.split(r"(?m)(?=^## )", changelog)
    upstream = []
    for version in ("0.3.3", "0.3.2"):
        matches = [b for b in blocks if re.match(r"## " + re.escape(version) + r"(?:\s|$)", b)]
        if len(matches) != 1:
            raise ValueError(f"missing/ambiguous upstream changelog: {version}")
        upstream.append(matches[0].rstrip())
    fork = notes.split("### 本分支新增与修复\n", 1)[1].split("以上概括自上游", 1)[0].rstrip()
    body = (f"# {RELEASE} 完整更新公告\n\n"
            "以下完整保留上游 0.3.3、0.3.2 的更新记录与贡献者署名，本分支更新补充在末尾。\n"
            "上游原文中的默认设置、性能数据和四人测试结论属于上游，不能视为本分支二十人环境的测试结果；本分支保留既有容量与网络配置。\n\n"
            "来源：[上游 v0.3.3 原始更新日志](https://github.com/sganggs/Stronghold-Protocol/blob/v0.3.3/CHANGELOG.md)。\n\n"
            + "\n\n".join(upstream) + "\n\n## 本分支新增与修复\n\n" + fork
            + "\n\n服务器完成更新后，请刷新页面加载新版本；更新时间以服主通知为准。\n")
    if len(body.encode("utf-16-le")) // 2 > 50000 or len(body.encode("utf-8")) > 128 * 1024:
        raise ValueError("complete announcement exceeds the server's content limit")
    return body


def run(args, cwd=None, capture=False):
    return subprocess.run([str(x) for x in args], cwd=cwd, check=True,
                          stdout=subprocess.PIPE if capture else None).stdout


def files_under(root):
    for folder, dirs, names in os.walk(root, followlinks=False):
        for name in dirs + names:
            p = Path(folder) / name
            if p.is_symlink():
                raise ValueError(f"symlink refused: {p}")
        for name in sorted(names):
            yield Path(folder) / name


def extract_art(archive, app):
    entries = {}
    folded = set()
    with zipfile.ZipFile(archive) as z:
        for row in z.infolist():
            if row.is_dir():
                continue
            rel = upstream_art(row.filename)
            if rel is None:
                continue
            mode = row.external_attr >> 16
            if stat.S_IFMT(mode) not in (0, stat.S_IFREG) or rel.casefold() in folded:
                raise ValueError(f"non-regular/duplicate art: {row.filename}")
            folded.add(rel.casefold())
            data = z.read(row)  # ZIP CRC checked as well.
            put(app / rel, data)
            entries[rel] = {"size": len(data), "sha256": hashlib.sha256(data).hexdigest(),
                            "origin": row.filename}
    if not entries:
        raise ValueError("upstream archive contained no allowed art")
    return entries


def node_binary_check(data, target):
    if target == "Windows-x64":
        offset = struct.unpack_from("<I", data, 60)[0]
        okay = data[:2] == b"MZ" and data[offset:offset + 4] == b"PE\0\0" and struct.unpack_from("<H", data, offset + 4)[0] == 0x8664
    elif target == "linux-x64":
        okay = data[:6] == b"\x7fELF\x02\x01" and struct.unpack_from("<H", data, 18)[0] == 62
    else:
        cpu = 0x100000c if target == "darwin-arm64" else 0x1000007
        okay = data[:4] == b"\xcf\xfa\xed\xfe" and struct.unpack_from("<I", data, 4)[0] == cpu
    if not okay:
        raise ValueError(f"wrong Node executable architecture: {target}")


def extract_node(archive, bundle, target):
    suffix = NODES[target][0]
    prefix = f"node-v{NODE_VERSION}-{suffix.split('.')[0]}/"
    binary = "node.exe" if target == "Windows-x64" else "bin/node"
    names = {prefix + binary: bundle / "node" / binary, prefix + "LICENSE": bundle / "node/LICENSE-node.txt"}
    found = set()
    if archive.suffix == ".zip":
        with zipfile.ZipFile(archive) as z:
            for name, dst in names.items():
                entry = z.getinfo(name)
                if stat.S_IFMT(entry.external_attr >> 16) not in (0, stat.S_IFREG):
                    raise ValueError("non-regular Node file")
                data = z.read(entry)
                if name.endswith(binary):
                    node_binary_check(data, target)
                put(dst, data)
                found.add(name)
    else:
        with tarfile.open(archive) as t:
            for row in t:
                if row.name not in names:
                    continue
                if not row.isfile() or row.name in found:
                    raise ValueError("non-regular/duplicate Node file")
                data = t.extractfile(row).read()
                if row.name.endswith(binary):
                    node_binary_check(data, target)
                put(names[row.name], data)
                found.add(row.name)
    if found != set(names):
        raise ValueError("Node binary or license missing")
    (bundle / "node" / binary).chmod(0o755)


def link_copy(src, dst):
    try:
        os.link(src, dst)
    except OSError:
        shutil.copy2(src, dst)
    return dst


def launchers(bundle, target):
    if target == "Windows-x64":
        text = '@echo off\nchcp 65001 >nul\ncd /d "%~dp0app"\n"%~dp0node\\node.exe" scripts\\launch.mjs --no-setup %*\nif errorlevel 1 pause\n'
        put(bundle / "启动游戏.bat", text.replace("\n", "\r\n").encode())
    else:
        text = '#!/usr/bin/env bash\nset -e\nROOT="$(cd -- "$(dirname -- "$0")" && pwd)"\nexport PATH="$ROOT/node/bin:$PATH"\ncd "$ROOT/app"\nexec "$ROOT/node/bin/node" scripts/launch.mjs --no-setup "$@"\n'
        put(bundle / "启动游戏.sh", text.encode())
        (bundle / "启动游戏.sh").chmod(0o755)
        if target.startswith("darwin-"):
            put(bundle / "启动游戏.command", text.encode())
            (bundle / "启动游戏.command").chmod(0o755)
    guide = f"""# {RELEASE} · {target} 开箱即用包

解压整个文件夹后启动游戏脚本。自带 Node.js {NODE_VERSION}、生产依赖和上游基础素材，无需另装 Node 或运行 npm install。
Windows 双击 `启动游戏.bat`；Linux / macOS 在终端运行 `bash 启动游戏.sh`。macOS 也提供 `.command` 入口，系统可能要求确认来源。
自带运行时不代表支持所有旧系统；Node 平台要求见 https://github.com/nodejs/node/blob/v{NODE_VERSION}/BUILDING.md#platform-list 。
默认打开 http://localhost:3000 ，按 Ctrl+C 停止。端口等选项可追加 `--port 3001`，部署说明见 [app/docs/DEPLOY.md](app/docs/DEPLOY.md)。

素材与素材索引仅来自作者上游 v0.3.3 完整包，包括其自带的官方特效与场景；不带本分支新增的时装、模型或自提取内容，也不另发素材包。随机时装只使用当前安装已有的资源，缺项按原逻辑回退。
使用或再分发游戏素材可能涉及侵权，上游收录、非商业和署名不代表授权。自行提取也须遵守权利人的许可及适用条款。
请阅读 [更新说明](更新说明.md)、[权利声明](app/NOTICE.md) 和 [本地提取参考](app/docs/LOCAL_ASSET_EXTRACTION.md)。

手动运行提取文档中的 Node 命令前，可将包内 node 目录（Windows）或 node/bin（Linux / macOS）加入当前终端 PATH，再进入 app；Python 环境需自行准备。
`RELEASE.json` 记录源码及依赖来源，`PACKAGE-MANIFEST.json` 记录包内文件校验值。不应直接覆盖运行中的服务器；请等待正在进行及断线保留的对局结束。
"""
    put(bundle / "README-开箱即用.md", guide.encode())


def make_inventory(bundle, art):
    entries = {}
    for p in files_under(bundle):
        rel = p.relative_to(bundle).as_posix()
        if rel == "PACKAGE-MANIFEST.json":
            continue
        core = rel.removeprefix("app/")
        if denied(core, upstream=art_path(core)):
            raise ValueError(f"refused bundled path: {rel}")
        row = {"size": p.stat().st_size, "sha256": sha_file(p)}
        if art_path(core):
            original = art.get(core)
            if not original or any(row[k] != original[k] for k in ("size", "sha256")):
                raise ValueError(f"art outside verified upstream: {core}")
            row["upstreamEntry"] = original["origin"]
        entries[rel] = row
    if set(art) != {rel.removeprefix("app/") for rel in entries if rel.startswith("app/") and art_path(rel[4:])}:
        raise ValueError("bundled upstream art/index file set differs from provenance")
    json_write(bundle / "PACKAGE-MANIFEST.json", {"format": 1, "files": entries})
    manifest = bundle / "PACKAGE-MANIFEST.json"
    return {**entries, "PACKAGE-MANIFEST.json": {"size": manifest.stat().st_size, "sha256": sha_file(manifest)}}


def archive_bundle(bundle, archive):
    paths = sorted(files_under(bundle))
    if archive.suffix == ".zip":
        with zipfile.ZipFile(archive, "x", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
            for p in paths:
                z.write(p, bundle.name + "/" + p.relative_to(bundle).as_posix())
    else:
        with tarfile.open(archive, "x:gz", compresslevel=6) as t:
            for p in paths:
                name = bundle.name + "/" + p.relative_to(bundle).as_posix()
                row = t.gettarinfo(str(p), name)
                # Hard-linked staging files must become ordinary archive members.
                row.type = tarfile.REGTYPE
                row.linkname = ""
                row.size = p.stat().st_size
                rel = p.relative_to(bundle).as_posix()
                row.mode = 0o755 if rel in ("node/bin/node", "启动游戏.sh", "启动游戏.command") else 0o644
                row.uid = row.gid = 0
                row.uname = row.gname = ""
                with p.open("rb") as f:
                    t.addfile(row, f)


def verify_archive(archive, inventory):
    found = set()
    top = archive.name.removesuffix(".tar.gz").removesuffix(".zip")
    def check(name, stream):
        safe_rel(name)
        if not name.startswith(top + "/"):
            raise ValueError("unexpected archive root")
        rel = name.split("/", 1)[1]
        if rel in found:
            raise ValueError(f"duplicate archive member: {rel}")
        found.add(rel)
        digest = hashlib.sha256()
        size = 0
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
            size += len(block)
        if rel not in inventory or inventory[rel]["size"] != size or inventory[rel]["sha256"] != digest.hexdigest():
            raise ValueError(f"archive content mismatch: {rel}")
    if archive.suffix == ".zip":
        with zipfile.ZipFile(archive) as z:
            for row in z.infolist():
                with z.open(row) as f:
                    check(row.filename, f)
    else:
        with tarfile.open(archive, "r:gz") as t:
            for row in t:
                if not row.isfile():
                    raise ValueError(f"non-file archive member: {row.name}")
                with t.extractfile(row) as f:
                    check(row.name, f)
                rel = row.name.split("/", 1)[1]
                if rel in ("node/bin/node", "启动游戏.sh", "启动游戏.command") and row.mode != 0o755:
                    raise ValueError(f"executable bit missing: {rel}")
    if found != set(inventory):
        raise ValueError("archive file set differs from inventory")
    return {"file": archive.name, "size": archive.stat().st_size, "sha256": sha_file(archive), "files": len(found)}


def build(args):
    root = Path(__file__).resolve().parents[1]
    source = run(["git", "rev-parse", args.source + "^{commit}"], root, True).decode().strip()
    head = run(["git", "rev-parse", "HEAD"], root, True).decode().strip()
    if source != head or run(["git", "status", "--porcelain", "--untracked-files=no"], root, True).strip():
        raise ValueError("source must be clean committed HEAD (no checkout substitution)")
    cache = Path(args.inputs).resolve()
    upstream = checked_input(cache / UPSTREAM_FILE, UPSTREAM_SHA)
    inputs = {}
    for target, (suffix, digest) in NODES.items():
        inputs[target] = checked_input(cache / f"node-v{NODE_VERSION}-{suffix}", digest)
    out = Path(args.out).resolve()
    if out.exists() or out == root or root in out.parents:
        raise ValueError("output must be a new directory outside the checkout")
    out.mkdir(parents=True)
    print(f"Candidate output (not yet verified): {out}", flush=True)
    app = out / "stage-common/app"
    app.mkdir(parents=True)
    tracked = run(["git", "ls-tree", "-r", "--name-only", "-z", source], root, True).decode().strip("\0").split("\0")
    json_write(out / "tracked.json", tracked)
    helper = root / "tools/release-plan.mjs"
    selected = json.loads(run(["node", helper, "plan", root, out / "tracked.json"], root, True))
    if any(denied(f) for f in selected):
        raise ValueError("source plan contains refused files")
    json_write(out / "source-files.json", selected)
    wanted = set(selected)
    with tarfile.open(fileobj=io.BytesIO(run(["git", "archive", "--format=tar", source], root, True))) as t:
        for row in t:
            if row.name not in wanted:
                continue
            if not row.isfile():
                raise ValueError("non-regular source entry")
            put(app / safe_rel(row.name), t.extractfile(row).read())
    if any(not (app / f).is_file() for f in wanted):
        raise ValueError("source file missing from git archive")
    version = json.loads(run(["node", helper, "prepare", app, out / "source-files.json", source], root, True))["version"]
    print(f"Frozen source {source}: {len(selected)} allowed files", flush=True)
    npm = shutil.which("npm.cmd" if os.name == "nt" else "npm")
    run([npm, "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--bin-links=false"], app)
    run(["node", app / "tools/vendor.mjs"], app)
    if any(p.suffix.lower() == ".node" for p in files_under(app / "node_modules")):
        raise ValueError("native npm module needs platform-specific builds")
    art = extract_art(upstream, app)
    json_write(out / "upstream-art-provenance.json", {"url": UPSTREAM_URL, "sha256": UPSTREAM_SHA, "files": art})
    print(f"Verified upstream art and indexes: {len(art)} files; checkout art never copied", flush=True)
    run(["node", helper, "finalize", app, out / "upstream-art-provenance.json"], root)
    notes = (root / f"docs/releases/{RELEASE}.md").read_text(encoding="utf-8")
    # Public release body needs absolute links; bundle-root notes use app-relative links.
    def note_links(base):
        def replace(m):
            href = m.group(1)
            if re.match(r"^[a-z]+:|^#", href, re.I):
                return m.group(0)
            rel = os.path.normpath("docs/releases/" + href).replace("\\", "/")
            return "](" + base + rel + ")"
        return re.sub(r"\]\(([^)\s]+)\)", replace, notes)
    put(out / "ReleaseNotes.md", note_links(f"https://github.com/SiderLock/Stronghold-Protocol/blob/{source}/").encode())
    # The release body stays short; the server announcement preserves the full upstream changes.
    # This review artifact stays outside every package and never claims a completed deployment.
    with zipfile.ZipFile(upstream) as z:
        changelog = z.read("Stronghold-Protocol/CHANGELOG.md").decode("utf-8")
    put(out / "ServerAnnouncement.md", server_announcement(notes, changelog).encode())
    results = []
    for target, archive_input in inputs.items():
        name = f"Stronghold-Protocol-{RELEASE}-{target}"
        bundle = out / "stages" / name
        shutil.copytree(app, bundle / "app", copy_function=link_copy)
        extract_node(archive_input, bundle, target)
        launchers(bundle, target)
        put(bundle / "更新说明.md", note_links("app/").encode())
        for license_file in ("LICENSE", "NOTICE.md", "THIRD-PARTY-NOTICES.md"):
            if license_file.endswith(".md"):
                put(bundle / license_file, root_doc((app / license_file).read_text(encoding="utf-8")).encode())
            else:
                shutil.copy2(app / license_file, bundle / license_file)
        json_write(bundle / "RELEASE.json", {"release": RELEASE, "appVersion": version, "source": source,
                   "repository": "https://github.com/SiderLock/Stronghold-Protocol", "target": target,
                   "node": {"version": NODE_VERSION, "archive": archive_input.name, "sha256": NODES[target][1],
                            "url": f"https://nodejs.org/dist/v{NODE_VERSION}/{archive_input.name}"},
                   "art": {"url": UPSTREAM_URL, "sha256": UPSTREAM_SHA, "policy": "verified-upstream-only",
                           "indexes": sorted(UPSTREAM_INDEXES), "excludes": ["checkout art", "data/local-skins.json", "unverified local indexes"]}})
        inventory = make_inventory(bundle, art)
        archive = out / (name + (".zip" if target == "Windows-x64" else ".tar.gz"))
        print(f"Creating {archive.name}", flush=True)
        archive_bundle(bundle, archive)
        result = verify_archive(archive, inventory)
        results.append(result)
        json_write(out / "archive-verification.json", {"source": source, "release": RELEASE, "archives": results})
        print(f"Verified {archive.name}: {result['size']} bytes, {result['files']} files", flush=True)
    put(out / "SHA256SUMS.txt", "".join(f"{r['sha256']}  {r['file']}\n" for r in results).encode())
    print("Four candidate packages ready for review; nothing was published.", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, help="exact clean committed HEAD")
    parser.add_argument("--inputs", required=True, help="directory with the pinned upstream and Node archives")
    parser.add_argument("--out", required=True, help="new directory outside checkout; never overwritten")
    build(parser.parse_args())

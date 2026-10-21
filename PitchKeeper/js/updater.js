/*
 * Pitch Keeper — self-updater (runs in the CEP panel, Node.js enabled).
 * Reads version.json from the latest GitHub Release, downloads the zip, checks its sha256,
 * swaps it in place of the installed extension folder (the previous version is kept for rollback),
 * then reloads the panel and re-evaluates host.jsx so no Premiere restart is needed.
 */
(function (root) {
    "use strict";

    var REPO = "nhatlinh202/pitch-keeper";
    var MANIFEST_URL = "https://github.com/" + REPO + "/releases/latest/download/version.json";
    var JUST_UPDATED_KEY = "pitchkeeper.update.justUpdated";

    function nodeRequire(name) {
        if (typeof window !== "undefined" && window.cep_node) return window.cep_node.require(name);
        return require(name);
    }

    var fs = nodeRequire("fs"), path = nodeRequire("path"), os = nodeRequire("os");
    var https = nodeRequire("https"), crypto = nodeRequire("crypto"), cp = nodeRequire("child_process");

    function extensionDir() { return path.dirname(decodeURIComponent(location.pathname)); }
    // Outside the CEP extensions folder, so Premiere never loads the backup as a second copy.
    function supportDir() { return path.join(os.homedir(), "Library", "Application Support", "PitchKeeper"); }
    function backupDir() { return path.join(supportDir(), "previous"); }
    function stagingDir() { return path.join(supportDir(), "staging"); }

    function readVersion(dir) {
        try { return fs.readFileSync(path.join(dir, "VERSION"), "utf8").trim(); } catch (e) { return "0.0.0"; }
    }
    function localVersion() { return readVersion(extensionDir()); }

    function compareVersions(a, b) {
        var x = String(a).split("."), y = String(b).split(".");
        for (var i = 0; i < 3; i++) {
            var d = (parseInt(x[i], 10) || 0) - (parseInt(y[i], 10) || 0);
            if (d) return d > 0 ? 1 : -1;
        }
        return 0;
    }

    function rmrf(p) {
        if (fs.rmSync) fs.rmSync(p, { recursive: true, force: true });
        else if (fs.existsSync(p)) cp.execFileSync("/bin/rm", ["-rf", p]);
    }

    /** HTTPS GET following GitHub's redirects to its asset storage. */
    function get(url, redirectsLeft) {
        if (redirectsLeft === undefined) redirectsLeft = 5;
        return new Promise(function (resolve, reject) {
            var req = https.get(url, { headers: { "User-Agent": "PitchKeeper-Updater" } }, function (res) {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    res.resume();
                    if (!redirectsLeft) return reject(new Error("Quá nhiều chuyển hướng"));
                    return resolve(get(new URL(res.headers.location, url).toString(), redirectsLeft - 1));
                }
                if (res.statusCode !== 200) {
                    res.resume();
                    return reject(new Error("HTTP " + res.statusCode + " khi tải " + url));
                }
                var chunks = [];
                res.on("data", function (c) { chunks.push(c); });
                res.on("end", function () { resolve(Buffer.concat(chunks)); });
                res.on("error", reject);
            });
            req.setTimeout(60000, function () { req.destroy(new Error("Hết thời gian chờ mạng")); });
            req.on("error", reject);
        });
    }

    function run(cmd, args) {
        return new Promise(function (resolve, reject) {
            cp.execFile(cmd, args, function (err, stdout, stderr) {
                if (err) reject(new Error(cmd + ": " + (stderr || err.message)));
                else resolve(stdout);
            });
        });
    }

    function fetchLatest() {
        return get(MANIFEST_URL).then(function (buf) {
            var info = JSON.parse(buf.toString("utf8"));
            if (!info.version || !info.url || !info.sha256) throw new Error("version.json thiếu thông tin");
            return info;
        });
    }

    function writable(dir) {
        try { fs.accessSync(dir, fs.constants.W_OK); fs.accessSync(path.dirname(dir), fs.constants.W_OK); return true; } catch (e) { return false; }
    }

    /** Swap two folders: a -> b's place and b -> a's place. */
    function swap(current, replacement, keepAs) {
        rmrf(keepAs);
        fs.renameSync(current, keepAs);
        try {
            fs.renameSync(replacement, current);
        } catch (e) {
            fs.renameSync(keepAs, current); // put the old version back
            throw e;
        }
    }

    function sameManifest(dirA, dirB) {
        try {
            return fs.readFileSync(path.join(dirA, "CSXS", "manifest.xml"), "utf8") ===
                fs.readFileSync(path.join(dirB, "CSXS", "manifest.xml"), "utf8");
        } catch (e) { return false; }
    }

    /** Download, verify and install a release. Resolves with { from, to, notes, restart }. */
    function install(info) {
        var ext = extensionDir(), from = localVersion();
        if (!writable(ext)) {
            return Promise.reject(new Error("Không có quyền ghi vào " + ext + " — hãy cài lại bằng bộ cài .pkg (cài vào ~/Library)."));
        }
        fs.mkdirSync(supportDir(), { recursive: true });
        var zipPath = path.join(supportDir(), "update.zip");
        return get(info.url).then(function (buf) {
            var sum = crypto.createHash("sha256").update(buf).digest("hex");
            if (sum !== String(info.sha256).toLowerCase()) throw new Error("Sai sha256 — file tải về bị lỗi, đã huỷ cập nhật.");
            fs.writeFileSync(zipPath, buf);
            rmrf(stagingDir());
            fs.mkdirSync(stagingDir(), { recursive: true });
            return run("/usr/bin/ditto", ["-x", "-k", zipPath, stagingDir()]);
        }).then(function () {
            var fresh = path.join(stagingDir(), "PitchKeeper");
            if (!fs.existsSync(path.join(fresh, "CSXS", "manifest.xml"))) throw new Error("Gói cập nhật không đúng cấu trúc.");
            if (readVersion(fresh) !== info.version) throw new Error("Gói cập nhật không khớp phiên bản " + info.version + ".");
            var restart = !sameManifest(ext, fresh);
            swap(ext, fresh, backupDir());
            rmrf(stagingDir());
            rmrf(zipPath);
            return { from: from, to: info.version, notes: info.notes || "", restart: restart };
        });
    }

    /** Load the new host.jsx into Premiere, then reload the panel's HTML/JS. */
    function activate(result) {
        // Shown by the next panel instance, which already runs the new version (after a reload or a Premiere restart).
        var note = { status: result.status, from: result.from, to: result.to, notes: result.notes };
        try { localStorage.setItem(JUST_UPDATED_KEY, JSON.stringify(note)); } catch (e) {}
        if (result.restart) return;
        var hostPath = path.join(extensionDir(), "jsx", "host.jsx");
        window.__adobe_cep__.evalScript("$.evalFile(" + JSON.stringify(hostPath) + ")", function () { location.reload(); });
    }

    function waitIdle() {
        return new Promise(function (resolve) {
            (function check() {
                var app = window.PitchKeeperApp;
                if (app && app.isBusy()) setTimeout(check, 200); else resolve();
            })();
        });
    }

    /**
     * Check GitHub for a newer release and install it.
     * Resolves with { status: "latest" | "updated", version, ... }.
     */
    function checkAndUpdate() {
        return fetchLatest().then(function (info) {
            if (compareVersions(info.version, localVersion()) <= 0) return { status: "latest", version: localVersion() };
            return waitIdle().then(function () { return install(info); }).then(function (result) {
                result.status = "updated";
                activate(result);
                return result;
            });
        });
    }

    function hasBackup() { return fs.existsSync(path.join(backupDir(), "CSXS", "manifest.xml")); }
    function backupVersion() { return hasBackup() ? readVersion(backupDir()) : null; }

    /** Swap the installed version with the kept previous version. */
    function rollback() {
        if (!hasBackup()) return Promise.reject(new Error("Không có bản trước để quay về."));
        return waitIdle().then(function () {
            var ext = extensionDir(), from = localVersion(), to = backupVersion();
            var tmp = path.join(supportDir(), "swap");
            rmrf(tmp);
            fs.renameSync(backupDir(), tmp);
            var restart = !sameManifest(ext, tmp);
            swap(ext, tmp, backupDir());
            var result = { status: "rolledback", from: from, to: to, notes: "Quay về bản trước", restart: restart };
            activate(result);
            return result;
        });
    }

    /** One-shot message left by the previous panel instance after an update. */
    function takeJustUpdated() {
        try {
            var v = JSON.parse(localStorage.getItem(JUST_UPDATED_KEY) || "null");
            localStorage.removeItem(JUST_UPDATED_KEY);
            return v;
        } catch (e) { return null; }
    }

    root.PitchKeeperUpdater = {
        localVersion: localVersion,
        backupVersion: backupVersion,
        checkAndUpdate: checkAndUpdate,
        rollback: rollback,
        takeJustUpdated: takeJustUpdated,
        compareVersions: compareVersions
    };
})(typeof window !== "undefined" ? window : this);

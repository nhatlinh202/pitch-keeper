/*
 * Pitch Keeper — panel logic.
 * Every clip on the tracks the editor marks as VO gets two Pitch Shifter layers, kept in sync automatically:
 *   #1 Master : the project's Master Pitch for all voice over (blank = 1.0, bypassed)
 *   #2 Speed  : 1 / speed, undoing the pitch change caused by Speed/Duration or Rate Stretch
 * Pitch shifts multiply, so the heard pitch is always F0 × Master regardless of speed.
 *
 * The tool is switched ON/OFF per sequence and only ever touches the sequence open on the timeline.
 * Every clip it touches is recorded (how many Pitch Shifters it added, which existing ones it took over),
 * so switching OFF removes only what the tool added there and restores what it took over.
 */
(function () {
    "use strict";

    var PK = window.PitchKeeper;
    var MIN_RATIO = 0.5, MAX_RATIO = 2.0; // Pitch Shifter range (±12 semitones)
    var RATIO_TOLERANCE = 0.003;
    var SETTINGS_KEY = "pitchkeeper.settings.v1";
    var MASTER_KEY_PREFIX = "pitchkeeper.vomaster.";     // + project
    var VOTRACKS_KEY_PREFIX = "pitchkeeper.votracks.";   // + project + "." + sequence
    var ENABLED_KEY_PREFIX = "pitchkeeper.enabled.";
    var RECORDS_KEY_PREFIX = "pitchkeeper.records.";

    var state = {
        project: null,
        enabled: false,      // ON/OFF of the open sequence (ctxSeq), OFF until switched on
        ctxSeq: null,        // sequence the ON/OFF state belongs to
        records: {},         // record key -> { seq, nodeId, track, start, name, added, restore }
        sequenceId: null,
        tracksSig: "",
        master: null,        // Master Pitch for every VO clip of the project (null = none)
        voTracks: [],        // audio track indexes holding VO in the active sequence
        analysis: {},        // source segment key -> { f0, voicedFrames, totalFrames } | { f0: 0, error }
        analysisQueue: Promise.resolve(),
        analysisPending: {},
        failed: {},          // clip identity -> target signature that failed (avoid retrying every tick)
        autoTimer: null,
        autoSec: null,
        ticking: false,
        busy: false
    };

    var $ = function (id) { return document.getElementById(id); };

    function log(msg, cls) {
        var el = $("log"), line = document.createElement("div");
        if (cls) line.className = cls;
        line.textContent = new Date().toLocaleTimeString() + "  " + msg;
        el.appendChild(line);
        while (el.childNodes.length > 300) el.removeChild(el.firstChild);
        el.scrollTop = el.scrollHeight;
        // Flag errors on the bug button while the debug drawer is closed.
        if (cls === "err" && $("debugPanel").hidden) $("btnBug").classList.add("alert");
    }

    function host(fn, args) {
        var script = fn + "(" + (args || []).map(function (a) { return JSON.stringify(a); }).join(",") + ")";
        return new Promise(function (resolve, reject) {
            if (!window.__adobe_cep__) return reject(new Error("Không chạy trong Premiere (thiếu CEP)."));
            window.__adobe_cep__.evalScript(script, function (res) {
                var r;
                try { r = JSON.parse(res); } catch (e) { return reject(new Error("ExtendScript lỗi: " + res)); }
                if (r.ok) resolve(r.data); else reject(new Error(r.error));
            });
        });
    }

    function storageGet(key) {
        try { return JSON.parse(localStorage.getItem(key) || "null"); } catch (e) { return null; }
    }
    function storageSet(key, value) {
        try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
    }

    // ---------- settings ----------

    var SETTING_FIELDS = ["autoSelectedOnly", "autoInterval"];

    function saveSettings() {
        var s = {};
        SETTING_FIELDS.forEach(function (id) {
            var el = $(id);
            s[id] = el.type === "checkbox" ? el.checked : el.value;
        });
        storageSet(SETTINGS_KEY, s);
    }

    function loadSettings() {
        var s = storageGet(SETTINGS_KEY);
        if (!s) return;
        SETTING_FIELDS.forEach(function (id) {
            if (s[id] === undefined) return;
            var el = $(id);
            if (el.type === "checkbox") el.checked = !!s[id]; else el.value = s[id];
        });
    }

    // ---------- helpers ----------

    function sourceKey(c) { return c.path + "|" + c.inSec.toFixed(3) + "|" + c.outSec.toFixed(3); }
    function clipKey(c) { return c.track + "|" + c.start.toFixed(3) + "|" + c.name; }
    function semis(ratio) { return 12 * Math.log(ratio) / Math.LN2; }
    function fmtSemis(st) { return (st >= 0 ? "+" : "") + st.toFixed(2) + " st"; }
    function fmtRatio(r) { return "×" + r.toFixed(4); }
    function fmtHz(hz) { return hz > 0 ? hz.toFixed(1) + " Hz (" + PK.noteName(hz) + ")" : "—"; }
    function clamp(r) { return Math.min(MAX_RATIO, Math.max(MIN_RATIO, r)); }
    function isNeutral(r) { return Math.abs(r - 1) < 1e-4; }
    function fmtTC(sec) {
        sec = Math.max(0, Math.floor(sec));
        var h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, x = sec % 60;
        return (h < 10 ? "0" : "") + h + ":" + (m < 10 ? "0" : "") + m + ":" + (x < 10 ? "0" : "") + x;
    }
    function clipLabel(c) { return c.name + " @" + fmtTC(c.start) + " (A" + (c.track + 1) + ")"; }

    function setBusy(b) {
        state.busy = b;
        ["btnAnalyze", "btnDump", "btnReflect", "btnInfo"].forEach(function (id) { $(id).disabled = b; });
        $("toggle").disabled = b || !state.ctxSeq;
    }

    /** Let the panel grow/shrink with its content (works when the panel is floating). */
    function fitPanel() {
        try {
            var h = Math.ceil($("app").getBoundingClientRect().height) + 20;
            if (window.__adobe_cep__ && window.__adobe_cep__.resizeContent) window.__adobe_cep__.resizeContent(window.innerWidth, h);
        } catch (e) {}
    }

    function waitIdle() {
        return new Promise(function (resolve) {
            (function check() { if (state.ticking) setTimeout(check, 50); else resolve(); })();
        });
    }

    // ---------- ON / OFF per project ----------

    function recordKey(seqId, clip, nodeId) {
        nodeId = nodeId || clip.nodeId;
        return nodeId ? "n:" + nodeId : "k:" + seqId + "|" + clip.track + "|" + clip.start.toFixed(3) + "|" + clip.name;
    }

    function saveRecords() {
        if (state.project) storageSet(RECORDS_KEY_PREFIX + state.project, state.records);
    }

    function loadProject(key, name) {
        state.project = key;
        state.records = storageGet(RECORDS_KEY_PREFIX + key) || {};
        state.failed = {};
        state.sequenceId = null;
        state.ctxSeq = null;
        state.tracksSig = "";
        loadMaster();
        if (name) log("Project: " + name);
    }

    function enabledKey() { return ENABLED_KEY_PREFIX + state.project + "." + state.ctxSeq; }

    /** Follow the open project and sequence; ON/OFF is stored per sequence. */
    function syncContext(info) {
        if (info.project !== state.project) loadProject(info.project, info.projectName);
        if (info.sequenceId === state.ctxSeq) return;
        state.ctxSeq = info.sequenceId || null;
        state.enabled = !!(state.ctxSeq && storageGet(enabledKey()));
        if (state.ctxSeq) log("Sequence: " + info.sequenceName + " — tool " + (state.enabled ? "ON" : "OFF"));
        renderEnabled();
    }

    function renderEnabled() {
        $("toggle").checked = state.enabled;
        $("toggle").disabled = state.busy || !state.ctxSeq;
        renderPill(state.enabled ? "on" : "off");
        $("masterBox").hidden = !state.enabled;
        $("offNote").hidden = state.enabled;
        $("offNote").textContent = state.ctxSeq
            ? "Tool đang tắt cho sequence này — bật công tắc để tự áp dụng Pitch Shifter."
            : "Chưa mở sequence nào.";
        if (!state.enabled) setAutoStatus(state.ctxSeq ? "Tool đang tắt cho sequence này." : "Chưa mở sequence nào.");
        fitPanel();
    }

    /** Remember what the tool did to a clip the first time it touches it. */
    function rememberApply(seqId, clip, r) {
        var k = recordKey(seqId, clip, r.nodeId);
        if (state.records[k]) return;
        var restore = r.takenOver || [];
        if (!r.added && !restore.length) return;
        state.records[k] = { seq: seqId, nodeId: r.nodeId || clip.nodeId || "", track: clip.track, start: clip.start, name: clip.name, added: r.added, restore: restore };
        saveRecords();
    }

    /**
     * A razor cut or a duplicate inherits the tool's two layers but gets a new clip id, so it has no record.
     * If its first two Pitch Shifters already hold exactly what the tool would set, they are the tool's: record them.
     */
    function adoptCopiedLayers(seqId, clip) {
        if (!clip.layers || clip.layers.length < 2) return;
        var k = recordKey(seqId, clip);
        if (state.records[k]) return;
        state.records[k] = { seq: seqId, nodeId: clip.nodeId || "", track: clip.track, start: clip.start, name: clip.name, added: 2, restore: [] };
        saveRecords();
        log(clipLabel(clip) + ": nhận 2 lớp Pitch Shifter từ đoạn cắt / nhân bản");
    }

    /** Keep recorded positions fresh when clips tracked by nodeId are moved. */
    function refreshRecords(scan) {
        var changed = false;
        scan.clips.forEach(function (c) {
            var rec = c.nodeId && state.records["n:" + c.nodeId];
            if (rec && (rec.track !== c.track || Math.abs(rec.start - c.start) > 1e-3 || rec.name !== c.name)) {
                rec.track = c.track; rec.start = c.start; rec.name = c.name; rec.seq = scan.sequenceId;
                changed = true;
            }
        });
        if (changed) saveRecords();
    }

    /** Remove the Pitch Shifters the tool added to these clips and restore the ones it took over. */
    function cleanupRecords(keys) {
        var counts = { removed: 0, bypassed: 0, gone: 0, skipped: 0, failed: 0 }, chain = Promise.resolve();
        keys.forEach(function (k) {
            var rec = state.records[k];
            chain = chain.then(function () {
                return host("pk_cleanupClip", [rec.seq, rec.nodeId, rec.track, rec.start, rec.name, rec.restore, rec.added]).then(function (r) {
                    counts[r.status] = (counts[r.status] || 0) + 1;
                    if (r.status !== "skipped") delete state.records[k];
                    if (r.status !== "gone") log(clipLabel(rec) + ": " + r.log.join(", "), r.status === "bypassed" ? "warn" : "ok");
                }, function (e) {
                    counts.failed++;
                    log(clipLabel(rec) + ": không gỡ được — " + e.message, "err");
                });
            });
        });
        return chain.then(function () {
            saveRecords();
            return counts;
        });
    }

    /** OFF: undo the tool on the clips it touched in the open sequence only. */
    function cleanupSequence() {
        var seq = state.ctxSeq;
        var keys = Object.keys(state.records).filter(function (k) { return state.records[k].seq === seq; });
        if (!keys.length) {
            log("OFF — sequence này không có Pitch Shifter nào do tool thêm.", "ok");
            return Promise.resolve();
        }
        setBusy(true);
        log("OFF — đang gỡ Pitch Shifter do tool thêm trên " + keys.length + " clip của sequence này…");
        return waitIdle().then(function () { return cleanupRecords(keys); }).then(function (counts) {
            log("OFF — xong: gỡ " + counts.removed + " clip" +
                (counts.bypassed ? ", " + counts.bypassed + " clip chỉ bypass được" : "") +
                (counts.gone ? ", " + counts.gone + " clip không còn trên timeline" : "") +
                (counts.failed ? ", " + counts.failed + " clip lỗi (giữ lại để thử lần sau)" : ""),
                counts.failed ? "err" : (counts.bypassed ? "warn" : "ok"));
            setBusy(false);
        });
    }

    /** Re-read the open project/sequence first: the editor may have switched since the last tick. */
    function setEnabled(on) {
        host("pk_projectInfo").then(function (info) {
            syncContext(info);
            applyEnabled(on);
        }).catch(function (e) {
            log(e.message, "err");
            renderEnabled();
        });
    }

    function applyEnabled(on) {
        if (!state.project || !state.ctxSeq) return renderEnabled();
        state.enabled = on;
        storageSet(enabledKey(), on);
        renderEnabled();
        if (on) {
            log("ON — tự động áp dụng 2 lớp Pitch Shifter.", "ok");
            state.failed = {};
            autoTick();
        } else {
            cleanupSequence();
        }
    }

    // ---------- VO tracks + Master Pitch ----------

    var VO_NAME_RE = /(^|[^a-z])(vo|voice|voiceover|narration|narrator|thoai|thoại|lồng tiếng|long tieng)([^a-z]|$)/i;

    /** "" -> null (no Master); valid ratio -> number; anything else -> NaN. */
    function parseMaster(text) {
        text = String(text).trim().replace(",", ".");
        if (!text) return null;
        var v = Number(text);
        return isFinite(v) && v >= MIN_RATIO && v <= MAX_RATIO ? v : NaN;
    }

    /** Semitone pill next to the Master value: gray when blank, red when out of range. */
    function renderMasterHint(v) {
        var el = $("masterHint");
        el.textContent = v === null ? "không đổi" : isNaN(v) ? "0.5 – 2.0" : fmtSemis(semis(v));
        el.className = "pill" + (v === null ? " none" : isNaN(v) ? " bad" : "");
    }

    /** One Master Pitch for every VO clip of the project (a project uses one narrator voice). */
    function loadMaster() {
        var v = state.project ? storageGet(MASTER_KEY_PREFIX + state.project) : null;
        state.master = typeof v === "number" ? v : null;
        $("masterInput").value = state.master === null ? "" : String(state.master);
        $("masterInput").classList.remove("bad");
        renderMasterHint(state.master);
    }

    function voTracksKey() { return VOTRACKS_KEY_PREFIX + state.project + "." + state.sequenceId; }

    /** VO tracks are picked per sequence; the first time, guess them from the track names. */
    function loadVoTracks(scan) {
        var saved = storageGet(voTracksKey());
        if (saved) {
            state.voTracks = saved;
            return;
        }
        state.voTracks = scan.tracks.filter(function (t) { return VO_NAME_RE.test(t.name); }).map(function (t) { return t.index; });
        if (state.voTracks.length) log("Tự chọn track VO theo tên: " + state.voTracks.map(function (i) { return "A" + (i + 1); }).join(", "));
        storageSet(voTracksKey(), state.voTracks);
    }

    function isVoTrack(t) { return state.voTracks.indexOf(t) >= 0; }

    function trackLabel(t) {
        return "A" + (t.index + 1) + (t.name && t.name !== "Audio " + (t.index + 1) ? " · " + t.name : "");
    }

    /** Rebuild the track chips only when the sequence or its track list changes. */
    function renderTracks(scan) {
        var sig = scan.sequenceId + "|" + scan.tracks.map(function (t) { return t.name; }).join("|");
        $("noTrackHint").hidden = state.voTracks.length > 0;
        if (sig === state.tracksSig) return;
        state.tracksSig = sig;
        $("seqName").textContent = scan.sequenceName;
        var box = $("trackList");
        box.innerHTML = "";
        scan.tracks.forEach(function (t) {
            var chip = document.createElement("label");
            chip.className = "chip";
            var cb = document.createElement("input");
            cb.type = "checkbox";
            cb.checked = isVoTrack(t.index);
            chip.classList.toggle("on", cb.checked);
            var text = document.createElement("span");
            text.textContent = trackLabel(t);
            cb.addEventListener("change", function () {
                chip.classList.toggle("on", cb.checked);
                if (cb.checked && !isVoTrack(t.index)) state.voTracks.push(t.index);
                if (!cb.checked) state.voTracks = state.voTracks.filter(function (i) { return i !== t.index; });
                state.voTracks.sort(function (x, y) { return x - y; });
                storageSet(voTracksKey(), state.voTracks);
                state.failed = {};
                $("noTrackHint").hidden = state.voTracks.length > 0;
                log(trackLabel(t) + (cb.checked ? ": là track VO" : ": bỏ khỏi VO — gỡ lớp tool đã thêm"), "ok");
                autoTick();
            });
            chip.appendChild(cb);
            chip.appendChild(text);
            box.appendChild(chip);
        });
        setTimeout(fitPanel, 0);
    }

    function onScan(scan) {
        syncContext(scan);
        if (scan.sequenceId !== state.sequenceId) {
            state.sequenceId = scan.sequenceId;
            state.failed = {};
            loadVoTracks(scan);
        }
        renderTracks(scan);
    }

    // ---------- targets ----------

    /** Wanted ratios for the two plugin layers of a clip. */
    function targets(clip) {
        var master = state.master === null ? 1 : state.master;
        var wanted = 1 / clip.speed, speed = clamp(wanted);
        return { master: master, speed: speed, wantedSpeed: wanted, clamped: speed !== wanted };
    }

    function layerMatches(layer, ratio) {
        if (!layer || layer.ratio === null) return false;
        if (Math.abs(layer.ratio - ratio) > RATIO_TOLERANCE) return false;
        return layer.bypass === null || layer.bypass === isNeutral(ratio);
    }

    function needsUpdate(clip, tg) {
        var layers = clip.layers || [];
        if (!layers.length) return !(isNeutral(tg.master) && isNeutral(tg.speed));
        return !layerMatches(layers[0], tg.master) || !layerMatches(layers[1], tg.speed);
    }

    function describe(clip, tg) {
        return clipLabel(clip) + " speed " + (clip.speed * 100).toFixed(1) + "% → Master " +
            fmtRatio(tg.master) + ", Speed " + fmtRatio(tg.speed) + " = tổng " + fmtSemis(semis(tg.master * tg.speed));
    }

    function applyLayers(clip, tg) {
        return host("pk_applyLayers", [clip.track, clip.index, tg.master, tg.speed, clip.start, clip.name]);
    }

    /** Analyse a clip's source once; results are cached per source segment, so speed edits reuse them. */
    function analyze(clip) {
        var k = sourceKey(clip);
        if (state.analysis[k]) return Promise.resolve(state.analysis[k]);
        if (!clip.path) return Promise.reject(new Error("Clip không có media path (nested/synthetic?)."));
        state.analysisPending[k] = true;
        var p = state.analysisQueue.then(function () {
            return PK.analyzeClip(clip);
        }).then(function (res) {
            state.analysis[k] = res;
            return res;
        }, function (e) {
            state.analysis[k] = { f0: 0, error: e.message };
            throw e;
        }).then(function (res) {
            delete state.analysisPending[k];
            return res;
        }, function (e) {
            delete state.analysisPending[k];
            throw e;
        });
        state.analysisQueue = p.catch(function () {});
        return p;
    }

    /** Pitch the listener hears: F0 × speed × Master × compensation. */
    function heardF0(f0, clip, tg) {
        return f0 * clip.speed * tg.master * tg.speed;
    }

    // ---------- auto mode (always on) ----------

    function setAutoStatus(text, cls) {
        var el = $("autoStatus");
        el.textContent = text;
        el.className = cls || "";
        if (state.enabled) renderPill(cls === "warn" ? "warn" : "on");
    }

    /** Status pill next to the ON/OFF switch. */
    function renderPill(mode) {
        var el = $("toggleText");
        el.textContent = mode === "on" ? "Đang chạy" : mode === "warn" ? "Cần chú ý" : state.ctxSeq ? "Đã tắt" : "Chưa mở sequence";
        el.className = "pill" + (mode === "on" ? " on" : mode === "warn" ? " warn" : "");
    }

    function autoTick() {
        if (state.ticking || state.busy) return;
        state.ticking = true;
        if (!state.enabled) {
            // OFF: only watch for a project/sequence switch, don't touch any clip.
            host("pk_projectInfo").then(function (info) {
                syncContext(info);
                if (state.enabled) setTimeout(autoTick, 0);
            }).catch(function (e) {
                setAutoStatus("Tạm dừng: " + e.message, "warn");
            }).then(function () { state.ticking = false; });
            return;
        }
        host("pk_scanAudioClips", [$("autoSelectedOnly").checked]).then(function (scan) {
            onScan(scan);
            if (!state.enabled) return; // switched to a sequence where the tool is OFF
            refreshRecords(scan);
            var changes = [], leaving = [], voCount = 0;
            scan.clips.forEach(function (clip) {
                if (!isVoTrack(clip.track)) {
                    // Not (or no longer) on a VO track: undo whatever the tool did to it.
                    var rk = recordKey(scan.sequenceId, clip);
                    if (state.records[rk]) leaving.push(rk);
                    return;
                }
                voCount++;
                var tg = targets(clip);
                if (!needsUpdate(clip, tg)) {
                    adoptCopiedLayers(scan.sequenceId, clip);
                    return;
                }
                var sig = tg.master.toFixed(5) + "|" + tg.speed.toFixed(5);
                if (state.failed[clipKey(clip)] === sig) return;
                changes.push({ clip: clip, tg: tg, sig: sig });
            });

            var chain = Promise.resolve();
            changes.forEach(function (ch) {
                chain = chain.then(function () {
                    return applyLayers(ch.clip, ch.tg).then(function (r) {
                        delete state.failed[clipKey(ch.clip)];
                        rememberApply(scan.sequenceId, ch.clip, r);
                        log((r.added ? "Thêm " + r.added + " lớp: " : "Cập nhật: ") + describe(ch.clip, ch.tg) +
                            (ch.tg.clamped ? " (bù speed bị kẹp, cần " + fmtRatio(ch.tg.wantedSpeed) + ")" : ""),
                            ch.tg.clamped ? "warn" : "ok");
                    }, function (e) {
                        state.failed[clipKey(ch.clip)] = ch.sig;
                        log(clipLabel(ch.clip) + " — " + e.message, "err");
                    });
                });
            });
            if (leaving.length) chain = chain.then(function () { return cleanupRecords(leaving); });
            return chain.then(function () {
                if (!state.voTracks.length) {
                    setAutoStatus("Chưa chọn track VO nào.", "warn");
                    return;
                }
                setAutoStatus("Đang theo dõi " + voCount + " clip VO trên " +
                    state.voTracks.map(function (i) { return "A" + (i + 1); }).join(", ") +
                    " — quét lúc " + new Date().toLocaleTimeString(), "ok");
            });
        }).catch(function (e) {
            setAutoStatus("Tạm dừng: " + e.message, "warn");
        }).then(function () { state.ticking = false; });
    }

    function startAuto() {
        if (state.autoTimer) clearInterval(state.autoTimer);
        var sec = Math.max(0.5, parseFloat($("autoInterval").value) || 1.5);
        state.autoTimer = setInterval(autoTick, sec * 1000);
        if (sec !== state.autoSec) log("Tự động: quét mọi audio track mỗi " + sec + " giây.", "ok");
        state.autoSec = sec;
        autoTick();
    }

    // ---------- manual buttons ----------

    function renderRows(items) {
        var tb = $("rows");
        tb.innerHTML = "";
        items.forEach(function (it) {
            var tr = document.createElement("tr");
            var cells = [
                it.clip.name,
                (it.clip.speed * 100).toFixed(1) + "%" + (it.clip.reversed ? " ⟲" : ""),
                fmtRatio(it.tg.master) + "\n" + fmtRatio(it.tg.speed),
                it.f0 > 0 ? fmtHz(it.f0) + "\n→ " + fmtHz(heardF0(it.f0, it.clip, it.tg)) : (it.error || "—")
            ];
            cells.forEach(function (txt, i) {
                var td = document.createElement("td");
                td.textContent = txt;
                if (i > 0) td.className = "num";
                td.style.whiteSpace = "pre";
                tr.appendChild(td);
            });
            tb.appendChild(tr);
        });
    }

    function analyzeSelection() {
        setBusy(true);
        var items = [];
        host("pk_getSelectedAudioClips").then(function (scan) {
            onScan(scan);
            if (!scan.clips.length) throw new Error("Chưa chọn clip audio nào trên timeline.");
            var chain = Promise.resolve();
            scan.clips.forEach(function (clip) {
                chain = chain.then(function () {
                    var item = { clip: clip, tg: targets(clip), f0: 0 };
                    items.push(item);
                    return analyze(clip).then(function (res) {
                        item.f0 = res.f0;
                        if (res.error) item.error = res.error;
                    }, function (e) {
                        item.error = e.message;
                    });
                });
            });
            return chain;
        }).then(function () {
            renderRows(items);
            fitPanel();
        }, function (e) {
            $("rows").innerHTML = "";
            var tr = document.createElement("tr"), td = document.createElement("td");
            td.colSpan = 4;
            td.style.color = "var(--muted)";
            td.textContent = e.message;
            tr.appendChild(td);
            $("rows").appendChild(tr);
        }).then(function () { setBusy(false); });
    }

    /** Info and Debug drawers: at most one open at a time. */
    function toggleDrawer(name) {
        var drawers = { info: ["infoPanel", "btnInfo"], debug: ["debugPanel", "btnBug"] };
        Object.keys(drawers).forEach(function (k) {
            var open = k === name && $(drawers[k][0]).hidden;
            $(drawers[k][0]).hidden = !open;
            $(drawers[k][1]).classList.toggle("active", open);
        });
        if (!$("infoPanel").hidden) analyzeSelection();
        if (!$("debugPanel").hidden) {
            $("btnBug").classList.remove("alert");
            $("log").scrollTop = $("log").scrollHeight;
        }
        fitPanel();
    }

    $("btnInfo").onclick = function () { toggleDrawer("info"); };
    $("btnBug").onclick = function () { toggleDrawer("debug"); };
    $("btnAnalyze").onclick = analyzeSelection;

    $("btnCopyLog").onclick = function () {
        var ta = document.createElement("textarea");
        ta.value = "Pitch Keeper log — " + new Date().toString() + "\n" + $("log").innerText;
        document.body.appendChild(ta);
        ta.select();
        var ok = false;
        try { ok = document.execCommand("copy"); } catch (e) {}
        document.body.removeChild(ta);
        log(ok ? "Đã copy log vào clipboard." : "Không copy được log.", ok ? "ok" : "warn");
    };

    $("btnDump").onclick = function () {
        setBusy(true);
        host("pk_getSelectedAudioClips").then(function (scan) {
            if (!scan.clips.length) throw new Error("Chưa chọn clip audio nào trên timeline.");
            var c = scan.clips[0];
            return host("pk_dumpComponents", [c.track, c.index]).then(function (comps) {
                log("— Effect của '" + c.name + "' —");
                comps.forEach(function (comp) {
                    log("[" + comp.name + "] " + comp.matchName);
                    comp.props.forEach(function (p) { log("   " + p.name + " = " + p.value); });
                });
            });
        }).catch(function (e) { log(e.message, "err"); }).then(function () { setBusy(false); });
    };

    $("btnReflect").onclick = function () {
        setBusy(true);
        host("pk_getSelectedAudioClips").then(function (scan) {
            if (!scan.clips.length) throw new Error("Chưa chọn clip audio nào trên timeline.");
            var c = scan.clips[0];
            return host("pk_reflectQE", [c.track, c.index]).then(function (r) {
                log("— QE của '" + c.name + "' —");
                log("item: " + r.item);
                r.components.forEach(function (qc) { log("[" + qc.name + "] " + qc.methods); });
            });
        }).catch(function (e) { log(e.message, "err"); }).then(function () { setBusy(false); });
    };

    $("toggle").addEventListener("change", function () { setEnabled($("toggle").checked); });

    $("masterInput").addEventListener("input", function () {
        var v = parseMaster($("masterInput").value);
        renderMasterHint(v);
        $("masterInput").classList.toggle("bad", isNaN(v) && v !== null);
    });
    $("masterInput").addEventListener("change", function () {
        var v = parseMaster($("masterInput").value);
        if (isNaN(v) && v !== null) {
            log("Master Pitch phải là ratio 0.5 – 2.0 hoặc để trống.", "err");
            return;
        }
        state.master = v;
        storageSet(MASTER_KEY_PREFIX + state.project, v);
        state.failed = {};
        log("Master Pitch VO = " + (v === null ? "trống" : fmtRatio(v) + " / " + fmtSemis(semis(v))), "ok");
        autoTick();
    });

    /** − / + nudge the Master by 0.05 (a blank Master starts from 1.0). */
    function stepMaster(delta) {
        var v = parseMaster($("masterInput").value);
        var base = v === null || isNaN(v) ? 1 : v;
        var next = Math.min(MAX_RATIO, Math.max(MIN_RATIO, Math.round((base + delta) * 100) / 100));
        $("masterInput").value = next.toFixed(2);
        $("masterInput").classList.remove("bad");
        renderMasterHint(next);
        $("masterInput").dispatchEvent(new Event("change"));
    }
    $("masterDec").onclick = function () { stepMaster(-0.05); };
    $("masterInc").onclick = function () { stepMaster(0.05); };

    SETTING_FIELDS.forEach(function (id) {
        $(id).addEventListener("change", function () { saveSettings(); startAuto(); });
    });

    // ---------- self-update ----------

    var UP = window.PitchKeeperUpdater;
    var UPDATE_EVERY_MS = 6 * 3600 * 1000;
    window.PitchKeeperApp = { isBusy: function () { return state.busy || state.ticking; } };

    function showNote(text, cls) {
        var el = $("updateNote");
        el.textContent = text;
        el.className = "note " + (cls || "");
        el.hidden = false;
        fitPanel();
    }
    $("updateNote").onclick = function () { $("updateNote").hidden = true; fitPanel(); };

    function renderVersion() {
        var ver = document.createElement("b");
        ver.textContent = UP.localVersion();
        $("verText").textContent = "Phiên bản ";
        $("verText").appendChild(ver);
    }

    /** Auto checks stay quiet when offline; a manual check reports everything. */
    function runUpdate(manual) {
        $("btnUpdate").disabled = true;
        return UP.checkAndUpdate().then(function (r) {
            if (r.status === "latest") {
                if (manual) log("Đang dùng bản mới nhất (" + r.version + ").", "ok");
            } else if (r.restart) {
                log("Đã tải bản " + r.to + " — khởi động lại Premiere để hoàn tất.", "warn");
                showNote("Đã tải bản " + r.to + " — khởi động lại Premiere để hoàn tất.", "warn");
            }
            // Otherwise the panel is reloading into the new version.
        }).catch(function (e) {
            log("Cập nhật: " + e.message, manual ? "err" : "warn");
        }).then(function () {
            $("btnUpdate").disabled = false;
            renderVersion();
        });
    }

    if (UP) {
        $("btnUpdate").onclick = function () { runUpdate(true); };
        var just = UP.takeJustUpdated();
        if (just) {
            var msg = "Đã cập nhật lên bản " + just.to + (just.notes ? " — " + just.notes : "");
            log(msg, "ok");
            showNote(just.restart ? msg + ". Khởi động lại Premiere để hoàn tất." : msg, just.restart ? "warn" : "ok");
        }
        renderVersion();
        setTimeout(function () { runUpdate(false); }, 3000);
        setInterval(function () { runUpdate(false); }, UPDATE_EVERY_MS);
    } else {
        $("verText").textContent = "Trình cập nhật không chạy được trong môi trường này.";
        $("btnUpdate").disabled = true;
    }

    $("toggle").disabled = true; // until the open sequence is known
    host("pk_projectInfo").then(syncContext).catch(function (e) { setAutoStatus("Tạm dừng: " + e.message, "warn"); });

    loadSettings();
    log("ffmpeg: " + (PK.findFfmpeg() || "không có — dùng Web Audio để giải mã"));
    startAuto();
})();

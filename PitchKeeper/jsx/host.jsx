/*
 * Pitch Keeper — ExtendScript side (runs inside Premiere Pro).
 * Reads audio clips (speed, source path, in/out) and manages two
 * "Pitch Shifter" layers on each clip:
 *   Pitch Shifter #1 = Master Pitch of the clip's track
 *   Pitch Shifter #2 = speed compensation (1 / speed)
 * Any further Pitch Shifter on the clip belongs to the editor and is left alone.
 * When the tool is switched off for the active sequence, the panel calls pk_cleanupClip to remove
 * the layers it added there and restore any Pitch Shifter it took over. Other sequences are never touched.
 */

var PK_TICKS_PER_SEC = 254016000000;
var PK_EFFECT_NAME = "Pitch Shifter";
var PK_LAYERS = 2;

// Audio effect params are stored normalized 0..1; Pitch Shifter's Transpose Ratio
// maps linearly to the displayed 0.5..2.0 (normalized 0.8 shows as 1.70).
var PK_RATIO_MIN = 0.5, PK_RATIO_MAX = 2.0;
function pk_ratioToNorm(r) { return Math.min(1, Math.max(0, (r - PK_RATIO_MIN) / (PK_RATIO_MAX - PK_RATIO_MIN))); }
function pk_normToRatio(n) { return PK_RATIO_MIN + n * (PK_RATIO_MAX - PK_RATIO_MIN); }

// ExtendScript has no native JSON -> tiny serializer.
function pk_json(v) {
    if (v === null || v === undefined) return "null";
    var t = typeof v;
    if (t === "number") return isFinite(v) ? String(v) : "null";
    if (t === "boolean") return v ? "true" : "false";
    if (t === "string") {
        return '"' + v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
            .replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t") + '"';
    }
    var parts = [], k;
    if (v instanceof Array) {
        for (k = 0; k < v.length; k++) parts.push(pk_json(v[k]));
        return "[" + parts.join(",") + "]";
    }
    for (k in v) {
        if (v.hasOwnProperty(k)) parts.push(pk_json(String(k)) + ":" + pk_json(v[k]));
    }
    return "{" + parts.join(",") + "}";
}

function pk_ok(data) { return pk_json({ ok: true, data: data }); }
function pk_err(msg) { return pk_json({ ok: false, error: String(msg) }); }

function pk_clipSpeed(clip) {
    var srcDur = clip.outPoint.seconds - clip.inPoint.seconds;
    var tlDur = clip.end.seconds - clip.start.seconds;
    var fromDur = tlDur > 0 ? srcDur / tlDur : 1;
    var s = NaN;
    try { s = Number(clip.getSpeed()); } catch (e) {}
    if (!isFinite(s) || s === 0) return Math.abs(fromDur);
    s = Math.abs(s);
    if (s > 20) s = s / 100; // some builds report percent
    return s;
}

function pk_isReversed(clip) {
    try { return !!clip.isSpeedReversed(); } catch (e) { return false; }
}

// ---------- Pitch Shifter components ----------

function pk_isPitchShifter(comp) {
    var dn = String(comp.displayName || "").toLowerCase();
    return dn === PK_EFFECT_NAME.toLowerCase() || dn.indexOf("pitch shift") >= 0;
}

/** All Pitch Shifter components of a clip, in effect-stack order. */
function pk_pitchShifters(clip) {
    var out = [];
    for (var k = 0; k < clip.components.numItems; k++) {
        if (pk_isPitchShifter(clip.components[k])) out.push(clip.components[k]);
    }
    return out;
}

function pk_findProp(comp, keyword) {
    for (var k = 0; k < comp.properties.numItems; k++) {
        var p = comp.properties[k];
        if (String(p.displayName || "").toLowerCase().indexOf(keyword) >= 0) return p;
    }
    return null;
}

/** The unnamed first property of an audio effect is its Bypass switch. */
function pk_bypassProp(comp) {
    if (!comp.properties.numItems) return null;
    var p = comp.properties[0];
    var dn = String(p.displayName || "");
    return dn === "" || dn.toLowerCase().indexOf("bypass") >= 0 ? p : null;
}

function pk_layerState(comp) {
    var r = pk_findProp(comp, "transpose ratio"), b = pk_bypassProp(comp), bypass = null;
    if (b) { try { bypass = String(b.getValue()) === "true" || Number(b.getValue()) === 1; } catch (e) {} }
    return { ratio: r ? pk_normToRatio(Number(r.getValue())) : null, bypass: bypass };
}

// ---------- scanning ----------

/** Stable id of the open project (documentID is saved in the .prproj), falling back to its path. */
function pk_projectKey() {
    var id = "";
    try { id = String(app.project.documentID || ""); } catch (e) {}
    return id || String(app.project.path || "");
}

function pk_projectInfo() {
    try {
        var seq = app.project.activeSequence;
        return pk_ok({
            project: pk_projectKey(),
            projectName: String(app.project.name),
            sequenceId: seq ? String(seq.sequenceID) : "",
            sequenceName: seq ? String(seq.name) : ""
        });
    } catch (e) {
        return pk_err(e);
    }
}

function pk_getSelectedAudioClips() {
    return pk_scanAudioClips(true);
}

/** Audio tracks + audio clips of the active sequence. */
function pk_scanAudioClips(selectedOnly) {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return pk_err("Chưa mở sequence nào.");
        var tracks = [], clips = [];
        for (var t = 0; t < seq.audioTracks.numTracks; t++) {
            var track = seq.audioTracks[t];
            tracks.push({ index: t, name: String(track.name || "") });
            for (var i = 0; i < track.clips.numItems; i++) {
                var c = track.clips[i];
                if (selectedOnly && !c.isSelected()) continue;
                var path = "";
                try { if (c.projectItem) path = c.projectItem.getMediaPath(); } catch (e1) {}
                var layers = [], ps = pk_pitchShifters(c);
                for (var k = 0; k < ps.length && k < PK_LAYERS; k++) layers.push(pk_layerState(ps[k]));
                var nodeId = "";
                try { nodeId = String(c.nodeId || ""); } catch (e2) {}
                clips.push({
                    nodeId: nodeId,
                    track: t,
                    index: i,
                    name: c.name,
                    start: c.start.seconds,
                    end: c.end.seconds,
                    inSec: c.inPoint.seconds,
                    outSec: c.outPoint.seconds,
                    speed: pk_clipSpeed(c),
                    reversed: pk_isReversed(c),
                    path: path,
                    layers: layers
                });
            }
        }
        return pk_ok({
            project: pk_projectKey(),
            projectName: String(app.project.name),
            sequenceId: String(seq.sequenceID),
            sequenceName: String(seq.name),
            tracks: tracks,
            clips: clips
        });
    } catch (e) {
        return pk_err(e);
    }
}

// ---------- applying ----------

function pk_qeSecs(t) {
    if (t === undefined || t === null) return NaN;
    if (typeof t === "number") return t;
    try {
        if (t.secs !== undefined) return Number(t.secs);
        if (t.ticks !== undefined) return Number(t.ticks) / PK_TICKS_PER_SEC;
    } catch (e) {}
    return parseFloat(String(t));
}

/** QE track items include "Empty" gaps, so match by start time + name. */
function pk_findQEItem(qeTrack, clip) {
    var n = qeTrack.numItems, fallback = null;
    for (var k = 0; k < n; k++) {
        var it = qeTrack.getItemAt(k);
        if (!it || it.type === "Empty") continue;
        var s = pk_qeSecs(it.start);
        if (Math.abs(s - clip.start.seconds) < 0.02) {
            if (it.name === clip.name) return it;
            if (!fallback) fallback = it;
        }
    }
    return fallback;
}

/**
 * Indexes shift when the editor adds/removes clips between a scan and an apply,
 * so confirm the clip by start time (+ name) and search the track if it moved.
 */
function pk_resolveClip(seq, trackIdx, clipIdx, expectStart, expectName) {
    var track = seq.audioTracks[trackIdx];
    if (!track) return null;
    var c = track.clips[clipIdx];
    if (expectStart === undefined || expectStart === null) return c ? { clip: c, index: clipIdx } : null;
    if (c && Math.abs(c.start.seconds - expectStart) < 0.01 && (!expectName || c.name === expectName)) {
        return { clip: c, index: clipIdx };
    }
    for (var i = 0; i < track.clips.numItems; i++) {
        var o = track.clips[i];
        if (Math.abs(o.start.seconds - expectStart) < 0.01 && (!expectName || o.name === expectName)) {
            return { clip: o, index: i };
        }
    }
    return null;
}

function pk_setProp(p, value) {
    try { if (p.isTimeVarying()) p.setTimeVarying(false); } catch (e) {}
    p.setValue(value, true);
}

/** Set one layer; a layer at ratio 1.0 is bypassed so it doesn't process the audio at all. */
function pk_setLayer(comp, ratio, label, log) {
    var pRatio = pk_findProp(comp, "transpose ratio");
    if (!pRatio) throw new Error("Pitch Shifter không có tham số Transpose Ratio.");
    pk_setProp(pRatio, pk_ratioToNorm(ratio));
    var neutral = Math.abs(ratio - 1) < 1e-4, pBypass = pk_bypassProp(comp), note = "";
    if (pBypass) {
        try { pk_setProp(pBypass, neutral); note = neutral ? " (bypass)" : ""; } catch (e) { note = " (không đặt được bypass)"; }
    }
    log.push(label + " ×" + pk_normToRatio(Number(pRatio.getValue())).toFixed(4) + note);
}

/**
 * Make sure the clip has the two plugin layers and set them.
 * masterRatio : Pitch Shifter #1 (track Master Pitch, 1.0 = none)
 * speedRatio  : Pitch Shifter #2 (speed compensation, 1 / speed)
 */
function pk_applyLayers(trackIdx, clipIdx, masterRatio, speedRatio, expectStart, expectName) {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return pk_err("Chưa mở sequence nào.");
        var hit = pk_resolveClip(seq, trackIdx, clipIdx, expectStart, expectName);
        if (!hit) return pk_err("Không tìm thấy clip (timeline vừa thay đổi?).");
        var clip = hit.clip;
        clipIdx = hit.index;

        var ps = pk_pitchShifters(clip), added = 0;
        // Pitch Shifters that existed before and are now taken over as plugin layers (to restore on Off).
        var takenOver = [];
        for (var o = 0; o < ps.length && o < PK_LAYERS; o++) takenOver.push(pk_layerState(ps[o]));
        if (ps.length < PK_LAYERS) {
            app.enableQE();
            var qeItem = pk_findQEItem(qe.project.getActiveSequence().getAudioTrackAt(trackIdx), clip);
            if (!qeItem) return pk_err("QE không tìm thấy clip '" + clip.name + "' trên track A" + (trackIdx + 1));
            var fx = qe.project.getAudioEffectByName(PK_EFFECT_NAME);
            if (!fx) return pk_err("Không tìm thấy effect '" + PK_EFFECT_NAME + "'.");
            for (var n = ps.length; n < PK_LAYERS; n++) {
                qeItem.addAudioEffect(fx);
                added++;
            }
            // Re-fetch: the component collection is refreshed after a QE edit.
            clip = seq.audioTracks[trackIdx].clips[clipIdx];
            ps = pk_pitchShifters(clip);
            if (ps.length < PK_LAYERS) return pk_err("Đã gọi addAudioEffect nhưng clip chỉ có " + ps.length + " Pitch Shifter.");
        }

        var log = [];
        pk_setLayer(ps[0], masterRatio, "#1 Master", log);
        pk_setLayer(ps[1], speedRatio, "#2 Speed", log);
        var nodeId = "";
        try { nodeId = String(clip.nodeId || ""); } catch (e3) {}
        return pk_ok({ added: added, takenOver: takenOver, nodeId: nodeId, log: log });
    } catch (e) {
        return pk_err(e);
    }
}

// ---------- removing (tool switched Off) ----------

/** Find a clip anywhere in a sequence: by nodeId first, then by track + start + name. */
function pk_locateClip(seq, nodeId, trackIdx, start, name) {
    var t, i, c;
    if (nodeId) {
        for (t = 0; t < seq.audioTracks.numTracks; t++) {
            for (i = 0; i < seq.audioTracks[t].clips.numItems; i++) {
                c = seq.audioTracks[t].clips[i];
                try { if (String(c.nodeId) === nodeId) return { clip: c, track: t, index: i }; } catch (e) {}
            }
        }
    }
    var hit = pk_resolveClip(seq, trackIdx, 0, start, name);
    return hit ? { clip: hit.clip, track: trackIdx, index: hit.index } : null;
}

/** Remove the n-th Pitch Shifter (0-based among Pitch Shifters) of a clip through QE. */
function pk_qeRemovePitchShifter(qeItem, nth) {
    var count = -1, n = qeItem.numComponents;
    for (var k = 0; k < n; k++) {
        var qc = qeItem.getComponentAt(k);
        if (!qc) continue;
        var nm = String(qc.name || "").toLowerCase();
        if (nm === PK_EFFECT_NAME.toLowerCase() || nm.indexOf("pitch shift") >= 0) {
            count++;
            if (count === nth) { qc.remove(); return true; }
        }
    }
    return false;
}

/**
 * Undo what the plugin did to one clip.
 * restore : layer states to write back into the first Pitch Shifters (ones the plugin took over)
 * added   : how many Pitch Shifters the plugin added after them (removed; bypassed if QE can't remove)
 */
function pk_cleanupClip(sequenceId, nodeId, trackIdx, start, name, restore, added) {
    try {
        var seq = app.project.activeSequence;
        // Only ever act on the sequence open on the timeline.
        if (!seq || String(seq.sequenceID) !== String(sequenceId)) return pk_ok({ status: "skipped", log: ["không phải sequence đang mở"] });
        var hit = pk_locateClip(seq, nodeId, trackIdx, start, name);
        if (!hit) return pk_ok({ status: "gone", log: ["clip không còn trên timeline"] });

        var ps = pk_pitchShifters(hit.clip), log = [], r;
        for (r = 0; r < restore.length && r < ps.length; r++) {
            var st = restore[r];
            var pRatio = pk_findProp(ps[r], "transpose ratio"), pBypass = pk_bypassProp(ps[r]);
            if (pRatio && st.ratio !== null) pk_setProp(pRatio, pk_ratioToNorm(st.ratio));
            if (pBypass && st.bypass !== null) pk_setProp(pBypass, !!st.bypass);
            log.push("khôi phục Pitch Shifter #" + (r + 1));
        }

        var first = restore.length, last = Math.min(ps.length, first + added) - 1, removed = 0, bypassed = 0;
        if (last >= first) {
            app.enableQE();
            var qeItem = pk_findQEItem(qe.project.getActiveSequence().getAudioTrackAt(hit.track), hit.clip);
            var clipStart = hit.clip.start.seconds, clipName = hit.clip.name;
            // Highest index first so earlier positions don't shift.
            for (var n = last; n >= first; n--) {
                var before = pk_pitchShifters(hit.clip).length, ok = false;
                try { ok = qeItem ? pk_qeRemovePitchShifter(qeItem, n) : false; } catch (e1) { ok = false; }
                var clipNow = pk_locateClip(seq, nodeId, hit.track, clipStart, clipName);
                if (clipNow) hit.clip = clipNow.clip;
                if (ok && pk_pitchShifters(hit.clip).length < before) {
                    removed++;
                } else {
                    // QE removal unavailable: neutralise the layer instead.
                    var comp = pk_pitchShifters(hit.clip)[n];
                    if (comp) { pk_setLayer(comp, 1, "#" + (n + 1), []); bypassed++; }
                }
            }
            if (removed) log.push("xoá " + removed + " Pitch Shifter");
            if (bypassed) log.push(bypassed + " Pitch Shifter không xoá được → đặt ×1.0 + bypass");
        }
        return pk_ok({ status: bypassed ? "bypassed" : "removed", log: log });
    } catch (e) {
        return pk_err(e);
    }
}

/** Debug: what the QE track item / components expose in this Premiere build. */
function pk_reflectQE(trackIdx, clipIdx) {
    try {
        var clip = app.project.activeSequence.audioTracks[trackIdx].clips[clipIdx];
        app.enableQE();
        var qeItem = pk_findQEItem(qe.project.getActiveSequence().getAudioTrackAt(trackIdx), clip);
        if (!qeItem) return pk_err("QE không tìm thấy clip.");
        var out = { item: String(qeItem.reflect.methods), components: [] };
        for (var k = 0; k < qeItem.numComponents; k++) {
            var qc = qeItem.getComponentAt(k);
            out.components.push({ name: String(qc.name), methods: String(qc.reflect.methods) });
        }
        return pk_ok(out);
    } catch (e) {
        return pk_err(e);
    }
}

/** Debug: list components / properties of a clip. */
function pk_dumpComponents(trackIdx, clipIdx) {
    try {
        var clip = app.project.activeSequence.audioTracks[trackIdx].clips[clipIdx];
        var out = [];
        for (var k = 0; k < clip.components.numItems; k++) {
            var comp = clip.components[k], props = [];
            for (var j = 0; j < comp.properties.numItems; j++) {
                var p = comp.properties[j], val = null;
                try { val = String(p.getValue()); } catch (e1) {}
                props.push({ name: p.displayName, value: val });
            }
            out.push({ name: comp.displayName, matchName: comp.matchName, props: props });
        }
        return pk_ok(out);
    } catch (e) {
        return pk_err(e);
    }
}

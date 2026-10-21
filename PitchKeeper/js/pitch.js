/*
 * Pitch Keeper — pitch analysis (runs in the CEP panel, Node.js enabled).
 * Decodes the clip's source segment with ffmpeg (or Web Audio as fallback)
 * and estimates the voice fundamental frequency (F0) with the YIN algorithm.
 */
(function (root) {
    "use strict";

    var ANALYSIS_SR = 16000;
    var MAX_SECONDS = 60;

    function nodeRequire(name) {
        if (typeof window !== "undefined" && window.cep_node) return window.cep_node.require(name);
        return require(name);
    }

    function findFfmpeg() {
        var fs = nodeRequire("fs");
        var candidates = ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"];
        for (var i = 0; i < candidates.length; i++) {
            if (fs.existsSync(candidates[i])) return candidates[i];
        }
        return null;
    }

    /** Mono Float32 PCM at ANALYSIS_SR for [startSec, startSec+durSec) of a media file. */
    function decodeWithFfmpeg(ffmpeg, path, startSec, durSec) {
        var cp = nodeRequire("child_process");
        var args = ["-v", "error", "-ss", String(Math.max(0, startSec)), "-t", String(durSec),
            "-i", path, "-vn", "-ac", "1", "-ar", String(ANALYSIS_SR), "-f", "f32le", "-"];
        return new Promise(function (resolve, reject) {
            cp.execFile(ffmpeg, args, { encoding: "buffer", maxBuffer: 512 * 1024 * 1024 }, function (err, stdout, stderr) {
                if (err) return reject(new Error("ffmpeg: " + (stderr ? stderr.toString() : err.message)));
                var buf = Buffer.from(stdout);
                var ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + (buf.length - buf.length % 4));
                resolve(new Float32Array(ab));
            });
        });
    }

    function decodeWithWebAudio(path, startSec, durSec) {
        var fs = nodeRequire("fs");
        var data = fs.readFileSync(path);
        var ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.length);
        var Ctx = window.AudioContext || window.webkitAudioContext;
        var ctx = new Ctx();
        return ctx.decodeAudioData(ab).then(function (audio) {
            ctx.close();
            var sr = audio.sampleRate;
            var a = Math.floor(startSec * sr), b = Math.min(audio.length, Math.floor((startSec + durSec) * sr));
            var n = Math.max(0, b - a), mono = new Float32Array(n);
            for (var ch = 0; ch < audio.numberOfChannels; ch++) {
                var d = audio.getChannelData(ch);
                for (var i = 0; i < n; i++) mono[i] += d[a + i] / audio.numberOfChannels;
            }
            return resample(mono, sr, ANALYSIS_SR);
        });
    }

    /** Box-filter decimation; good enough for F0 in the 60–500 Hz band. */
    function resample(x, srIn, srOut) {
        if (srIn === srOut) return x;
        var ratio = srIn / srOut, n = Math.floor(x.length / ratio), y = new Float32Array(n);
        for (var i = 0; i < n; i++) {
            var a = Math.floor(i * ratio), b = Math.max(a + 1, Math.floor((i + 1) * ratio)), s = 0;
            for (var j = a; j < b; j++) s += x[j];
            y[i] = s / (b - a);
        }
        return y;
    }

    function decodeSegment(path, startSec, durSec) {
        durSec = Math.min(durSec, MAX_SECONDS);
        var ffmpeg = findFfmpeg();
        if (ffmpeg) return decodeWithFfmpeg(ffmpeg, path, startSec, durSec);
        return decodeWithWebAudio(path, startSec, durSec);
    }

    /** YIN on one frame. Returns F0 in Hz or 0 if unvoiced. */
    function yinFrame(x, off, W, tauMin, tauMax, threshold, sr, d) {
        var tau, j;
        d[0] = 1;
        for (tau = 1; tau <= tauMax; tau++) {
            var s = 0;
            for (j = 0; j < W; j++) {
                var diff = x[off + j] - x[off + j + tau];
                s += diff * diff;
            }
            d[tau] = s;
        }
        // Cumulative mean normalized difference
        var running = 0;
        for (tau = 1; tau <= tauMax; tau++) {
            running += d[tau];
            d[tau] = running > 0 ? d[tau] * tau / running : 1;
        }
        var best = -1;
        for (tau = tauMin; tau <= tauMax; tau++) {
            if (d[tau] < threshold) {
                while (tau + 1 <= tauMax && d[tau + 1] < d[tau]) tau++;
                best = tau;
                break;
            }
        }
        if (best < 0) return 0;
        // Parabolic interpolation around the minimum
        var t = best;
        if (t > 1 && t < tauMax) {
            var a = d[t - 1], b = d[t], c = d[t + 1], den = a - 2 * b + c;
            if (den !== 0) t = t + 0.5 * (a - c) / den;
        }
        return sr / t;
    }

    /**
     * Estimate the median F0 of a signal.
     * Returns { f0, voicedFrames, totalFrames, track: [Hz,...] }.
     */
    function estimatePitch(x, sr, opts) {
        opts = opts || {};
        var minF0 = opts.minF0 || 60, maxF0 = opts.maxF0 || 500, threshold = opts.threshold || 0.15;
        var tauMin = Math.floor(sr / maxF0), tauMax = Math.ceil(sr / minF0);
        var W = tauMax, hop = Math.floor(sr * 0.02);
        var d = new Float32Array(tauMax + 1);

        var frames = [], peak = 0, off, j;
        for (off = 0; off + W + tauMax < x.length; off += hop) {
            var e = 0;
            for (j = 0; j < W; j++) e += x[off + j] * x[off + j];
            var rms = Math.sqrt(e / W);
            frames.push({ off: off, rms: rms });
            if (rms > peak) peak = rms;
        }
        var gate = peak * Math.pow(10, -30 / 20); // ignore frames 30 dB below the loudest
        var track = [];
        for (var f = 0; f < frames.length; f++) {
            if (frames[f].rms < gate || frames[f].rms < 1e-4) continue;
            var hz = yinFrame(x, frames[f].off, W, tauMin, tauMax, threshold, sr, d);
            if (hz >= minF0 && hz <= maxF0) track.push(hz);
        }
        return { f0: median(track), voicedFrames: track.length, totalFrames: frames.length, track: track };
    }

    function median(arr) {
        if (!arr.length) return 0;
        var s = arr.slice().sort(function (a, b) { return a - b; }), m = s.length >> 1;
        return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    }

    var NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
    function noteName(hz) {
        if (!(hz > 0)) return "—";
        var midi = 69 + 12 * Math.log(hz / 440) / Math.LN2, r = Math.round(midi);
        var cents = Math.round((midi - r) * 100);
        return NOTES[((r % 12) + 12) % 12] + (Math.floor(r / 12) - 1) + (cents ? (cents > 0 ? " +" : " ") + cents + "¢" : "");
    }

    /** Analyse a clip's source segment (source time, unaffected by speed). */
    function analyzeClip(clip) {
        var dur = Math.max(0.1, clip.outSec - clip.inSec);
        return decodeSegment(clip.path, clip.inSec, dur).then(function (pcm) {
            return estimatePitch(pcm, ANALYSIS_SR);
        });
    }

    var api = {
        ANALYSIS_SR: ANALYSIS_SR,
        decodeSegment: decodeSegment,
        estimatePitch: estimatePitch,
        analyzeClip: analyzeClip,
        noteName: noteName,
        findFfmpeg: findFfmpeg
    };
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    root.PitchKeeper = api;
})(typeof window !== "undefined" ? window : this);

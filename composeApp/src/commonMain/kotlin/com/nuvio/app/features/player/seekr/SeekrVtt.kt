package com.nuvio.app.features.player.seekr

/** One thumbnail: the sheet it lives in and its crop rectangle, for [startMs, endMs). */
internal data class SeekPreviewCue(
    val startMs: Long,
    val endMs: Long,
    val sheetUrl: String,
    val x: Int,
    val y: Int,
    val width: Int,
    val height: Int,
)

/** A loaded preview track for the current title. */
internal class SeekPreviewTrack(
    val cues: List<SeekPreviewCue>,
    /** Client duration / source duration, as returned by Seekr. */
    val scale: Double,
) {
    val sheetUrls: List<String> = cues.map { it.sheetUrl }.distinct()

    /** Cue for a playback position in the video being played, or null. */
    fun cueAt(positionMs: Long): SeekPreviewCue? {
        if (cues.isEmpty()) return null
        val sourceMs = (positionMs / scale).toLong()
        var lo = 0
        var hi = cues.lastIndex
        var best = 0
        while (lo <= hi) {
            val mid = (lo + hi) ushr 1
            if (cues[mid].startMs <= sourceMs) {
                best = mid
                lo = mid + 1
            } else {
                hi = mid - 1
            }
        }
        return cues[best]
    }
}

internal object SeekrVttParser {
    fun parse(vtt: String, baseUrl: String): List<SeekPreviewCue> {
        val lines = vtt.replace("\r\n", "\n").replace('\r', '\n').split('\n')
        val cues = ArrayList<SeekPreviewCue>()
        var i = 0
        while (i < lines.size) {
            val line = lines[i].trim()
            val arrow = line.indexOf("-->")
            if (arrow < 0) {
                i++
                continue
            }
            val start = parseTimestamp(line.substring(0, arrow).trim())
            val end = parseTimestamp(line.substring(arrow + 3).trim().substringBefore(' '))
            // Payload is the next non-empty line.
            var j = i + 1
            while (j < lines.size && lines[j].isBlank()) j++
            if (start != null && end != null && j < lines.size) {
                parsePayload(lines[j].trim(), baseUrl)?.let { (url, rect) ->
                    cues += SeekPreviewCue(start, end, url, rect[0], rect[1], rect[2], rect[3])
                }
            }
            i = j + 1
        }
        cues.sortBy { it.startMs }
        return cues
    }

    private fun parsePayload(payload: String, baseUrl: String): Pair<String, IntArray>? {
        val hashIndex = payload.lastIndexOf("#xywh=")
        if (hashIndex < 0) return null
        val rawUrl = payload.substring(0, hashIndex)
        val rect = payload.substring(hashIndex + 6).split(',').mapNotNull { it.trim().toIntOrNull() }
        if (rect.size != 4 || rect[2] <= 0 || rect[3] <= 0) return null
        return resolve(rawUrl, baseUrl) to rect.toIntArray()
    }

    private fun resolve(url: String, baseUrl: String): String {
        if (url.startsWith("http://") || url.startsWith("https://")) return url
        val origin = baseUrl.substringBefore("://") + "://" +
            baseUrl.substringAfter("://").substringBefore('/')
        if (url.startsWith("/")) return origin + url
        val dir = baseUrl.substringBefore('?').substringBeforeLast('/')
        return "$dir/$url"
    }

    /** Accepts "HH:MM:SS.mmm" and "MM:SS.mmm". */
    internal fun parseTimestamp(text: String): Long? {
        val parts = text.split(':')
        if (parts.size !in 2..3) return null
        val secParts = parts.last().split('.', ',')
        val seconds = secParts[0].toLongOrNull() ?: return null
        val millis = secParts.getOrNull(1)?.padEnd(3, '0')?.take(3)?.toLongOrNull() ?: 0L
        val minutes = parts[parts.size - 2].toLongOrNull() ?: return null
        val hours = if (parts.size == 3) parts[0].toLongOrNull() ?: return null else 0L
        return ((hours * 60 + minutes) * 60 + seconds) * 1000 + millis
    }
}

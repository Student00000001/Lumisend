package com.lumisend.app.types

import java.io.Serializable

data class CodeSettings(
    val gridWidth: Int = 48,
    val gridHeight: Int = 36,
    val frameRate: Int = 6,
    val colorMode: String = "mono" // "mono" or "color"
) : Serializable

data class TransitFrame(
    val frameIndex: Int,
    val totalFrames: Int,
    val fileSalt: Int,
    val payloadLength: Int,
    val fileName: String,
    val payload: ByteArray,
    var checksum: Int = 0,
    val compressionFlag: Int = 0,
    val originalFileSize: Int = 0
) : Serializable {
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (javaClass != other?.javaClass) return false
        other as TransitFrame
        return frameIndex == other.frameIndex && fileSalt == other.fileSalt
    }

    override fun hashCode(): Int {
        var result = frameIndex
        result = 31 * result + fileSalt
        return result
    }
}

data class ReceiverState(
    val fileSalt: Int,
    var fileName: String,
    var fileSize: Int,
    var fileType: String,
    val totalFrames: Int,
    var receivedCount: Int,
    var completed: Boolean,
    val frames: MutableMap<Int, ByteArray> = mutableMapOf(),
    var compressionFlag: Int = 0,
    var originalFileSize: Int = 0
)

data class LogMessage(
    val id: String,
    val time: String,
    val type: String, // "info" | "success" | "warning" | "error"
    val text: String
)

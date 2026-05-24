package com.lumisend.app.utils

import com.lumisend.app.types.CodeSettings
import com.lumisend.app.types.TransitFrame
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.util.zip.GZIPInputStream
import java.util.zip.GZIPOutputStream

/**
 * CRC16 Checksum generator (CCITT-FALSE standard)
 */
fun calculateCRC16(data: ByteArray): Int {
    var crc = 0xFFFF
    for (b in data) {
        crc = crc xor ((b.toInt() and 0xFF) shl 8)
        for (j in 0 until 8) {
            if ((crc and 0x8000) != 0) {
                crc = ((crc shl 1) xor 0x1021) and 0xFFFF
            } else {
                crc = (crc shl 1) and 0xFFFF
            }
        }
    }
    return crc
}

/**
 * Calculate how many data bytes can fit inside a grid of given settings
 */
fun getDataCapacityBytes(settings: CodeSettings): Int {
    val totalCells = settings.gridWidth * settings.gridHeight
    
    // Corner marks overhead counts 
    val topLeftReserved = 7 * 7
    val topRightReserved = 3 * 3
    val bottomLeftReserved = 3 * 3
    val bottomRightReserved = 3 * 3
    val reservedCells = topLeftReserved + topRightReserved + bottomLeftReserved + bottomRightReserved
    
    val dataCells = totalCells - reservedCells
    return if (settings.colorMode == "color") {
        (dataCells * 3) / 8
    } else {
        dataCells / 8
    }
}

/**
 * Gzip compression
 */
fun compressBytes(data: ByteArray): ByteArray {
    val bos = ByteArrayOutputStream()
    try {
        GZIPOutputStream(bos).use { gzos ->
            gzos.write(data)
        }
    } catch (e: Exception) {
        return data
    }
    return bos.toByteArray()
}

/**
 * Gzip decompression
 */
fun decompressBytes(data: ByteArray): ByteArray {
    val bis = ByteArrayInputStream(data)
    val bos = ByteArrayOutputStream()
    GZIPInputStream(bis).use { gzis ->
        val buffer = ByteArray(1024)
        var len: Int
        while (gzis.read(buffer).also { len = it } > 0) {
            bos.write(buffer, 0, len)
        }
    }
    return bos.toByteArray()
}

/**
 * Serialize frame elements
 */
fun serializeFrame(frame: TransitFrame, settings: CodeSettings): ByteArray {
    val totalCapacity = getDataCapacityBytes(settings)
    val dataBytes = ByteArray(totalCapacity)
    
    dataBytes[0] = 0xEB.toByte()
    dataBytes[1] = 0x90.toByte()
    dataBytes[2] = frame.fileSalt.toByte()
    dataBytes[3] = ((frame.frameIndex shr 8) and 0xFF).toByte()
    dataBytes[4] = (frame.frameIndex and 0xFF).toByte()
    dataBytes[5] = ((frame.totalFrames shr 8) and 0xFF).toByte()
    dataBytes[6] = (frame.totalFrames and 0xFF).toByte()
    
    if (frame.frameIndex == 0) {
        dataBytes[7] = frame.compressionFlag.toByte()
        
        val size = frame.originalFileSize
        dataBytes[8] = ((size shr 24) and 0xFF).toByte()
        dataBytes[9] = ((size shr 16) and 0xFF).toByte()
        dataBytes[10] = ((size shr 8) and 0xFF).toByte()
        dataBytes[11] = (size and 0xFF).toByte()
        
        dataBytes[12] = ((frame.payloadLength shr 8) and 0xFF).toByte()
        dataBytes[13] = (frame.payloadLength and 0xFF).toByte()
        
        val cleanName = frame.fileName.replace(Regex("[^\\x00-\\x7F]"), "")
        val nameBytes = cleanName.toByteArray(Charsets.US_ASCII)
        val nameLen = Math.min(nameBytes.size, 255)
        dataBytes[14] = nameLen.toByte()
        
        for (i in 0 until nameLen) {
            dataBytes[15 + i] = nameBytes[i]
        }
        
        val payloadOffset = 15 + nameLen
        for (i in 0 until frame.payloadLength) {
            if (payloadOffset + i < totalCapacity - 2) {
                dataBytes[payloadOffset + i] = frame.payload[i]
            }
        }
    } else {
        dataBytes[7] = ((frame.payloadLength shr 8) and 0xFF).toByte()
        dataBytes[8] = (frame.payloadLength and 0xFF).toByte()
        
        val payloadOffset = 9
        for (i in 0 until frame.payloadLength) {
            if (payloadOffset + i < totalCapacity - 2) {
                dataBytes[payloadOffset + i] = frame.payload[i]
            }
        }
    }
    
    // Inject local frame checksum values
    val crcOffset = totalCapacity - 2
    dataBytes[crcOffset] = ((frame.checksum shr 8) and 0xFF).toByte()
    dataBytes[crcOffset + 1] = (frame.checksum and 0xFF).toByte()
    
    return dataBytes
}

/**
 * Deserialize a raw byte array back to frame fields
 */
fun deserializeFrame(data: ByteArray, settings: CodeSettings): TransitFrame? {
    val totalCapacity = getDataCapacityBytes(settings)
    if (data.size < totalCapacity) return null
    if (data[0] != 0xEB.toByte() || data[1] != 0x90.toByte()) return null
    
    val fileSalt = data[2].toInt() and 0xFF
    val frameIndex = ((data[3].toInt() and 0xFF) shl 8) or (data[4].toInt() and 0xFF)
    val totalFrames = ((data[5].toInt() and 0xFF) shl 8) or (data[6].toInt() and 0xFF)
    
    if (totalFrames == 0 || frameIndex >= totalFrames) return null
    
    val crcOffset = totalCapacity - 2
    val rxCRC = ((data[crcOffset].toInt() and 0xFF) shl 8) or (data[crcOffset + 1].toInt() and 0xFF)
    
    val bytesToVerify = data.copyOfRange(0, crcOffset)
    val computedCRC = calculateCRC16(bytesToVerify)
    if (rxCRC != computedCRC) {
        return null // CRC check failed
    }
    
    var payloadLength = 0
    var fileName = ""
    var payload = ByteArray(0)
    var compressionFlag = 0
    var originalFileSize = 0
    
    if (frameIndex == 0) {
        compressionFlag = data[7].toInt() and 0xFF
        originalFileSize = ((data[8].toInt() and 0xFF) shl 24) or
                           ((data[9].toInt() and 0xFF) shl 16) or
                           ((data[10].toInt() and 0xFF) shl 8) or
                           (data[11].toInt() and 0xFF)
        payloadLength = ((data[12].toInt() and 0xFF) shl 8) or (data[13].toInt() and 0xFF)
        val fileNameLen = data[14].toInt() and 0xFF
        
        if (15 + fileNameLen + payloadLength > totalCapacity) return null
        
        fileName = String(data.copyOfRange(15, 15 + fileNameLen), Charsets.US_ASCII)
        payload = data.copyOfRange(15 + fileNameLen, 15 + fileNameLen + payloadLength)
    } else {
        payloadLength = ((data[7].toInt() and 0xFF) shl 8) or (data[8].toInt() and 0xFF)
        if (9 + payloadLength > totalCapacity) return null
        payload = data.copyOfRange(9, 9 + payloadLength)
    }
    
    return TransitFrame(
        frameIndex = frameIndex,
        totalFrames = totalFrames,
        fileSalt = fileSalt,
        payloadLength = payloadLength,
        fileName = fileName,
        payload = payload,
        checksum = rxCRC,
        compressionFlag = compressionFlag,
        originalFileSize = originalFileSize
    )
}

/**
 * Pack flat file contents into TransitFrame nodes
 */
fun packFileIntoFrames(
    fileName: String,
    fileData: ByteArray,
    settings: CodeSettings
): List<TransitFrame> {
    val compressed = compressBytes(fileData)
    val useCompression = compressed.size < fileData.size
    val dataToPack = if (useCompression) compressed else fileData
    val compressionFlag = if (useCompression) 1 else 0
    val originalFileSize = fileData.size

    val totalCapacity = getDataCapacityBytes(settings)
    
    val maxFieldNameLength = Math.min(32, Math.max(1, totalCapacity - 20))
    val cleanName = fileName.replace(Regex("[^\\x00-\\x7F]"), "").take(maxFieldNameLength)
    
    val header0Size = 15 + cleanName.length
    val maxPayload0 = totalCapacity - header0Size - 2
    
    val headerNSize = 9
    val maxPayloadN = totalCapacity - headerNSize - 2
    
    if (maxPayload0 <= 0 || maxPayloadN <= 0) {
        throw Exception("Grid dimensions too small for header sizes.")
    }
    
    val fileSalt = (1..250).random()
    val frames = mutableListOf<TransitFrame>()
    var bytesPacked = 0
    var remainingBytes = dataToPack.size
    
    var totalFrames = 1
    if (remainingBytes > maxPayload0) {
        val overflow = remainingBytes - maxPayload0
        totalFrames += Math.ceil(overflow.toDouble() / maxPayloadN).toInt()
    }
    
    // Pack initial frame
    val p0Length = Math.min(remainingBytes, maxPayload0)
    val p0 = dataToPack.copyOfRange(0, p0Length)
    bytesPacked += p0Length
    remainingBytes -= p0Length
    
    frames.add(TransitFrame(
        frameIndex = 0,
        totalFrames = totalFrames,
        fileSalt = fileSalt,
        payloadLength = p0Length,
        fileName = cleanName,
        payload = p0,
        compressionFlag = compressionFlag,
        originalFileSize = originalFileSize
    ))
    
    // Pack secondary overflow chapters
    for (i in 1 until totalFrames) {
        val pNLength = Math.min(remainingBytes, maxPayloadN)
        val pN = dataToPack.copyOfRange(bytesPacked, bytesPacked + pNLength)
        bytesPacked += pNLength
        remainingBytes -= pNLength
        
        frames.add(TransitFrame(
            frameIndex = i,
            totalFrames = totalFrames,
            fileSalt = fileSalt,
            payloadLength = pNLength,
            fileName = cleanName,
            payload = pN,
            compressionFlag = compressionFlag,
            originalFileSize = originalFileSize
        ))
    }
    
    // Calculate CCITT checks 
    for (frame in frames) {
        val serialized = serializeFrame(frame, settings)
        frame.checksum = calculateCRC16(serialized.copyOfRange(0, serialized.size - 2))
    }
    
    return frames
}

/**
 * Checks if a grid coordinate is part of reserved corner markings
 */
fun isReservedCell(x: Int, y: Int, w: Int, h: Int): Boolean {
    if (x < 7 && y < 7) return true
    if (x >= w - 3 && y < 3) return true
    if (x < 3 && y >= h - 3) return true
    if (x >= w - 3 && y >= h - 3) return true
    return false
}

/**
 * Map frame contents to 2D binary int matrix (each cell represents color value from 0 to 7)
 */
fun createGridFromFrame(frame: TransitFrame, settings: CodeSettings): Array<IntArray> {
    val w = settings.gridWidth
    val h = settings.gridHeight
    val grid = Array(h) { IntArray(w) { 0 } }
    
    // Top Left alignment shapes (7x7 thick L inverted)
    for (y in 0 until 7) {
        for (x in 0 until 7) {
            if (y < 2 || x < 2) {
                grid[y][x] = 7 // Solid dark standard
            } else {
                grid[y][x] = 0 // Quiet zone buffer
            }
        }
    }
    
    // Top Right positioning check (3x3 block)
    for (y in 0 until 3) {
        for (x in w - 3 until w) {
            grid[y][x] = 7
        }
    }
    
    // Bottom Left block (3x3 block)
    for (y in h - 3 until h) {
        for (x in 0 until 3) {
            grid[y][x] = 7
        }
    }
    
    // Bottom Right asymmetric signature (3x3 cross)
    for (y in h - 3 until h) {
        for (x in w - 3 until w) {
            val rx = x - (w - 3)
            val ry = y - (h - 3)
            if (rx == 1 || ry == 1) {
                grid[y][x] = 7
            } else {
                grid[y][x] = 0
            }
        }
    }
    
    val serialized = serializeFrame(frame, settings)
    val bits = BooleanArray(serialized.size * 8)
    var bitIdx = 0
    for (byte in serialized) {
        val byteVal = byte.toInt() and 0xFF
        for (bit in 7 downTo 0) {
            bits[bitIdx++] = ((byteVal shr bit) and 1) == 1
        }
    }
    
    var writeBitIdx = 0
    for (y in 0 until h) {
        for (x in 0 until w) {
            if (!isReservedCell(x, y, w, h)) {
                if (settings.colorMode == "color") {
                    var cellVal = 0
                    for (bitOfCell in 0 until 3) {
                        val hasBit = if (writeBitIdx < bits.size) bits[writeBitIdx] else false
                        val mask = (x + y + bitOfCell) % 2 == 0
                        val finalBit = hasBit xor mask
                        if (finalBit) {
                            cellVal = cellVal or (1 shl (2 - bitOfCell))
                        }
                        writeBitIdx++
                    }
                    grid[y][x] = cellVal
                } else {
                    if (writeBitIdx < bits.size) {
                        val rawBit = if (bits[writeBitIdx]) 1 else 0
                        val mask = if ((x + y) % 2 == 0) 1 else 0
                        grid[y][x] = if ((rawBit xor mask) == 1) 7 else 0
                        writeBitIdx++
                    } else {
                        grid[y][x] = if ((x + y) % 2 == 0) 7 else 0
                    }
                }
            }
        }
    }
    
    return grid
}

/**
 * Decode frame matrix straight back to field items
 */
fun decodeFrameFromGrid(grid: Array<IntArray>, settings: CodeSettings): TransitFrame? {
    val w = settings.gridWidth
    val h = settings.gridHeight
    if (grid.size < h || grid[0].size < w) return null
    
    val bits = ArrayList<Boolean>()
    for (y in 0 until h) {
        for (x in 0 until w) {
            if (!isReservedCell(x, y, w, h)) {
                val cellVal = grid[y][x]
                if (settings.colorMode == "color") {
                    for (bitOfCell in 0 until 3) {
                        val valBit = ((cellVal shr (2 - bitOfCell)) and 1) == 1
                        val mask = (x + y + bitOfCell) % 2 == 0
                        bits.add(valBit xor mask)
                    }
                } else {
                    val isActive = cellVal >= 4
                    val mask = (x + y) % 2 == 0
                    bits.add(isActive xor mask)
                }
            }
        }
    }
    
    val totalCapacity = getDataCapacityBytes(settings)
    val dataBytes = ByteArray(totalCapacity)
    for (i in 0 until totalCapacity) {
        var byteVal = 0
        for (bit in 0 until 8) {
            val bitIdx = i * 8 + bit
            if (bitIdx < bits.size && bits[bitIdx]) {
                byteVal = byteVal or (1 shl (7 - bit))
            }
        }
        dataBytes[i] = byteVal.toByte()
    }
    
    return deserializeFrame(dataBytes, settings)
}

package com.lumisend.app.ui

import android.Manifest
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.media.AudioManager
import android.media.ToneGenerator
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CameraAlt
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import com.google.zxing.BarcodeFormat
import com.google.zxing.qrcode.QRCodeWriter
import com.lumisend.app.types.CodeSettings
import com.lumisend.app.types.LogMessage
import com.lumisend.app.types.ReceiverState
import com.lumisend.app.utils.decodeFrameFromGrid
import com.lumisend.app.utils.decompressBytes
import com.lumisend.app.utils.isReservedCell
import java.io.File
import java.io.FileOutputStream
import java.text.SimpleDateFormat
import java.util.*
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun OpticalDecoderScreen() {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current

    var settings by remember { mutableStateOf(CodeSettings()) }
    var hasCameraPermission by remember {
        mutableStateOf(
            ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED
        )
    }

    val launcher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.RequestPermission()
    ) { isGranted ->
        hasCameraPermission = isGranted
    }

    LaunchedEffect(Unit) {
        if (!hasCameraPermission) {
            launcher.launch(Manifest.permission.CAMERA)
        }
    }

    // Active logging state
    val logs = remember { mutableStateListOf<LogMessage>() }
    fun addLog(type: String, text: String) {
        val time = SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(Date())
        logs.add(0, LogMessage(UUID.randomUUID().toString(), time, type, text))
    }

    // Tone feedback sound
    val toneGenerator = remember { ToneGenerator(AudioManager.STREAM_MUSIC, 45) }
    fun playBeep(freq: Int = 800) {
        try {
            toneGenerator.startTone(ToneGenerator.TONE_PROP_BEEP, 55)
        } catch (_: Exception) {}
    }

    // Receiver assembling states
    var rxState by remember { mutableStateOf<ReceiverState?>(null) }
    var assembledFile by remember { mutableStateOf<File?>(null) }
    var binarizedBmp by remember { mutableStateOf<Bitmap?>(null) }

    val cameraExecutor = remember { Executors.newSingleThreadExecutor() }

    // Flush cache
    fun flushDecoder() {
        rxState = null
        assembledFile = null
        binarizedBmp = null
        addLog("info", "Decoder pipelines flushed and reset. Ready to accept transmission.")
    }

    // Process parsed frame logic
    fun handleParsedFrame(frame: com.lumisend.app.types.TransitFrame) {
        val salt = frame.fileSalt
        val idx = frame.frameIndex
        val total = frame.totalFrames

        var current = rxState
        if (current == null || current.fileSalt != salt) {
            val initialName = if (idx == 0) frame.fileName else "optical_rx_$salt.bin"
            current = ReceiverState(
                fileSalt = salt,
                fileName = initialName,
                fileSize = if (idx == 0) frame.originalFileSize else 0,
                fileType = "application/octet-stream",
                totalFrames = total,
                receivedCount = 0,
                completed = false,
                compressionFlag = if (idx == 0) frame.compressionFlag else 0,
                originalFileSize = if (idx == 0) frame.originalFileSize else 0
            )
            assembledFile = null
            addLog("success", "Optical transmission link connected [Salt ID: $salt]. Cache initialized.")
        }

        if (idx == 0) {
            current.fileName = frame.fileName
            current.compressionFlag = frame.compressionFlag
            current.originalFileSize = frame.originalFileSize
        }

        if (!current.frames.containsKey(idx)) {
            current.frames[idx] = frame.payload
            current.receivedCount = current.frames.size
            rxState = current.copy() // For trigger Compose re-layout

            playBeep(700 + idx * 30)
            addLog("info", "Parsed packet frame PART ${idx + 1}/$total. [CRC16 Valid]")

            // Final completion verification
            if (current.receivedCount == total && !current.completed) {
                current.completed = true
                rxState = current.copy()
                
                // Assemble bytes
                try {
                    addLog("success", "All packets gathered. Reconstructing byte streams...")
                    var flatSize = 0
                    for (i in 0 until total) {
                        flatSize += current.frames[i]?.size ?: 0
                    }
                    var flatBytes = ByteArray(flatSize)
                    var offset = 0
                    for (i in 0 until total) {
                        val payloadPart = current.frames[i] ?: ByteArray(0)
                        payloadPart.copyInto(flatBytes, offset)
                        offset += payloadPart.size
                    }

                    if (current.compressionFlag == 1) {
                        addLog("info", "Decompressing GZIP raw channels natively...")
                        flatBytes = decompressBytes(flatBytes)
                    }

                    // Save file to app cache folder to preview & share
                    val outDir = context.cacheDir
                    val out = File(outDir, current.fileName)
                    FileOutputStream(out).use { stream ->
                        stream.write(flatBytes)
                    }
                    assembledFile = out
                    addLog("success", "Assembled file \"${current.fileName}\" successfully! (${flatBytes.size} bytes)")
                } catch (e: Exception) {
                    addLog("error", "Failed assembling payload packets: ${e.message}")
                }
            }
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(Color(0xFF030712)) // Dark BG
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        // Upper scanner card
        Card(
            modifier = Modifier
                .fillMaxWidth()
                .weight(1.3f),
            colors = CardDefaults.cardColors(containerColor = Color(0xFF111827)),
            border = BoxBorder(Color(0xFF1F2937))
        ) {
            Box(modifier = Modifier.fillMaxSize()) {
                if (hasCameraPermission) {
                    // Camera view container
                    AndroidView(
                        factory = { ctx ->
                            val previewView = PreviewView(ctx).apply {
                                scaleType = PreviewView.ScaleType.FILL_CENTER
                            }
                            val cameraProviderFuture = ProcessCameraProvider.getInstance(ctx)
                            cameraProviderFuture.addListener({
                                val cameraProvider = cameraProviderFuture.get()
                                val preview = Preview.Builder().build().also {
                                    it.setSurfaceProvider(previewView.surfaceProvider)
                                }

                                val imageAnalyzer = ImageAnalysis.Builder()
                                    .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_INITIAL_PROMISE)
                                    .build()
                                    .also {
                                        it.setAnalyzer(cameraExecutor) { imageProxy ->
                                            processImageProxy(imageProxy, settings) { frame, binarized ->
                                                binarizedBmp = binarized
                                                if (frame != null) {
                                                    handleParsedFrame(frame)
                                                }
                                            }
                                        }
                                    }

                                try {
                                    cameraProvider.unbindAll()
                                    cameraProvider.bindToLifecycle(
                                        lifecycleOwner,
                                        CameraSelector.DEFAULT_BACK_CAMERA,
                                        preview,
                                        imageAnalyzer
                                    )
                                } catch (_: Exception) {}
                            }, ContextCompat.getMainExecutor(ctx))
                            previewView
                        },
                        modifier = Modifier.fillMaxSize()
                    )

                    // Overlay 4:3 reticle guidance
                    Box(
                        modifier = Modifier
                            .fillMaxSize()
                            .padding(24.dp),
                        contentAlignment = Alignment.Center
                    ) {
                        Box(
                            modifier = Modifier
                                .fillMaxWidth(0.65f)
                                .aspectRatio(4f / 3f)
                                .border(2.dp, Color.White.copy(alpha = 0.6f), RoundedCornerShape(4.dp))
                        ) {
                            Text(
                                "ALIGN LINK GRID",
                                fontSize = 9.sp,
                                color = Color.White,
                                fontWeight = FontWeight.SemiBold,
                                modifier = Modifier
                                    .align(Alignment.TopCenter)
                                    .padding(top = 8.dp)
                                    .background(Color.Black.copy(alpha = 0.5f), RoundedCornerShape(2.dp))
                                    .padding(horizontal = 4.dp, vertical = 2.dp)
                            )
                        }
                    }
                } else {
                    Box(
                        modifier = Modifier.fillMaxSize(),
                        contentAlignment = Alignment.Center
                    ) {
                        Column(
                            horizontalAlignment = Alignment.CenterHorizontally,
                            verticalArrangement = Arrangement.spacedBy(8.dp)
                        ) {
                            Icon(Icons.Default.CameraAlt, contentDescription = null, size = 48.dp, tint = Color.Gray)
                            Text("Awaiting Lens camera access permissions.", fontSize = 12.sp, color = Color.LightGray)
                        }
                    }
                }
            }
        }

        // Lower state details
        Card(
            modifier = Modifier
                .fillMaxWidth()
                .weight(1f),
            colors = CardDefaults.cardColors(containerColor = Color(0xFF111827)),
            border = BoxBorder(Color(0xFF1F2937))
        ) {
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(16.dp),
                verticalArrangement = Arrangement.SpaceBetween
            ) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text(
                        "Assembled Payload Buffer",
                        fontSize = 13.sp,
                        fontWeight = FontWeight.Bold,
                        color = Color.White
                    )
                    IconButton(onClick = { flushDecoder() }) {
                        Icon(Icons.Default.Refresh, contentDescription = "Flush", tint = Color.Gray)
                    }
                }

                // If compiled file ready, display download actions
                if (assembledFile != null && rxState != null) {
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .background(Color(0xFF030712), RoundedCornerShape(8.dp))
                            .padding(12.dp)
                    ) {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                                Text(
                                    text = rxState!!.fileName,
                                    fontSize = 12.sp,
                                    fontWeight = FontWeight.Bold,
                                    color = Color.Green
                                )
                                Text(
                                    text = "CRC Validated • ${assembledFile!!.length()} bytes compiled",
                                    fontSize = 10.sp,
                                    color = Color.Gray
                                )
                            }
                            Icon(Icons.Default.CheckCircle, contentDescription = null, tint = Color.Green)
                        }
                    }
                } else if (rxState != null) {
                    // Showing progressive download blocks
                    val total = rxState!!.totalFrames
                    val finishedCount = rxState!!.receivedCount
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween
                        ) {
                            Text(
                                text = "Decoding file: ${rxState!!.fileName}",
                                fontSize = 11.sp,
                                color = Color.LightGray
                            )
                            Text(
                                text = "$finishedCount / $total frames",
                                fontSize = 11.sp,
                                color = Color.White,
                                fontFamily = FontFamily.Monospace
                            )
                        }

                        LinearProgressIndicator(
                            progress = { finishedCount.toFloat() / total },
                            modifier = Modifier
                                .fillMaxWidth()
                                .height(6.dp)
                                .clip(RoundedCornerShape(3.dp)),
                            color = Color(0xFF60A5FA),
                            trackColor = Color(0xFF1F2937)
                        )

                        // Pocket details mapper blocks
                        LazyVerticalGrid(
                            columns = GridCells.Adaptive(minimumSize = 20.dp),
                            modifier = Modifier
                                .fillMaxWidth()
                                .height(50.dp),
                            verticalArrangement = Arrangement.spacedBy(4.dp),
                            horizontalArrangement = Arrangement.spacedBy(4.dp)
                        ) {
                            val itemsList = (0 until total).toList()
                            items(itemsList) { i ->
                                val active = rxState!!.frames.containsKey(i)
                                Box(
                                    modifier = Modifier
                                        .size(20.dp)
                                        .background(
                                            if (active) Color(0xFF3B82F6) else Color(0xFF0F172A),
                                            RoundedCornerShape(4.dp)
                                        )
                                        .border(
                                            1.dp,
                                            if (active) Color.Transparent else Color(0xFF1E293B),
                                            RoundedCornerShape(4.dp)
                                        ),
                                    contentAlignment = Alignment.Center
                                ) {
                                    Text(
                                        text = "${i + 1}",
                                        fontSize = 8.sp,
                                        fontWeight = FontWeight.Bold,
                                        color = if (active) Color.White else Color.DarkGray
                                    )
                                }
                            }
                        }
                    }
                } else {
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .background(Color(0xFF0F172A), RoundedCornerShape(8.dp))
                            .padding(24.dp),
                        contentAlignment = Alignment.Center
                    ) {
                        Text(
                            text = "Awaiting optical broadcast sequence...",
                            fontSize = 11.sp,
                            color = Color.LightGray
                        )
                    }
                }

                // Debug binarizer preview layer to adjust lens alignment
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    binarizedBmp?.let { bmp ->
                        Image(
                            bitmap = bmp.asImageBitmap(),
                            contentDescription = "Binarized Monitor",
                            modifier = Modifier
                                .size(40.dp)
                                .clip(RoundedCornerShape(4.dp))
                                .border(1.dp, Color.Gray, RoundedCornerShape(4.dp))
                        )
                    }
                    Text(
                        text = "Spatial Threshold Adaptive Analyzer module is tracking ambient luminosity.",
                        fontSize = 10.sp,
                        color = Color.Gray,
                        modifier = Modifier.weight(1f)
                    )
                }
            }
        }
    }
}

// Low level extraction processing inside standard CameraX Analyser thread
fun processImageProxy(
    imageProxy: ImageProxy,
    settings: CodeSettings,
    callback: (com.lumisend.app.types.TransitFrame?, Bitmap?) -> Unit
) {
    var rawFrame: com.lumisend.app.types.TransitFrame? = null
    var monitorBmp: Bitmap? = null

    try {
        // Built-in converter available on CameraX 1.2+
        val bmp = imageProxy.toBitmap()
        
        // Define cropped coordinates centered at 50% width and height ratio aspect 4:3
        // Width: 50% of bitmap width. Height matching aspect 3/4.
        val cropW = (bmp.width * 0.5f).toInt()
        val cropH = (cropW * 0.75f).toInt()
        val startX = (bmp.width - cropW) / 2
        val startY = (bmp.height - cropH) / 2

        if (cropW > 10 && cropH > 10) {
            val cellW = settings.gridWidth
            val cellH = settings.gridHeight
            
            // local average colors thresholding
            var rSum = 0L
            var gSum = 0L
            var bSum = 0L
            var samples = 0
            
            // Subsample cropped area
            val stride = Math.max(1, cropW / 60)
            for (y in startY until startY + cropH step stride) {
                for (x in startX until startX + cropW step stride) {
                    val px = bmp.getPixel(x, y)
                    rSum += (px shr 16) and 0xFF
                    gSum += (px shr 8) and 0xFF
                    bSum += px and 0xFF
                    samples++
                }
            }

            val tR = if (samples > 0) rSum / samples else 128
            val tG = if (samples > 0) gSum / samples else 128
            val tB = if (samples > 0) bSum / samples else 128

            // Read cell matrix grid
            val grid = Array(cellH) { IntArray(cellW) { 0 } }
            
            // Offscreen minified monitor bitmap for debug display
            val dMon = Bitmap.createBitmap(cellW, cellH, Bitmap.Config.RGB_565)

            for (row in 0 until cellH) {
                for (col in 0 until cellW) {
                    val cx = startX + (((col + 0.5f) / cellW) * cropW).toInt()
                    val cy = startY + (((row + 0.5f) / cellH) * cropH).toInt()
                    
                    if (cx >= 0 && cx < bmp.width && cy >= 0 && cy < bmp.height) {
                        val px = bmp.getPixel(cx, cy)
                        val r = (px shr 16) and 0xFF
                        val g = (px shr 8) and 0xFF
                        val b = px and 0xFF

                        val isR = r < tR
                        val isG = g < tG
                        val isB = b < tB

                        val valByte = (if (isR) 4 else 0) or (if (isG) 2 else 0) or (if (isB) 1 else 0)
                        grid[row][col] = valByte

                        // Render minified monitor pixel colors
                        val dmColor = android.graphics.Color.rgb(
                            if (isR) 0 else 255,
                            if (isG) 0 else 255,
                            if (isB) 0 else 255
                        )
                        dMon.setPixel(col, row, dmColor)
                    }
                }
            }
            monitorBmp = dMon

            // Try decoding
            rawFrame = decodeFrameFromGrid(grid, settings)
        }
    } catch (_: Exception) {}

    imageProxy.close()
    callback(rawFrame, monitorBmp)
}

// Generate ZXing feedback Barcodes in native Bitmap
fun generateQRBitmap(txt: String, width: Int): Bitmap? {
    return try {
        val writer = QRCodeWriter()
        val matrix = writer.encode(txt, BarcodeFormat.QR_CODE, width, width)
        val bmp = Bitmap.createBitmap(matrix.width, matrix.height, Bitmap.Config.RGB_565)
        for (x in 0 until matrix.width) {
            for (y in 0 until matrix.height) {
                bmp.setPixel(x, y, if (matrix.get(x, y)) android.graphics.Color.BLACK else android.graphics.Color.WHITE)
            }
        }
        bmp
    } catch (_: Exception) {
        null
    }
}

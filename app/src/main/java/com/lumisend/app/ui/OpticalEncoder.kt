package com.lumisend.app.ui

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.lumisend.app.types.CodeSettings
import com.lumisend.app.types.TransitFrame
import com.lumisend.app.utils.createGridFromFrame
import com.lumisend.app.utils.getDataCapacityBytes
import com.lumisend.app.utils.packFileIntoFrames
import kotlinx.coroutines.delay
import java.io.InputStream

data class DemoFile(
    val name: String,
    val text: String,
    val type: String
)

val DEMO_FILES = listOf(
    DemoFile(
        "Secret_Link_Note.txt",
        "Hello from Google AI Studio Build! You have optically transmitted this file safely over-the-air. No servers, no network, completely offline connection!",
        "text/plain"
    ),
    DemoFile(
        "Business_VCard.vcf",
        "BEGIN:VCARD\nVERSION:3.0\nN:Agent;AI\nORG:Google AI Studio\nEMAIL:srisudha1616@gmail.com\nNOTE:Optical 4:3 Link Protocol\nEND:VCARD",
        "text/vcard"
    ),
    DemoFile(
        "Neon_Coordinates.json",
        "{\n  \"status\": \"online\",\n  \"system\": \"Optical 4:3 Link\",\n  \"coordinates\": {\n    \"alpha\": 42.1,\n    \"beta\": -73.5\n  },\n  \"protocol\": \"Air-Gapped Binary Light Link\"\n}",
        "application/json"
    )
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun OpticalEncoderScreen() {
    val context = LocalContext.current
    var settings by remember { mutableStateOf(CodeSettings()) }
    var activeFileName by remember { mutableStateOf(DEMO_FILES[0].name) }
    var activeFileData by remember { mutableStateOf(DEMO_FILES[0].text.toByteArray(Charsets.UTF_8)) }
    
    var frames by remember { mutableStateOf<List<TransitFrame>>(emptyList()) }
    var currentFrameIdx by remember { mutableStateOf(0) }
    var isPlaying by remember { mutableStateOf(false) }

    // File Selector Intent
    val filePickerLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.GetContent()
    ) { uri: Uri? ->
        uri?.let {
            try {
                // Read File Details
                val contentResolver = context.contentResolver
                val inputStream: InputStream? = contentResolver.openInputStream(uri)
                val bytes = inputStream?.readBytes()
                val path = uri.path ?: ""
                val extractedName = if (path.contains("/")) path.substringAfterLast("/") else "custom_import.bin"
                
                if (bytes != null) {
                    activeFileName = extractedName
                    activeFileData = bytes
                }
            } catch (e: Exception) {
                // Ignore errors
            }
        }
    }

    // Pack frames on changes
    LaunchedEffect(activeFileName, activeFileData, settings) {
        try {
            val generated = packFileIntoFrames(activeFileName, activeFileData, settings)
            frames = generated
            currentFrameIdx = 0
        } catch (e: Exception) {
            // Setup fallback
        }
    }

    // Playback loop
    LaunchedEffect(isPlaying, frames, settings.frameRate) {
        if (isPlaying && frames.size > 1) {
            val interval = (1000 / settings.frameRate).toLong()
            while (isPlaying) {
                delay(interval)
                currentFrameIdx = (currentFrameIdx + 1) % frames.size
            }
        }
    }

    val scrollState = rememberScrollState()

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(Color(0xFF030712)) // Deep slate background
            .verticalScroll(scrollState)
            .padding(16.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        // Broadcaster title card
        Card(
            modifier = Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(containerColor = Color(0xFF111827)),
            border = BoxBorder(Color(0xFF1F2937))
        ) {
            Column(modifier = Modifier.padding(16.dp)) {
                Text(
                    text = "Lumisend Broadcast Module",
                    fontSize = 18.sp,
                    fontWeight = FontWeight.Bold,
                    color = Color.White
                )
                Text(
                    text = "Flashes raw content encoded into high-density 4:3 light signals. Requires no network.",
                    fontSize = 12.sp,
                    color = Color.LightGray,
                    modifier = Modifier.padding(top = 4.dp)
                )
            }
        }

        // 1. CHROME GRID CANVAS SCREEN
        Card(
            modifier = Modifier
                .fillMaxWidth()
                .aspectRatio(1.1f),
            colors = CardDefaults.cardColors(containerColor = Color(0xFF111827)),
            border = BoxBorder(Color(0xFF1F2937))
        ) {
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(12.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.SpaceBetween
            ) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Box(
                            modifier = Modifier
                                .size(8.dp)
                                .background(if (isPlaying) Color.Green else Color.DarkGray, RoundedCornerShape(50))
                        )
                        Spacer(modifier = Modifier.width(6.dp))
                        Text(
                            text = if (isPlaying) "BROADCAST ACTIVE" else "BROADCAST PAUSED",
                            fontSize = 11.sp,
                            fontWeight = FontWeight.SemiBold,
                            color = Color.White
                        )
                    }
                    Text(
                        text = "Frame ${if (frames.isNotEmpty()) currentFrameIdx + 1 else 0} of ${frames.size}",
                        fontSize = 11.sp,
                        fontFamily = FontFamily.Monospace,
                        color = Color.LightGray,
                        modifier = Modifier
                            .background(Color(0xFF1F2937), RoundedCornerShape(4.dp))
                            .padding(horizontal = 6.dp, vertical = 2.dp)
                    )
                }

                // Main binary light link grid render
                Box(
                    modifier = Modifier
                        .fillMaxWidth(0.85f)
                        .aspectRatio(4f / 3f)
                        .background(Color.White, RoundedCornerShape(4.dp))
                        .padding(4.dp)
                        .align(Alignment.CenterHorizontally),
                    contentAlignment = Alignment.Center
                ) {
                    if (frames.isNotEmpty() && currentFrameIdx < frames.size) {
                        val gridRepresentation = remember(currentFrameIdx, frames, settings) {
                            createGridFromFrame(frames[currentFrameIdx], settings)
                        }
                        
                        Canvas(modifier = Modifier.fillMaxSize()) {
                            val cellsW = settings.gridWidth
                            val cellsH = settings.gridHeight
                            
                            val cellW = size.width / cellsW
                            val cellH = size.height / cellsH
                            
                            for (row in 0 until cellsH) {
                                for (col in 0 until cellsW) {
                                    val cellValue = gridRepresentation[row][col]
                                    
                                    // Math identical colors: if channel bit of value is 1, channel is 0 (dark), else 255 (bright)
                                    val r = if (((cellValue shr 2) and 1) == 1) 0f else 1f
                                    val g = if (((cellValue shr 1) and 1) == 1) 0f else 1f
                                    val b = if ((cellValue and 1) == 1) 0f else 1f
                                    
                                    drawRect(
                                        color = Color(r, g, b, 1f),
                                        topLeft = Offset(col * cellW, row * cellH),
                                        size = Size(cellW, cellH)
                                    )
                                }
                            }
                        }
                    } else {
                        Text(
                            text = "No light grid loaded",
                            color = Color.LightGray,
                            fontSize = 12.sp
                        )
                    }
                }

                // Shuttle playback buttons
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.Center,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    IconButton(
                        onClick = {
                            if (frames.isNotEmpty()) {
                                currentFrameIdx = (currentFrameIdx - 1 + frames.size) % frames.size
                            }
                        },
                        enabled = frames.size > 1
                    ) {
                        Icon(Icons.Default.ChevronLeft, contentDescription = "Prev", tint = Color.White)
                    }

                    Button(
                        onClick = { isPlaying = !isPlaying },
                        colors = ButtonDefaults.buttonColors(
                            containerColor = if (isPlaying) Color(0xFFEF4444) else Color(0xFF3B82F6)
                        ),
                        modifier = Modifier.padding(horizontal = 8.dp)
                    ) {
                        Icon(
                            imageVector = if (isPlaying) Icons.Default.Pause else Icons.Default.PlayArrow,
                            contentDescription = if (isPlaying) "Pause" else "Play",
                            modifier = Modifier.size(16.dp)
                        )
                        Spacer(modifier = Modifier.width(6.dp))
                        Text(
                            text = if (isPlaying) "Pause Loop" else "Broadcast Loop",
                            fontSize = 12.sp,
                            fontWeight = FontWeight.Bold
                        )
                    }

                    IconButton(
                        onClick = {
                            if (frames.isNotEmpty()) {
                                currentFrameIdx = (currentFrameIdx + 1) % frames.size
                            }
                        },
                        enabled = frames.size > 1
                    ) {
                        Icon(Icons.Default.ChevronRight, contentDescription = "Next", tint = Color.White)
                    }
                }
            }
        }

        // 2. CONFIG LABELS & SLIDER CONTROLS
        Card(
            modifier = Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(containerColor = Color(0xFF111827)),
            border = BoxBorder(Color(0xFF1F2937))
        ) {
            Column(
                modifier = Modifier.padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(14.dp)
            ) {
                Text(
                    text = "Transfer Configuration",
                    fontSize = 13.sp,
                    fontWeight = FontWeight.Bold,
                    color = Color.LightGray
                )

                // Color Channel mode
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(
                        text = "Transfer Channel Profile: " + if (settings.colorMode == "color") "3-Channel RGB (Fast)" else "Monochrome (Stable)",
                        fontSize = 12.sp,
                        color = Color.LightGray
                    )
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(8.dp)
                    ) {
                        Button(
                            onClick = { settings = settings.copy(colorMode = "mono") },
                            colors = ButtonDefaults.buttonColors(
                                containerColor = if (settings.colorMode == "mono") Color(0xFF374151) else Color(0xFF1F2937)
                            ),
                            modifier = Modifier.weight(1f)
                        ) {
                            Text("Monochrome link", fontSize = 11.sp, color = Color.White)
                        }
                        Button(
                            onClick = { settings = settings.copy(colorMode = "color") },
                            colors = ButtonDefaults.buttonColors(
                                containerColor = if (settings.colorMode == "color") Color(0xFF374151) else Color(0xFF1F2937)
                            ),
                            modifier = Modifier.weight(1f)
                        ) {
                            Text("RGB Color mode", fontSize = 11.sp, color = Color.White)
                        }
                    }
                }

                // Slider FPS speed
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween
                    ) {
                        Text(text = "Broadcast Speed (Frame Rate)", fontSize = 12.sp, color = Color.LightGray)
                        Text(
                            text = "${settings.frameRate} FPS",
                            fontSize = 12.sp,
                            fontWeight = FontWeight.Bold,
                            color = Color(0xFF60A5FA)
                        )
                    }
                    Slider(
                        value = settings.frameRate.toFloat(),
                        onValueChange = { settings = settings.copy(frameRate = it.toInt()) },
                        valueRange = 1f..15f,
                        steps = 13,
                        colors = SliderDefaults.colors(
                            thumbColor = Color.LightGray,
                            activeTrackColor = Color(0xFF60A5FA),
                            inactiveTrackColor = Color(0xFF1F2937)
                        )
                    )
                }

                // Grid size density parameters 
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(text = "Grid Density Matrix", fontSize = 12.sp, color = Color.LightGray)
                    val densities = listOf(
                        Pair(48, 36),
                        Pair(72, 54),
                        Pair(96, 72)
                    )
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(5.dp)
                    ) {
                        densities.forEach { d ->
                            val isSelected = settings.gridWidth == d.first
                            Box(
                                modifier = Modifier
                                    .weight(1f)
                                    .background(
                                        if (isSelected) Color(0xFF374151) else Color(0xFF111827),
                                        RoundedCornerShape(8.dp)
                                    )
                                    .border(1.dp, Color(0xFF1F2937), RoundedCornerShape(8.dp))
                                    .clickable { settings = settings.copy(gridWidth = d.first, gridHeight = d.second) }
                                    .padding(vertical = 8.dp),
                                contentAlignment = Alignment.Center
                            ) {
                                Text(
                                    text = "${d.first}×${d.second}",
                                    fontSize = 11.sp,
                                    fontWeight = FontWeight.SemiBold,
                                    color = if (isSelected) Color.White else Color.Gray
                                )
                            }
                        }
                    }
                }
            }
        }

        // 3. SOURCE DATA / INPUT
        Card(
            modifier = Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(containerColor = Color(0xFF111827)),
            border = BoxBorder(Color(0xFF1F2937))
        ) {
            Column(
                modifier = Modifier.padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp)
            ) {
                Text(
                    text = "Source Payload Data",
                    fontSize = 13.sp,
                    fontWeight = FontWeight.Bold,
                    color = Color.LightGray
                )

                // Drag or pick files
                Button(
                    onClick = { filePickerLauncher.launch("*/*") },
                    colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF1F2937)),
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Icon(Icons.Default.Upload, contentDescription = "Pick file", modifier = Modifier.size(16.dp))
                    Spacer(modifier = Modifier.width(8.dp))
                    Text("Select Custom File from Storage", fontSize = 12.sp)
                }

                Text(
                    text = "Try Demo Presets",
                    fontSize = 11.sp,
                    color = Color.Gray,
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier.padding(top = 4.dp)
                )

                LazyRow(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    itemsIndexed(DEMO_FILES) { idx, item ->
                        val isSelected = activeFileName == item.name
                        Box(
                            modifier = Modifier
                                .background(
                                    if (isSelected) Color(0xFF374151) else Color(0xFF111827),
                                    RoundedCornerShape(8.dp)
                                )
                                .border(1.dp, Color(0xFF1F2937), RoundedCornerShape(8.dp))
                                .clickable {
                                    activeFileName = item.name
                                    activeFileData = item.text.toByteArray(Charsets.UTF_8)
                                }
                                .padding(horizontal = 12.dp, vertical = 6.dp),
                            contentAlignment = Alignment.Center
                        ) {
                            Text(
                                text = item.name.split("_")[0],
                                fontSize = 11.sp,
                                color = if (isSelected) Color.White else Color.LightGray
                            )
                        }
                    }
                }

                // File facts
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(Color(0xFF030712), RoundedCornerShape(8.dp))
                        .padding(10.dp)
                ) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Column {
                            Text(text = activeFileName, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, color = Color.White)
                            Text(
                                text = "${activeFileData.size} bytes • ${(activeFileData.size / 1024f).toString().take(4)} KB",
                                fontSize = 10.sp,
                                color = Color.Gray
                            )
                        }
                        Box(
                            modifier = Modifier
                                .background(Color(0xFF1F2937), RoundedCornerShape(4.dp))
                                .padding(horizontal = 6.dp, vertical = 2.dp)
                        ) {
                            Text(
                                text = "${getDataCapacityBytes(settings) - 23} bytes/frame",
                                fontSize = 9.sp,
                                fontFamily = FontFamily.Monospace,
                                color = Color.LightGray
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun BoxBorder(color: Color): CardBorder {
    return CardDefaults.cardBorder(enabled = true, border = BorderStroke(1.dp, color))
}

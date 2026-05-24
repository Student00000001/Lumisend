package com.lumisend.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CompassCalibration
import androidx.compose.material.icons.filled.FileDownload
import androidx.compose.material.icons.filled.FileUpload
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.lumisend.app.ui.OpticalDecoderScreen
import com.lumisend.app.ui.OpticalEncoderScreen

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme(
                colorScheme = darkColorScheme(
                    background = Color(0xFF030712),
                    surface = Color(0xFF111827),
                    primary = Color(0xFF3B82F6),
                    onBackground = Color.White
                )
            ) {
                Surface(
                    modifier = Modifier.fillMaxSize(),
                    color = Color(0xFF030712)
                ) {
                    LumisendApp()
                }
            }
        }
    }
}

@Composable
fun LumisendApp() {
    var activeTab by remember { mutableStateOf("transmit") } // "transmit" | "receive"

    Column(modifier = Modifier.fillMaxSize()) {
        // App Header Toolbar matching website styling
        Card(
            modifier = Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(0.dp),
            colors = CardDefaults.cardColors(containerColor = Color(0xFF030712)),
            border = CardDefaults.cardBorder(enabled = true, border = androidx.compose.foundation.BorderStroke(1.dp, Color(0xFF1F2937)))
        ) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 16.dp, vertical = 12.dp)
            ) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    // Brand Logo detail
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp)
                    ) {
                        Box(
                            modifier = Modifier
                                .size(34.dp)
                                .background(Color(0xFF111827), RoundedCornerShape(8.dp))
                                .border(1.dp, Color(0xFF374151), RoundedCornerShape(8.dp)),
                            contentAlignment = Alignment.Center
                        ) {
                            Text(
                                "L",
                                color = Color.White,
                                fontWeight = FontWeight.Black,
                                fontSize = 16.sp
                            )
                        }
                        
                        Column {
                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                                Text(
                                    text = "Lumisend",
                                    fontSize = 15.sp,
                                    fontWeight = FontWeight.Bold,
                                    color = Color.White
                                )
                                Text(
                                    text = "v2.1",
                                    fontSize = 8.sp,
                                    color = Color.LightGray,
                                    fontFamily = FontFamily.Monospace,
                                    modifier = Modifier
                                        .background(Color(0xFF111827), RoundedCornerShape(4.dp))
                                        .padding(horizontal = 4.dp, vertical = 1.dp)
                                        .border(0.5.dp, Color(0xFF374151), RoundedCornerShape(4.dp))
                                )
                            }
                            Text(
                                text = "Secure air-gapped optical transfer link",
                                fontSize = 10.sp,
                                color = Color.Gray
                            )
                        }
                    }
                }

                Spacer(modifier = Modifier.height(10.dp))

                // Mode / Tab selector pills
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(Color(0xFF111827), RoundedCornerShape(10.dp))
                        .padding(3.dp),
                    horizontalArrangement = Arrangement.spacedBy(4.dp)
                ) {
                    val activeColor = Color(0xFF1F2937)
                    
                    Box(
                        modifier = Modifier
                            .weight(1f)
                            .background(
                                if (activeTab == "transmit") activeColor else Color.Transparent,
                                RoundedCornerShape(8.dp)
                            )
                            .clickable { activeTab = "transmit" }
                            .padding(vertical = 8.dp),
                        contentAlignment = Alignment.Center
                    ) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            Icon(
                                Icons.Default.FileUpload,
                                contentDescription = null,
                                tint = if (activeTab == "transmit") Color.White else Color.Gray,
                                modifier = Modifier.size(14.dp)
                            )
                            Text(
                                text = "Sender (Tx)",
                                fontSize = 11.sp,
                                fontWeight = FontWeight.Bold,
                                color = if (activeTab == "transmit") Color.White else Color.Gray
                            )
                        }
                    }

                    Box(
                        modifier = Modifier
                            .weight(1f)
                            .background(
                                if (activeTab == "receive") activeColor else Color.Transparent,
                                RoundedCornerShape(8.dp)
                            )
                            .clickable { activeTab = "receive" }
                            .padding(vertical = 8.dp),
                        contentAlignment = Alignment.Center
                    ) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            Icon(
                                Icons.Default.FileDownload,
                                contentDescription = null,
                                tint = if (activeTab == "receive") Color.White else Color.Gray,
                                modifier = Modifier.size(14.dp)
                            )
                            Text(
                                text = "Scanner (Rx)",
                                fontSize = 11.sp,
                                fontWeight = FontWeight.Bold,
                                color = if (activeTab == "receive") Color.White else Color.Gray
                            )
                        }
                    }
                }
            }
        }

        // Active Viewport Render
        Box(modifier = Modifier.weight(1f)) {
            if (activeTab == "transmit") {
                OpticalEncoderScreen()
            } else {
                OpticalDecoderScreen()
            }
        }
    }
}

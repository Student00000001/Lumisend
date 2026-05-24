import React, { useState, useEffect, useRef } from 'react';
import { 
  Camera, CameraOff, Sparkles, RefreshCw, CheckCircle, 
  Download, Terminal, AlertTriangle, FileUp, Volume2, 
  FileCheck, ShieldCheck, Cpu, Info
} from 'lucide-react';
import QRCode from 'qrcode';
import { CodeSettings, ReceiverState, LogMessage } from '../types';
import { decodeFrameFromGrid, extractGridFromImage, decompressBytes } from '../utils/coder';

export default function OpticalDecoder() {
  const [settings, setSettings] = useState<CodeSettings>({
    gridWidth: 48,
    gridHeight: 36,
    frameRate: 6,
    colorMode: 'mono'
  });

  const [hasCamera, setHasCamera] = useState<boolean | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('');
  
  // Debuggers & visualization
  const [showBinarized, setShowBinarized] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [logs, setLogs] = useState<LogMessage[]>([]);
  
  // Receive state
  const [receiverState, setReceiverState] = useState<ReceiverState | null>(null);
  const [successFile, setSuccessFile] = useState<{ name: string; blob: Blob; url: string; content?: string } | null>(null);
  const [scannedFrameCount, setScannedFrameCount] = useState(0);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const scannerCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const binarizedCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const scanIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const qrCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // Dynamic automatic QR recovery generator effect
  useEffect(() => {
    if (receiverState && !receiverState.completed && receiverState.receivedCount > 0) {
      const missing: number[] = [];
      for (let i = 0; i < receiverState.totalFrames; i++) {
        if (!receiverState.frames[i]) {
          missing.push(i);
        }
      }
      if (missing.length > 0 && qrCanvasRef.current) {
        QRCode.toCanvas(qrCanvasRef.current, JSON.stringify({
          type: 'OPFLK_RETRY',
          salt: receiverState.fileSalt,
          missing
        }), {
          width: 130,
          margin: 1.5,
          color: {
            dark: '#030712',
            light: '#ffffff'
          }
        }, (err) => {
          if (err) console.error('Error drawing feedback QR', err);
        });
      }
    }
  }, [receiverState]);

  // Initialize audio beeper on first user interaction with audio
  const playBeep = (freq = 800, duration = 0.05) => {
    if (!soundEnabled) return;
    try {
      if (!audioContextRef.current) {
        audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
      }
      const ctx = audioContextRef.current;
      if (ctx.state === 'suspended') {
        ctx.resume();
      }
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, ctx.currentTime);
      gain.gain.setValueAtTime(0.08, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
      
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + duration);
    } catch (e) {
      console.warn('Audio beeper failed to launch', e);
    }
  };

  const addLog = (type: LogMessage['type'], text: string) => {
    const timestamp = new Date().toLocaleTimeString();
    setLogs(prev => [
      { id: Math.random().toString(), time: timestamp, type, text },
      ...prev.slice(0, 49) // Keep last 50 logs
    ]);
  };

  // Get available video inputs
  useEffect(() => {
    async function enumerate() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        // Release immediate camera stream
        stream.getTracks().forEach(track => track.stop());
        
        const devicesFound = await navigator.mediaDevices.enumerateDevices();
        const videoInputs = devicesFound.filter(d => d.kind === 'videoinput');
        setDevices(videoInputs);
        setHasCamera(true);
        if (videoInputs.length > 0) {
          setSelectedDeviceId(videoInputs[0].deviceId);
        }
        addLog('info', 'Webcam devices initialized successfully.');
      } catch (err) {
        setHasCamera(false);
        addLog('warning', 'No video capture hardware found or camera access denied.');
      }
    }
    enumerate();
  }, []);

  // Control camera video stream
  useEffect(() => {
    let activeStream: MediaStream | null = null;
    
    if (isScanning && selectedDeviceId) {
      navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: selectedDeviceId }, width: { ideal: 640 }, height: { ideal: 480 } }
      })
      .then(stream => {
        activeStream = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play().catch(e => console.error(e));
        }
        addLog('info', 'Live camera broadcast feed activated.');
      })
      .catch(err => {
        setIsScanning(false);
        addLog('error', `Cannot access chosen camera: ${err.message}`);
      });
    }

    return () => {
      if (activeStream) {
        activeStream.getTracks().forEach(track => track.stop());
      }
    };
  }, [isScanning, selectedDeviceId]);

  // Main real-time optical scanning clock loop
  useEffect(() => {
    if (isScanning) {
      // Clear exist
      if (scanIntervalRef.current) clearInterval(scanIntervalRef.current);
      
      // We scan 12 times a second for snappy capture latency
      scanIntervalRef.current = setInterval(() => {
        captureAndScan();
      }, 85);
    } else {
      if (scanIntervalRef.current) {
        clearInterval(scanIntervalRef.current);
        scanIntervalRef.current = null;
      }
    }

    return () => {
      if (scanIntervalRef.current) clearInterval(scanIntervalRef.current);
    };
  }, [isScanning, receiverState, settings, showBinarized]);

  const captureAndScan = () => {
    const video = videoRef.current;
    if (!video || video.readyState !== video.HAVE_CURRENT_DATA) return;

    const canvas = scannerCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Matches the camera feed aspect ratio
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    // Guide target bounding coordinates: we represent a 4:3 box in the center of the frame
    // Box dimensions: 280px wide x 210px high (or adaptive, say 52% width, keeping 4:3)
    const boxW = Math.round(canvas.width * 0.5);
    const boxH = Math.round(boxW * 0.75); // 4:3 ratio
    const boxX = Math.round((canvas.width - boxW) / 2);
    const boxY = Math.round((canvas.height - boxH) / 2);

    const x1 = boxX / canvas.width;
    const y1 = boxY / canvas.height;
    const x2 = (boxX + boxW) / canvas.width;
    const y2 = (boxY + boxH) / canvas.height;

    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    
    // Extract grid matrix
    const grid = extractGridFromImage(imgData.data, canvas.width, canvas.height, settings, x1, y1, x2, y2);
    
    if (grid) {
      // Visual feedback: Render binarized frame overlay in debug canvas
      renderBinarizedView(grid, boxW, boxH);

      // Attempt to decode a Valid Optical Frame
      const frameObj = decodeFrameFromGrid(grid, settings);
      
      if (frameObj) {
        // We successfully decoded a clean frame with correct CRC16!
        processReceivedFrame(frameObj);
      }
    }
  };

  const renderBinarizedView = (grid: number[][], w: number, h: number) => {
    const bCanvas = binarizedCanvasRef.current;
    if (!bCanvas) return;
    const bCtx = bCanvas.getContext('2d');
    if (!bCtx) return;

    const cellsW = settings.gridWidth;
    const cellsH = settings.gridHeight;
    
    bCanvas.width = cellsW * 6;
    bCanvas.height = cellsH * 6;

    bCtx.fillStyle = '#FFFFFF';
    bCtx.fillRect(0, 0, bCanvas.width, bCanvas.height);

    for (let r = 0; r < cellsH; r++) {
      for (let c = 0; c < cellsW; c++) {
        const val = grid[r][c];
        const red = ((val >> 2) & 1) === 1 ? 0 : 255;
        const green = ((val >> 1) & 1) === 1 ? 0 : 255;
        const blue = (val & 1) === 1 ? 0 : 255;
        
        bCtx.fillStyle = `rgb(${red}, ${green}, ${blue})`;
        bCtx.fillRect(c * 6, r * 6, 6, 6);
      }
    }
  };

  const processReceivedFrame = (frame: any) => {
    const salt = frame.fileSalt;
    const frameIndex = frame.frameIndex;
    const total = frame.totalFrames;

    setScannedFrameCount(prev => prev + 1);

    // Check if we are already receiving this specific file or need to instantiate state
    let state = receiverState;
    if (!state || state.fileSalt !== salt) {
      const initialName = frameIndex === 0 ? frame.fileName : `link_rx_${salt}`;
      state = {
        fileSalt: salt,
        fileName: initialName,
        fileSize: frameIndex === 0 ? frame.originalFileSize : 0,
        fileType: getMimeTypeFromExtension(initialName),
        totalFrames: total,
        receivedCount: 0,
        completed: false,
        frames: {},
        compressionFlag: frameIndex === 0 ? frame.compressionFlag : 0,
        originalFileSize: frameIndex === 0 ? frame.originalFileSize : 0
      };
      setSuccessFile(null); // Reset previous success files
      addLog('success', `New incoming optical link recognized [ID: ${salt}]. Preparing local cache Buffer (${total} frames).`);
    }

    // Overwrite metadata values if Frame 0 arrives
    if (frameIndex === 0) {
      state.fileName = frame.fileName;
      state.fileType = getMimeTypeFromExtension(frame.fileName);
      state.compressionFlag = frame.compressionFlag;
      state.originalFileSize = frame.originalFileSize;
    }

    // Is it a brand new frame part we haven't seen?
    if (!state.frames[frameIndex]) {
      state.frames[frameIndex] = frame.payload;
      state.receivedCount = Object.keys(state.frames).length;
      
      // Update the react state
      const updatedState = { ...state };
      setReceiverState(updatedState);
      
      // Audible/Visual confirmation beep!
      playBeep(700 + frameIndex * 35, 0.05);
      addLog('info', `Successfully scanned frame PART ${frameIndex + 1}/${total} [CRC16 Verified: OK]`);

      // Are all frames captured?
      if (updatedState.receivedCount === total && !updatedState.completed) {
        updatedState.completed = true;
        setReceiverState({ ...updatedState });
        finalizeFileAssembly(updatedState);
      }
    }
  };

  const finalizeFileAssembly = async (state: ReceiverState) => {
    try {
      addLog('success', 'Optical connection finalized! 100% of payloads gathered. Reconstructing byte stream...');
      playBeep(980, 0.12);
      setTimeout(() => playBeep(1320, 0.15), 120);

      // Concatenate sorted Uint8Array packets
      let totalSize = 0;
      for (let i = 0; i < state.totalFrames; i++) {
        totalSize += state.frames[i].length;
      }

      let flatBytes = new Uint8Array(totalSize);
      let offset = 0;
      for (let i = 0; i < state.totalFrames; i++) {
        flatBytes.set(state.frames[i], offset);
        offset += state.frames[i].length;
      }

      // Decompress payload if marked as compressed
      if (state.compressionFlag === 1) {
        addLog('info', 'Decompressing GZIP optical payload natively inside browser...');
        try {
          flatBytes = await decompressBytes(flatBytes);
        } catch (decompError: any) {
          addLog('warning', `Decompression failed: ${decompError.message}. Attempting raw byte fallback.`);
        }
      }

      const finalSize = flatBytes.length;
      const blob = new Blob([flatBytes], { type: state.fileType });
      const url = URL.createObjectURL(blob);

      // Read content for quick UI previews if text
      let textContent: string | undefined = undefined;
      const lowerName = state.fileName.toLowerCase();
      if (lowerName.endsWith('.txt') || lowerName.endsWith('.vcf') || lowerName.endsWith('.json') || lowerName.endsWith('.html') || lowerName.endsWith('.css')) {
        const textDecoder = new TextDecoder();
        textContent = textDecoder.decode(flatBytes);
      }

      setSuccessFile({
        name: state.fileName,
        blob,
        url,
        content: textContent
      });
      addLog('success', `File "${state.fileName}" regenerated successfully! Final decoded size: ${(finalSize / 1024).toFixed(2)} KB.`);
    } catch (e: any) {
      addLog('error', `Assembler Error: ${e.message}`);
    }
  };

  const getMimeTypeFromExtension = (filename: string): string => {
    const ext = filename.split('.').pop()?.toLowerCase();
    switch (ext) {
      case 'txt': return 'text/plain';
      case 'json': return 'application/json';
      case 'vcf': return 'text/vcard';
      case 'png': return 'image/png';
      case 'jpg':
      case 'jpeg': return 'image/jpeg';
      case 'gif': return 'image/gif';
      case 'html': return 'text/html';
      case 'css': return 'text/css';
      default: return 'application/octet-stream';
    }
  };

  // Safe manual image drop verification
  const handleImageFileLoad = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const img = new Image();
    const reader = new FileReader();
    
    reader.onload = (event) => {
      img.onload = () => {
        // Instantiate a quick offscreen canvas to parse image
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.drawImage(img, 0, 0);

        const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        
        // Scan the coordinates by using the full bounds 0 to 1
        const grid = extractGridFromImage(imgData.data, canvas.width, canvas.height, settings, 0, 0, 1, 1);
        if (grid) {
          renderBinarizedView(grid, canvas.width, canvas.height);
          const frameObj = decodeFrameFromGrid(grid, settings);
          if (frameObj) {
            processReceivedFrame(frameObj);
            addLog('success', 'Direct File Upload code page successfully parsed.');
          } else {
            addLog('error', 'Optical Link Code identified, but decoding structural bits failed. Try adjusting matching density preset.');
          }
        } else {
          addLog('error', 'Could not parse the grid pattern from uploaded picture. Ensure it is a valid 4:3 code file.');
        }
      };
      img.src = event.target?.result as string;
    };
    reader.readAsDataURL(file);
  };

  const resetReceiver = () => {
    setReceiverState(null);
    setSuccessFile(null);
    setScannedFrameCount(0);
    addLog('info', 'Receiver pipeline flushed. Ready to scan new sequence.');
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6" id="decoder-wrapper">
      {/* LEFT CAMERA VIEWPORT (7 columns) */}
      <div className="lg:col-span-7 flex flex-col gap-5" id="decoder-left">
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-lg flex flex-col flex-1 min-h-[440px] justify-between relative" id="camera-feed-card">
          
          {/* HEADER OPTIONS */}
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-3" id="camera-header-controls">
            <div className="flex items-center gap-2">
              <Camera className="w-5 h-5 text-slate-400" />
              <h3 className="font-semibold text-sm text-slate-200">Active Lens Scanner</h3>
            </div>

            <div className="flex items-center gap-2" id="camera-toolbar">
              {/* SELECT CAMERA DEVICE IF MULTIPLE */}
              {devices.length > 0 && (
                <select
                  value={selectedDeviceId}
                  onChange={(e) => setSelectedDeviceId(e.target.value)}
                  className="bg-slate-950 border border-slate-800 text-[11px] text-slate-300 rounded px-2 py-1 outline-none font-mono"
                  id="camera-select"
                >
                  {devices.map((d, i) => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label || `Camera ${i + 1}`}
                    </option>
                  ))}
                </select>
              )}

              {/* BEEP SOUND ON/OFF */}
              <button
                onClick={() => setSoundEnabled(!soundEnabled)}
                className={`p-1.5 rounded-lg border transition-all ${
                  soundEnabled 
                    ? 'bg-slate-800 border-slate-705 text-slate-100 font-bold' 
                    : 'bg-slate-950 border-slate-900 text-slate-600'
                }`}
                title={soundEnabled ? "Mute beep sound" : "Enable beep sound"}
                id="btn-toggle-sound"
              >
                <Volume2 className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* MAIN WEBCAM SCREEN WITH TARGET INTERACTIVE BOUNDS */}
          <div className="my-5 bg-slate-950 rounded-xl relative overflow-hidden aspect-[4/3] flex items-center justify-center border border-slate-850" id="camera-lens-view">
            {isScanning ? (
              <div className="relative w-full h-full flex items-center justify-center" id="viewport-scanner-frame">
                <video 
                  ref={videoRef}
                  className="w-full h-full object-cover transform scale-x-1"
                  playsInline
                  id="scanner-webcam-node"
                />

                {/* DYNAMIC SCANNED COUNTER */}
                <div className="absolute top-3 left-3 bg-slate-950/80 px-2 py-1 rounded border border-slate-800 font-mono text-[10px] text-slate-300">
                  Samples processed: <span className="text-slate-100 font-bold">{scannedFrameCount}</span>
                </div>

                {/* DYNAMIC GREEN ALIGNMENT OVERLAY COMPLIANT WITH ratio 4:3 */}
                <div className="absolute top-0 left-0 w-full h-full flex items-center justify-center pointer-events-none" id="alignment-bounds-guide">
                  <div className="w-[50%] aspect-[4/3] border-2 border-dashed border-slate-600 flex flex-col justify-between p-2 rounded relative" id="guide-reticle">
                    {/* Glowing neon corner markings */}
                    <div className="absolute -top-1.5 -left-1.5 w-6 h-6 border-t-4 border-l-4 border-slate-400 rounded-tl" />
                    <div className="absolute -top-1.5 -right-1.5 w-6 h-6 border-t-4 border-r-4 border-slate-400 rounded-tr" />
                    <div className="absolute -bottom-1.5 -left-1.5 w-6 h-6 border-b-4 border-l-4 border-slate-400 rounded-bl" />
                    <div className="absolute -bottom-1.5 -right-1.5 w-6 h-6 border-b-4 border-r-4 border-slate-400 rounded-br" />
                    
                    {/* INDICATOR TARGET SHAPE GRAPHIC ON TOP LEFT COMPREHENDABLE BY USER */}
                    <div className="absolute top-2 left-2 flex flex-col gap-0.5 animate-pulse" id="custom-l-guide-graphic">
                      <div className="flex gap-0.5">
                        <span className="w-3.5 h-1.5 bg-red-500 rounded-sm" />
                        <span className="w-1.5 h-1.5 bg-red-500 rounded-sm" />
                      </div>
                      <span className="w-1.5 h-3 bg-red-500 rounded-sm" />
                      <span className="text-[7px] text-red-500 font-bold tracking-tight uppercase font-mono mt-0.5">Top-Left L</span>
                    </div>

                    <div className="w-full h-full flex items-center justify-center" id="center-align-text">
                      <p className="text-[10px] text-slate-300 font-semibold tracking-wider uppercase bg-slate-950/80 px-2 py-0.5 rounded shadow">
                        Center 4:3 Code Here
                      </p>
                    </div>
                  </div>
                </div>

                {/* SCANNED FEED STATUS OVERLAY */}
                {receiverState && (
                  <div className="absolute bottom-3 left-3 bg-slate-950/90 border border-slate-800/80 p-2.5 rounded-lg flex items-center gap-3 shadow-lg" id="scanner-progress-bar">
                    <span className="w-2 h-2 rounded-full bg-slate-400 animate-ping" />
                    <div className="text-left">
                      <p className="text-[10px] font-bold text-slate-300 font-mono truncate max-w-[160px]">{receiverState.fileName}</p>
                      <p className="text-[9px] font-mono text-slate-400 mt-0.5">Captured {receiverState.receivedCount}/{receiverState.totalFrames} frames</p>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="text-center p-8 space-y-4" id="fallback-camera-disabled">
                <div className="w-14 h-14 bg-slate-900 border border-slate-800 rounded-full flex items-center justify-center text-slate-600 mx-auto">
                  <CameraOff className="w-6 h-6" />
                </div>
                <div>
                  <h4 className="text-sm font-semibold text-slate-300">Scanner Engine Offline</h4>
                  <p className="text-xs text-slate-500 mt-1 max-w-sm mx-auto">
                    Activate the lens scanner module above to capture flashed link grids and compile payload elements.
                  </p>
                </div>
              </div>
            )}
          </div>

          {/* LOWER CONTROLS & TEST DROPAREA */}
          <div className="flex flex-wrap items-center justify-between gap-3 pt-2" id="camera-footer-actions">
            <div className="flex items-center gap-2">
              {hasCamera !== false && (
                <button
                  onClick={() => setIsScanning(!isScanning)}
                  className={`px-5 py-2.5 rounded-xl text-xs font-bold transition-all shadow flex items-center gap-2 border ${
                    isScanning 
                      ? 'bg-slate-850 border-slate-700 text-slate-300 hover:bg-slate-800' 
                      : 'bg-slate-200 text-slate-955 border-slate-300 font-bold hover:bg-white'
                  }`}
                  id="btn-toggle-camera-scanning"
                >
                  <Camera className="w-4 h-4" />
                  {isScanning ? 'Mute Camera Lens' : 'Enable Camera Lens'}
                </button>
              )}

              {/* FLUSH BUTTON */}
              {receiverState && (
                <button
                  onClick={resetReceiver}
                  className="px-4 py-2.5 rounded-xl border border-slate-800 bg-slate-950 text-slate-400 hover:text-slate-200 text-xs font-semibold hover:bg-slate-900/60 transition-all flex items-center gap-2"
                  id="btn-reset-decoder"
                >
                  <RefreshCw className="w-3.5 h-3.5" /> Flush Link Cache
                </button>
              )}
            </div>

            {/* DIRECT CODE UPLOADER FOR TESTING WITHOUT VIDEO CAMERA */}
            <div className="relative cursor-pointer" id="decoder-direct-upload">
              <input
                type="file"
                accept="image/*"
                onChange={handleImageFileLoad}
                className="absolute inset-0 opacity-0 cursor-pointer w-full"
                id="direct-image-loader"
              />
              <button 
                className="px-4.5 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-750 text-slate-200 text-xs font-semibold flex items-center gap-2 border border-slate-700/40 transition-all cursor-pointer pointer-events-none"
                id="btn-direct-upload"
              >
                <FileUp className="w-4 h-4 text-slate-300" /> Decode Image File
              </button>
            </div>
          </div>
        </div>

        {/* LOG SYSTEM */}
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-lg flex flex-col h-[180px] justify-between" id="decoder-logs">
          <div className="flex items-center justify-between border-b border-slate-800 pb-2.5" id="logs-header">
            <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
              <Terminal className="w-4 h-4 text-slate-400" /> System Link Logger
            </span>
            <span className="text-[9px] font-mono text-slate-500 bg-slate-950 px-1.5 py-0.5 rounded">Real-time telemetry</span>
          </div>

          <div className="bg-slate-950 p-3 rounded-lg border border-slate-850 h-[100px] overflow-y-auto text-left font-mono text-[10px] space-y-1.5" id="logs-feed-container">
            {logs.length > 0 ? (
              logs.map((log) => (
                <div key={log.id} className="leading-snug flex items-start gap-2" id={`log-${log.id}`}>
                  <span className="text-slate-600 shrink-0">{log.time}</span>
                  <span className={`font-bold shrink-0 ${
                    log.type === 'success' ? 'text-white' :
                    log.type === 'warning' ? 'text-slate-300' :
                    log.type === 'error' ? 'text-slate-105 font-bold underline' : 'text-slate-400'
                  }`}>
                    [{log.type.toUpperCase()}]
                  </span>
                  <span className="text-slate-300">{log.text}</span>
                </div>
              ))
            ) : (
              <p className="text-slate-600 italic">No optical events received. Point your lens at the blinking transmitter above.</p>
            )}
          </div>
        </div>
      </div>

      {/* RIGHT SIDE DETAILS MODULE: PROGRESS & SUCCESS TARGET (5 columns) */}
      <div className="lg:col-span-5 flex flex-col gap-6" id="decoder-right">
        {/* PARSED GRID BINARY MONITOR */}
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-lg space-y-3" id="binarized-preview-card">
          <div className="flex items-center justify-between border-b border-slate-800 pb-2.5" id="binarized-header">
            <h4 className="text-xs font-semibold text-slate-200 uppercase tracking-widest flex items-center gap-1.5">
              <Cpu className="w-4 h-4 text-slate-400" /> Hexa Binary Processor
            </h4>
            <button
              onClick={() => setShowBinarized(!showBinarized)}
              className={`text-[10px] px-2 py-0.5 border rounded-md transition-all font-mono font-bold ${
                showBinarized 
                  ? 'bg-slate-800 text-slate-200 border-slate-700' 
                  : 'bg-slate-950 text-slate-400 border-slate-900'
              }`}
              id="btn-toggle-binarized-view"
            >
              Mode: {showBinarized ? 'Binarized' : 'Normal'}
            </button>
          </div>

          <div className="bg-slate-950 rounded-xl p-4 flex flex-col items-center justify-center border border-slate-850 min-h-[140px] aspect-[4/3]" id="binarized-render-space">
            {isScanning ? (
              <canvas 
                ref={binarizedCanvasRef}
                className="w-full max-w-[200px] aspect-[4/3] bg-white rounded-md border border-slate-700/50"
                id="binarizer-debugger-canvas"
              />
            ) : (
              <div className="text-center text-slate-600 text-xs italic">
                Awaiting active camera frame feed
              </div>
            )}
          </div>

          {/* Chromatic vs Mono decoder toggle */}
          <div className="space-y-1 bg-slate-950/60 p-2.5 rounded-lg border border-slate-850/60" id="decoder-colormode-control">
            <div className="flex justify-between items-center mb-1">
              <span className="text-[10px] uppercase font-bold text-slate-400">Reception Channel Mode</span>
              <span className="font-mono text-[10px] text-slate-350">
                {settings.colorMode === 'color' ? 'Color (3 bits/cell)' : 'Monochrome (1 bit/cell)'}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-1.5" id="decoder-colormode-picker">
              <button
                onClick={() => setSettings(prev => ({ ...prev, colorMode: 'mono' }))}
                className={`py-1 rounded font-medium text-[10px] border transition-all ${
                  settings.colorMode !== 'color'
                    ? 'bg-slate-800 text-slate-100 border-slate-705 font-bold'
                    : 'bg-slate-950 text-slate-400 border-slate-900 hover:bg-slate-800/40'
                }`}
                id="rx-mono-btn"
              >
                Monochrome
              </button>
              <button
                onClick={() => setSettings(prev => ({ ...prev, colorMode: 'color' }))}
                className={`py-1 rounded font-medium text-[10px] border transition-all flex items-center justify-center gap-1 shrink-0 ${
                  settings.colorMode === 'color'
                    ? 'bg-slate-800 text-slate-100 border-slate-705 font-bold'
                    : 'bg-slate-950 text-slate-400 border-slate-900 hover:bg-slate-800/40'
                }`}
                id="rx-color-btn"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-pulse shrink-0" />
                Color Mode
              </button>
            </div>
          </div>

          {/* Decoder density preset picker */}
          <div className="space-y-1 bg-slate-950/60 p-2.5 rounded-lg border border-slate-850/60" id="decoder-density-control">
            <div className="flex justify-between items-center mb-1">
              <span className="text-[10px] uppercase font-bold text-slate-400">Target Grid Density</span>
              <span className="font-mono text-[10px] text-slate-350">{settings.gridWidth}×{settings.gridHeight}</span>
            </div>
            <div className="grid grid-cols-5 gap-1" id="decoder-grid-presets">
              {[
                { label: '48×36', w: 48, h: 36 },
                { label: '72×54', w: 72, h: 54 },
                { label: '96×72', w: 96, h: 72 },
                { label: '120×90', w: 120, h: 90 },
                { label: '144×108', w: 144, h: 108 }
              ].map((p, idx) => (
                <button
                  key={idx}
                  onClick={() => setSettings(prev => ({ ...prev, gridWidth: p.w, gridHeight: p.h }))}
                  className={`py-1 text-center rounded font-mono text-[9px] border transition-all truncate leading-tight ${
                    settings.gridWidth === p.w 
                      ? 'bg-slate-800 text-slate-100 border-slate-705 font-bold' 
                      : 'bg-slate-950 text-slate-400 border-slate-900 hover:bg-slate-800/40'
                  }`}
                  id={`decoder-preset-btn-${idx}`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          <p className="text-[10px] text-slate-500 text-center leading-normal">
            Visual output displaying localized adaptive threshold values inside the cropped scanner reticle space.
          </p>
        </div>

        {/* DOWNLOAD CARD OR PROGRESS */}
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-lg space-y-4 flex-1" id="file-assembler-card">
          <h3 className="text-slate-200 font-semibold text-sm flex items-center gap-1.5">
            <CheckCircle className="w-4.5 h-4.5 text-slate-400" /> Compiled Output Stream
          </h3>

          {!receiverState && !successFile && (
            <div className="bg-slate-950/60 border border-slate-850 p-8 rounded-xl text-center space-y-2.5 py-12" id="assembler-empty">
              <FileCheck className="w-8 h-8 text-slate-700 mx-auto" />
              <div>
                <h4 className="text-xs font-semibold text-slate-400">Idle Assembly Line</h4>
                <p className="text-[11px] text-slate-500 mt-1 max-w-[180px] mx-auto">
                  Align a transmitting screen with your camera lens to synchronize packets.
                </p>
              </div>
            </div>
          )}

          {/* ACTIVE PROGRESS BAR BOX */}
          {receiverState && !successFile && (
            <div className="bg-slate-950/80 border border-slate-800 p-4 rounded-xl space-y-4" id="assembler-active-progress">
              <div>
                <p className="text-[11px] font-semibold tracking-wide text-slate-400 uppercase">SYNCHRONIZING FILE</p>
                <h4 className="text-xs font-bold text-slate-100 mt-1 truncate font-mono">{receiverState.fileName}</h4>
              </div>

              {/* PROGRESS ROW */}
              <div className="space-y-1.5" id="progress-indicator-group">
                <div className="flex justify-between text-xs font-mono">
                  <span className="text-slate-500">Captured chunks</span>
                  <span className="text-slate-250 font-bold">
                    {receiverState.receivedCount} / {receiverState.totalFrames} ({Math.round((receiverState.receivedCount / receiverState.totalFrames) * 100)}%)
                  </span>
                </div>
                
                <div className="w-full bg-slate-900 rounded-full h-2.5 overflow-hidden">
                  <div 
                    className="bg-slate-400 h-full transition-all duration-300" 
                    style={{ width: `${(receiverState.receivedCount / receiverState.totalFrames) * 100}%` }}
                  />
                </div>
              </div>

              {/* DYNAMIC PARTS CHECK LIST */}
              <div className="space-y-2" id="grid-chunky-visualizer">
                <p className="text-[10px] font-semibold tracking-wider text-slate-500 uppercase">Optical Buffer Packet Mapping</p>
                <div className="grid grid-cols-6 gap-1.5 max-h-[140px] overflow-y-auto" id="buffer-map-grid">
                  {Array.from({ length: receiverState.totalFrames }).map((_, i) => {
                    const isOk = !!receiverState.frames[i];
                    return (
                      <div 
                        key={i} 
                        className={`py-1.5 text-center rounded text-[10px] font-bold font-mono border ${
                          isOk 
                            ? 'bg-slate-800 border-slate-705 text-slate-100' 
                            : 'bg-slate-950 border-slate-900 text-slate-600'
                        }`}
                        id={`buffer-block-${i}`}
                      >
                        {i + 1}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* RE-TRANSMISSION REQUEST OVERLAY */}
              {receiverState.receivedCount < receiverState.totalFrames && receiverState.receivedCount > 0 && (
                <div className="border border-dashed border-slate-700 bg-slate-950 p-4 rounded-xl flex flex-col items-center text-center gap-3 animate-fade-in" id="recovery-channel-card">
                  <div className="text-left w-full">
                    <span className="text-[10px] uppercase font-bold text-slate-300 tracking-wider flex items-center gap-1">
                      <Sparkles className="w-3.5 h-3.5 animate-pulse" /> Selective Packet Recovery
                    </span>
                    <p className="text-[11px] text-slate-400 mt-1 leading-normal">Show this recovery QR token to the Transmitter's feedback camera (Backward Link Scanner) to repeat ONLY the missed frames.</p>
                  </div>
                  
                  <div className="bg-white p-2 rounded-lg shadow-md inline-block">
                    <canvas ref={qrCanvasRef} id="decoder-recovery-qr" className="w-[130px] h-[130px]" />
                  </div>
                  
                  <div className="text-[10px] font-mono text-slate-500 leading-tight">
                    Missed part numbers: <span className="text-slate-350 font-bold">
                      {Array.from({ length: receiverState.totalFrames })
                        .map((_, idx) => idx)
                        .filter(idx => !receiverState.frames[idx])
                        .map(idx => idx + 1)
                        .join(', ')}
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* SENSATIONAL SUCCESS FILE PREVIEW */}
          {successFile && (
            <div className="bg-slate-950/80 border border-slate-700/60 p-4.5 rounded-xl space-y-4" id="assembler-success">
              <div className="flex items-center gap-3" id="assembled-header">
                <div className="w-12 h-12 bg-slate-800 border border-slate-700 rounded-xl flex items-center justify-center text-slate-300 shrink-0 shadow-inner">
                  <ShieldCheck className="w-6 h-6" />
                </div>
                <div className="truncate">
                  <div className="bg-slate-800 text-[9px] text-slate-200 border border-slate-700 px-1.5 py-0.5 rounded font-mono font-bold uppercase inline-block">
                    Valid Link Verified
                  </div>
                  <h4 className="text-xs font-bold text-slate-100 mt-1 truncate font-mono">{successFile.name}</h4>
                </div>
              </div>

              {/* PREVIEW CONTAINER BASED ON FILE EXTENSION */}
              {successFile.content && (
                <div className="bg-slate-900/50 p-3 rounded-lg border border-slate-800/80 text-left" id="text-preview-block">
                  <p className="text-[10px] font-semibold tracking-wide text-slate-500 uppercase border-b border-slate-800 pb-1 mb-1.5 flex items-center gap-1">
                    <Info className="w-3.5 h-3.5" /> Decoded Text Preview
                  </p>
                  <pre className="font-mono text-[10px] text-slate-300 max-h-[130px] overflow-y-auto whitespace-pre-wrap leading-normal">
                    {successFile.content}
                  </pre>
                </div>
              )}

              {/* IF IMAGE */}
              {successFile.name.match(/\.(png|jpg|jpeg|gif)$/i) && (
                <div className="bg-slate-900/50 p-2 rounded-lg border border-slate-800/80 text-center" id="img-preview-block">
                  <img 
                    src={successFile.url} 
                    alt="Scanned visual preview" 
                    referrerPolicy="no-referrer"
                    className="max-h-[140px] max-w-full rounded mx-auto border border-slate-850 shadow object-contain"
                  />
                </div>
              )}

              {/* ACTION DOWNLOAD BUTTONS */}
              <div className="grid grid-cols-2 gap-2" id="constructed-actions">
                <a 
                  href={successFile.url} 
                  download={successFile.name}
                  className="bg-slate-100 hover:bg-white text-slate-950 px-3 py-2.5 rounded-xl text-xs font-bold transition-all text-center flex items-center justify-center gap-1.5 shadow"
                  id="link-btn-download"
                >
                  <Download className="w-4 h-4 fill-current" /> Save Offline
                </a>
                
                <button
                  onClick={resetReceiver}
                  className="bg-slate-800 hover:bg-slate-750 text-slate-200 px-3 py-2.5 rounded-xl text-xs font-semibold transition-all text-center border border-slate-700/60"
                  id="btn-scan-again"
                >
                  Scan Next Item
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

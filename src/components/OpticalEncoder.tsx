import React, { useState, useEffect, useRef } from 'react';
import { 
  Play, Pause, ChevronLeft, ChevronRight, Upload, 
  Settings, Layers, RefreshCw, FileText, Download,
  Binary, Compass, CheckCircle2, ShieldAlert,
  Camera, CameraOff, Sparkles
} from 'lucide-react';
import jsQR from 'jsqr';
import { CodeSettings, TransitFrame } from '../types';
import { packFileIntoFrames, createGridFromFrame, getDataCapacityBytes } from '../utils/coder';

const SAMPLE_FILES = [
  {
    name: 'Secret_Link_Note.txt',
    text: 'Hello from Google AI Studio Build! You have optically transmitted this file safely over-the-air. No servers, no network, completely offline connection!',
    type: 'text/plain'
  },
  {
    name: 'Business_VCard.vcf',
    text: 'BEGIN:VCARD\nVERSION:3.0\nN:Agent;AI\nORG:Google AI Studio\nEMAIL:srisudha1616@gmail.com\nNOTE:Optical 4:3 Link Protocol\nEND:VCARD',
    type: 'text/vcard'
  },
  {
    name: 'Neon_Coordinates.json',
    text: '{\n  "status": "online",\n  "system": "Optical 4:3 Link",\n  "coordinates": {\n    "alpha": 42.1,\n    "beta": -73.5\n  },\n  "protocol": "Air-Gapped Binary Light Link"\n}',
    type: 'application/json'
  }
];

export default function OpticalEncoder() {
  const [settings, setSettings] = useState<CodeSettings>({
    gridWidth: 48,
    gridHeight: 36,
    frameRate: 6, // Moderate, reliable FPS
    colorMode: 'mono'
  });

  const [activeFile, setActiveFile] = useState<{ name: string; size: number; data: Uint8Array } | null>(null);
  const [frames, setFrames] = useState<TransitFrame[]>([]);
  const [currentFrameIdx, setCurrentFrameIdx] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  
  // Backward QR Link State
  const [isFeedbackScanning, setIsFeedbackScanning] = useState(false);
  const [retransmitFrames, setRetransmitFrames] = useState<number[] | null>(null);
  const [senderCameraDevices, setSenderCameraDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedSenderCamera, setSelectedSenderCamera] = useState<string>('');
  
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const playIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  
  const feedbackVideoRef = useRef<HTMLVideoElement | null>(null);
  const feedbackScanCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const feedbackScanIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const senderAudioCtxRef = useRef<AudioContext | null>(null);

  // Initialize with the first sample file so they have something loaded immediately
  useEffect(() => {
    loadSampleFile(SAMPLE_FILES[0]);
  }, [settings.gridWidth, settings.gridHeight]);

  const loadSampleFile = (sample: typeof SAMPLE_FILES[0]) => {
    const encoder = new TextEncoder();
    const data = encoder.encode(sample.text);
    setActiveFile({
      name: sample.name,
      size: data.length,
      data
    });
    // Clear retransmission constraints when changing file
    setRetransmitFrames(null);
  };

  // Compile frames whenever activeFile or settings change
  useEffect(() => {
    if (!activeFile) return;
    let active = true;
    
    async function compile() {
      try {
        const generatedFrames = await packFileIntoFrames(activeFile.name, activeFile.data, settings);
        if (active) {
          setFrames(generatedFrames);
          setCurrentFrameIdx(0);
          setRetransmitFrames(null); // Reset missing packet constraints on raw datasets modifications
        }
      } catch (err: any) {
        console.error(err);
        if (active) {
          alert(err.message || 'Failed to encode dataset.');
        }
      }
    }
    
    compile();
    
    return () => {
      active = false;
    };
  }, [activeFile, settings.gridWidth, settings.gridHeight, settings.colorMode]);

  // Backward scanner webcam detector initialization
  useEffect(() => {
    if (isFeedbackScanning) {
      navigator.mediaDevices.enumerateDevices().then(devices => {
        const videoInputs = devices.filter(d => d.kind === 'videoinput');
        setSenderCameraDevices(videoInputs);
        if (videoInputs.length > 0 && !selectedSenderCamera) {
          setSelectedSenderCamera(videoInputs[0].deviceId);
        }
      }).catch(e => console.error('Enumerate cameras failed', e));
    }
  }, [isFeedbackScanning]);

  // Backward camera feed control
  useEffect(() => {
    let stream: MediaStream | null = null;
    if (isFeedbackScanning && selectedSenderCamera) {
      navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: selectedSenderCamera }, width: 320, height: 240 }
      }).then(s => {
        stream = s;
        if (feedbackVideoRef.current) {
          feedbackVideoRef.current.srcObject = s;
          feedbackVideoRef.current.play().catch(e => console.error(e));
        }
      }).catch(err => {
        setIsFeedbackScanning(false);
        console.error('Feedback camera streaming failure', err);
      });
    }

    return () => {
      if (stream) {
        stream.getTracks().forEach(t => t.stop());
      }
    };
  }, [isFeedbackScanning, selectedSenderCamera]);

  // Scan tickers
  useEffect(() => {
    if (isFeedbackScanning) {
      if (feedbackScanIntervalRef.current) clearInterval(feedbackScanIntervalRef.current);
      feedbackScanIntervalRef.current = setInterval(() => {
        captureAndScanFeedback();
      }, 150);
    } else {
      if (feedbackScanIntervalRef.current) {
        clearInterval(feedbackScanIntervalRef.current);
        feedbackScanIntervalRef.current = null;
      }
    }

    return () => {
      if (feedbackScanIntervalRef.current) clearInterval(feedbackScanIntervalRef.current);
    };
  }, [isFeedbackScanning, activeFile, frames]);

  const playFeedbackBeep = () => {
    try {
      if (!senderAudioCtxRef.current) {
        senderAudioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
      }
      const ctx = senderAudioCtxRef.current;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(1050, ctx.currentTime);
      gain.gain.setValueAtTime(0.06, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.15);
    } catch(e) {}
  };

  const captureAndScanFeedback = () => {
    const video = feedbackVideoRef.current;
    if (!video || video.readyState !== video.HAVE_CURRENT_DATA) return;

    const canvas = feedbackScanCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const code = jsQR(imgData.data, canvas.width, canvas.height);
    if (code) {
      try {
        const payload = JSON.parse(code.data);
        if (payload.type === 'OPFLK_RETRY' && typeof payload.salt === 'number' && Array.isArray(payload.missing)) {
          // Verify matches active file salt
          const matchingFrame = frames.find(f => f.fileSalt === payload.salt);
          if (matchingFrame) {
            setRetransmitFrames(payload.missing);
            playFeedbackBeep();
            setIsFeedbackScanning(false); // Disable scan loop upon capture
            setIsPlaying(true); // Auto-resume play for the selective frames
          }
        }
      } catch (e) {
        // Ignored parsed non-JSON barcodes
      }
    }
  };

  const getPlayableIndices = () => {
    if (retransmitFrames && retransmitFrames.length > 0) {
      return frames.map((_, i) => i).filter(i => retransmitFrames.includes(i));
    }
    return frames.map((_, i) => i);
  };

  // Handle Play/Pause timer loop
  useEffect(() => {
    if (isPlaying && frames.length > 1) {
      // Clear any existing timer
      if (playIntervalRef.current) clearInterval(playIntervalRef.current);
      
      const ms = 1000 / settings.frameRate;
      playIntervalRef.current = setInterval(() => {
        const playable = getPlayableIndices();
        if (playable.length === 0) return;
        
        setCurrentFrameIdx((prev) => {
          const loopIdx = playable.indexOf(prev);
          if (loopIdx === -1) {
            return playable[0]; // Jump to first playable frame if current one isn't in target subset
          }
          const nextLoopIdx = (loopIdx + 1) % playable.length;
          return playable[nextLoopIdx];
        });
      }, ms);
    } else {
      if (playIntervalRef.current) {
        clearInterval(playIntervalRef.current);
        playIntervalRef.current = null;
      }
    }

    return () => {
      if (playIntervalRef.current) clearInterval(playIntervalRef.current);
    };
  }, [isPlaying, frames.length, settings.frameRate, retransmitFrames]);

  // Render the current frame to canvas
  useEffect(() => {
    if (!canvasRef.current || frames.length === 0 || currentFrameIdx >= frames.length) return;

    const frame = frames[currentFrameIdx];
    const grid = createGridFromFrame(frame, settings);
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = settings.gridWidth;
    const h = settings.gridHeight;

    // Define pixel sizing
    // Target canvas rendering size e.g. 480x360
    const cellPixelSize = 12;
    const quietZone = 24; // clean border
    
    canvas.width = w * cellPixelSize + quietZone * 2;
    canvas.height = h * cellPixelSize + quietZone * 2;

    // Clear and draw white background (quiet zone)
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Disable smoothing to maintain super crisp grids for scanner sensors
    ctx.imageSmoothingEnabled = false;

    // Render grid
    for (let row = 0; row < h; row++) {
      for (let col = 0; col < w; col++) {
        const xOffset = quietZone + col * cellPixelSize;
        const yOffset = quietZone + row * cellPixelSize;
        
        const val = grid[row][col];
        // Calculate RGB levels: if channel bit of val is 1, channel is 0 (dark), else 255 (bright)
        const r = ((val >> 2) & 1) === 1 ? 0 : 255;
        const g = ((val >> 1) & 1) === 1 ? 0 : 255;
        const b = (val & 1) === 1 ? 0 : 255;
        
        ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
        ctx.fillRect(xOffset, yOffset, cellPixelSize, cellPixelSize);
      }
    }
  }, [currentFrameIdx, frames, settings]);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const result = event.target?.result;
      if (result instanceof ArrayBuffer) {
        setActiveFile({
          name: file.name,
          size: file.size,
          data: new Uint8Array(result)
        });
      }
    };
    reader.readAsArrayBuffer(file);
  };

  const downloadCanvasImage = () => {
    if (!canvasRef.current || frames.length === 0) return;
    const link = document.createElement('a');
    link.download = `Lumisend-Frame-${activeFile?.name || 'file'}-${currentFrameIdx + 1}.png`;
    link.href = canvasRef.current.toDataURL('image/png');
    link.click();
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const result = event.target?.result;
      if (result instanceof ArrayBuffer) {
        setActiveFile({
          name: file.name,
          size: file.size,
          data: new Uint8Array(result)
        });
      }
    };
    reader.readAsArrayBuffer(file);
  };

  const dataCap = getDataCapacityBytes(settings);
  const headerOverhead = 23;
  const payloadCap = dataCap - headerOverhead;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6" id="encoder-wrapper">
      {/* LEFT PANEL: CONFIG & UPLOADER (5 columns) */}
      <div className="lg:col-span-5 space-y-6" id="encoder-left">
        {/* SETTINGS MODULE */}
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-lg space-y-4" id="settings-card">
          <h3 className="text-slate-200 font-semibold text-sm flex items-center gap-2">
            <Settings className="w-4 h-4 text-slate-400" /> Grid Settings & Optimization
          </h3>

          <div className="grid grid-cols-2 gap-3" id="tuning-params">
            {/* RATIO FORMAT INDICATOR */}
            <div className="bg-slate-950 p-3 rounded-xl border border-slate-800/40 text-center flex flex-col justify-center">
              <p className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold">Aspect Ratio</p>
              <p className="text-lg font-bold text-slate-300 mt-1">4:3 format</p>
            </div>
            
            {/* CALCULATED DATA DENSITY */}
            <div className="bg-slate-950 p-3 rounded-xl border border-slate-800/40 text-center flex flex-col justify-center">
              <p className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold">Net Capacity</p>
              <p className="text-lg font-bold text-slate-300 mt-1">{payloadCap} bytes/f</p>
            </div>
          </div>

          {/* CHROME VS MONO OPTION SELECTOR */}
          <div className="space-y-1.5" id="color-encoding-setting">
            <label className="text-xs font-medium text-slate-400 flex items-center justify-between">
              <span>Color Transmission Profile</span>
              <span className="font-mono text-xs text-slate-400">
                {settings.colorMode === 'color' ? 'Color (3 bits/cell)' : 'Monochrome (1 bit/cell)'}
              </span>
            </label>
            <div className="grid grid-cols-2 gap-2" id="color-mode-picker">
              <button
                onClick={() => setSettings(prev => ({ ...prev, colorMode: 'mono' }))}
                className={`py-1.5 px-2 rounded-lg text-center font-medium text-xs border transition-all ${
                  settings.colorMode !== 'color'
                    ? 'bg-slate-800 text-slate-100 border-slate-700 font-bold'
                    : 'bg-slate-950/60 text-slate-400 border-slate-900 hover:bg-slate-800/20'
                }`}
                id="mono-mode-btn"
              >
                Monochrome
              </button>
              <button
                onClick={() => setSettings(prev => ({ ...prev, colorMode: 'color' }))}
                className={`py-1.5 px-2 rounded-lg text-center font-medium text-xs border transition-all flex items-center justify-center gap-1.5 ${
                  settings.colorMode === 'color'
                    ? 'bg-slate-800 text-slate-100 border-slate-700 font-bold'
                    : 'bg-slate-950/60 text-slate-400 border-slate-900 hover:bg-slate-800/20'
                }`}
                id="color-mode-btn"
              >
                <span className="w-2 h-2 rounded-full bg-slate-400 animate-pulse" />
                Color (3x Speed)
              </button>
            </div>
          </div>

          {/* GRID DENSITY SELECTOR */}
          <div className="space-y-1.5" id="grid-density-setting">
            <label className="text-xs font-medium text-slate-400 flex items-center justify-between">
              <span>Grid Size (Density)</span>
              <span className="font-mono text-xs text-slate-400">{settings.gridWidth} × {settings.gridHeight} ({settings.gridWidth * settings.gridHeight} cells)</span>
            </label>
            <div className="grid grid-cols-5 gap-1.5" id="grid-presets">
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
                  className={`py-1.5 px-1 text-center rounded-lg font-mono text-xs border transition-all ${
                    settings.gridWidth === p.w 
                      ? 'bg-slate-800 text-slate-100 border-slate-700' 
                      : 'bg-slate-950/60 text-slate-400 border-slate-900 hover:bg-slate-800/40'
                  }`}
                  id={`preset-btn-${idx}`}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <p className="text-[10px] text-slate-500 leading-normal">
              Larger dimensions increase payload capacity per frame, but require higher-quality receiver lenses and stability.
            </p>
          </div>

          {/* BROADCAST SPEED */}
          <div className="space-y-1.5" id="framerate-setting">
            <div className="flex justify-between items-center">
              <label className="text-xs font-medium text-slate-400">Broadcast Speed</label>
              <span className="font-mono text-xs text-slate-350 bg-slate-950 px-2 py-0.5 rounded border border-slate-800/80">{settings.frameRate} FPS ({(1000/settings.frameRate).toFixed(0)}ms/f)</span>
            </div>
            <input 
              type="range"
              min="1"
              max="15"
              step="1"
              value={settings.frameRate}
              onChange={(e) => setSettings(prev => ({ ...prev, frameRate: parseInt(e.target.value) }))}
              className="w-full accent-slate-400 h-1.5 bg-slate-950 rounded-lg appearance-none cursor-pointer"
              id="slider-fps"
            />
            <div className="flex justify-between text-[9px] text-slate-600 font-mono">
              <span>1 FPS (Slow)</span>
              <span>8 FPS (Standard)</span>
              <span>15 FPS (Fast)</span>
            </div>
          </div>
        </div>

        {/* SOURCE FILE */}
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-lg space-y-4" id="uploader-card">
          <h3 className="text-slate-200 font-semibold text-sm flex items-center gap-2">
            <Upload className="w-4 h-4 text-slate-300" /> Convert File to Light Grid
          </h3>
          
          {/* File input (hidden) */}
          <input 
            type="file" 
            ref={fileInputRef}
            onChange={handleFileUpload}
            className="hidden"
            id="hidden-file-input"
          />

          <div 
            onClick={() => fileInputRef.current?.click()}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
            className="border-2 border-dashed border-slate-800 hover:border-slate-600 hover:bg-slate-900 bg-slate-950/20 rounded-xl p-6 text-center cursor-pointer transition-all duration-200 group flex flex-col items-center justify-center gap-2"
            id="dropzone"
          >
            <div className="bg-slate-800 text-slate-300 p-3 rounded-full group-hover:scale-105 transition-transform">
              <Upload className="w-5 h-5" />
            </div>
            <div>
              <p className="text-sm font-medium text-slate-300">Click or Drag & Drop File</p>
              <p className="text-xs text-slate-500 mt-1">Accepts any file up to ~50 KB for smooth optical speed</p>
            </div>
          </div>

          {/* SAMPLES ROW */}
          <div className="space-y-2" id="samples-panel">
            <p className="text-[11px] font-semibold tracking-wider text-slate-500 uppercase">Try quick demo presets</p>
            <div className="grid grid-cols-3 gap-2" id="samples-buttons">
              {SAMPLE_FILES.map((sample, idx) => (
                <button
                  key={idx}
                  onClick={() => loadSampleFile(sample)}
                  className={`px-2.5 py-1.5 rounded-lg text-xs font-medium border text-left transition-all truncate flex items-center gap-1.5 ${
                    activeFile?.name === sample.name 
                      ? 'bg-slate-800 text-slate-200 border-slate-700' 
                      : 'bg-slate-950/60 text-slate-400 border-slate-900 hover:bg-slate-800/40'
                  }`}
                  id={`sample-btn-${idx}`}
                >
                  <FileText className="w-3.5 h-3.5 opacity-60 shrink-0" />
                  <span className="truncate">{sample.name.split('_')[0]}</span>
                </button>
              ))}
            </div>
          </div>

          {/* FILE DETAILS */}
          {activeFile && (
            <div className="bg-slate-950/80 border border-slate-800/60 p-3.5 rounded-xl flex items-center justify-between" id="active-file-card">
              <div className="flex items-center gap-3 truncate">
                <div className="w-10 h-10 bg-slate-800 border border-slate-700 rounded-lg flex items-center justify-center text-slate-300 shrink-0">
                  <span className="font-mono text-xs font-bold uppercase">{activeFile.name.split('.').pop() || 'file'}</span>
                </div>
                <div className="truncate">
                  <p className="text-xs font-semibold text-slate-200 truncate">{activeFile.name}</p>
                  <p className="text-[10px] font-mono text-slate-500 mt-0.5">{(activeFile.size / 1024).toFixed(2)} KB • {activeFile.size} Bytes</p>
                </div>
              </div>
              <div className="bg-slate-800 px-2 py-0.5 rounded border border-slate-700 text-[10px] text-slate-300 font-mono flex items-center gap-1 shrink-0">
                <CheckCircle2 className="w-3 h-3 text-slate-400" /> Encoded
              </div>
            </div>
          )}
        </div>

        {/* RECOVERY BACKWARD SCANNER CARD */}
        {activeFile && (
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-lg space-y-4" id="feedback-retry-scanner-card">
            <h3 className="text-slate-200 font-semibold text-sm flex items-center justify-between">
              <span className="flex items-center gap-2">
                <Camera className="w-4 h-4 text-slate-300" /> Backward Link Scanner
              </span>
              {retransmitFrames && (
                <span className="text-[10px] bg-slate-950 text-slate-200 px-2 py-0.5 rounded border border-slate-700 font-bold font-mono">
                  Subset Active
                </span>
              )}
            </h3>

            <p className="text-xs text-slate-400 leading-normal">
              If the Receiver phone missed some frames (due to lens flare or drops), display its feedback QR code to this camera to instantly retransmit ONLY the missing packets.
            </p>

            {isFeedbackScanning ? (
              <div className="space-y-3" id="sender-scanner-active-view">
                {/* VIDEO WRAPPER */}
                <div className="relative bg-slate-950 rounded-xl overflow-hidden aspect-[4/3] border border-slate-800 flex items-center justify-center max-h-[180px]">
                  <video 
                    ref={feedbackVideoRef}
                    className="w-full h-full object-cover scale-x-[-1]"
                    id="feedback-webcam-preview"
                    playsInline
                    muted
                  />
                  <canvas ref={feedbackScanCanvasRef} className="hidden" />
                  
                  {/* Subtle reticle scanning animation overlay */}
                  <div className="absolute inset-4 border border-slate-700/60 rounded-lg pointer-events-none flex items-center justify-center">
                    <div className="w-full h-[1px] bg-slate-400 absolute top-1/2 animate-bounce animate-duration-1000" />
                  </div>
                </div>

                {/* DEVICE PICKER IF MULTIPLE PRESENT */}
                {senderCameraDevices.length > 1 && (
                  <select
                    value={selectedSenderCamera}
                    onChange={(e) => setSelectedSenderCamera(e.target.value)}
                    className="w-full bg-slate-950 text-slate-300 text-xs rounded-xl p-2 border border-slate-850 focus:border-slate-600 outline-none"
                    id="sender-camera-picker"
                  >
                    {senderCameraDevices.map((d, index) => (
                      <option key={d.deviceId} value={d.deviceId}>
                        {d.label || `Camera ${index + 1}`}
                      </option>
                    ))}
                  </select>
                )}

                <button
                  onClick={() => setIsFeedbackScanning(false)}
                  className="w-full py-2 bg-slate-800 hover:bg-slate-755 text-slate-300 text-xs font-semibold rounded-xl border border-slate-700/50 transition-all flex items-center justify-center gap-1.5 cursor-pointer"
                  id="btn-stop-feedback-scan"
                >
                  <CameraOff className="w-3.5 h-3.5" /> Close Scanner Feed
                </button>
              </div>
            ) : (
              <div className="space-y-3" id="sender-scanner-idle-view">
                <button
                  onClick={() => setIsFeedbackScanning(true)}
                  className="w-full py-2.5 bg-slate-200 hover:bg-white text-slate-900 text-xs font-bold rounded-xl transition-all flex items-center justify-center gap-1.5 shadow cursor-pointer"
                  id="btn-start-feedback-scan"
                >
                  <Camera className="w-4 h-4 fill-current animate-pulse" /> Scan Receiver Recovery QR
                </button>

                {retransmitFrames && (
                  <div className="bg-slate-950 p-3 rounded-xl border border-slate-850 text-left space-y-2 animate-fade-in" id="sender-retransmit-report">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] text-slate-300 font-bold uppercase tracking-wider flex items-center gap-1">
                        <Sparkles className="w-3 h-3 text-slate-300 animate-pulse" /> Selective Sub-Loop Active
                      </span>
                      <button
                        onClick={() => setRetransmitFrames(null)}
                        className="text-[9px] text-zinc-400 hover:text-white font-bold font-mono cursor-pointer"
                        id="btn-remove-retransmit-subset"
                      >
                        Reset Loop
                      </button>
                    </div>

                    <p className="text-[11px] text-slate-400 leading-normal">
                      Currently broadcasting <strong>ONLY {retransmitFrames.length}</strong> missed frames.
                    </p>

                    <div className="flex flex-wrap gap-1 max-h-[80px] overflow-y-auto" id="missing-tags-badges">
                      {retransmitFrames.map(f => (
                        <span key={f} className="font-mono text-[9px] bg-slate-900 text-slate-300 border border-slate-800 px-1.5 py-0.5 rounded">
                          Part {f + 1}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* RIGHT PANEL: BROADCAST SCREEN (7 columns) */}
      <div className="lg:col-span-7 flex flex-col gap-6" id="encoder-right-content">
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-lg flex flex-col items-center justify-between flex-1 relative" id="broadcast-frame">
          <div className="w-full flex justify-between items-center border-b border-slate-800 pb-3" id="broadcast-header">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-full bg-slate-400 animate-pulse" /> 
                Optical Transmitter Screen
              </p>
              <p className="text-[10px] text-slate-500 font-mono mt-0.5">Alignment Indicator: L-pattern on Top-Left</p>
            </div>
            
            <div className="bg-slate-950/80 px-2.5 py-1 rounded-lg border border-slate-800/60 font-mono text-xs text-right" id="frame-statistics">
              <span className="text-slate-400">Frame </span> 
              <span className="text-slate-100 font-bold">{frames.length > 0 ? currentFrameIdx + 1 : 0}</span> 
              <span className="text-slate-600"> of </span> 
              <span className="text-slate-300 font-bold">{frames.length}</span>
            </div>
          </div>

          {/* VISUAL BROADCAST DISPLAY */}
          <div className="my-8 flex flex-col items-center justify-center p-4 bg-white rounded-xl border border-slate-700/50 shadow-inner relative max-w-full" id="broadcast-viewport">
            {/* L-Shape Guide helper marker on UI container for explanation */}
            <div className="absolute top-1 left-1 border-t-2 border-l-2 border-red-500 w-10 h-10 rounded-tl pointer-events-none opacity-0 hover:opacity-100 transition-opacity flex items-center justify-center">
              <span className="text-[8px] text-red-500 font-mono font-bold absolute top-1 left-2">Custom L</span>
            </div>

            <canvas 
              ref={canvasRef} 
              className="bg-white rounded-sm w-full max-w-[380px] aspect-[4/3]"
              id="transmitter-canvas"
            />
          </div>

          {/* CONTROLLER SECTION */}
          <div className="w-full space-y-4" id="broadcast-controls">
            {/* PROGRESS BAR */}
            {frames.length > 0 && (
              <div className="space-y-1" id="broadcast-progress">
                <div className="w-full bg-slate-950 rounded-full h-1.5 overflow-hidden">
                  <div 
                    className="bg-slate-400 h-full transition-all duration-150"
                    style={{ width: `${((currentFrameIdx + 1) / frames.length) * 100}%` }}
                  />
                </div>
                {frames.length > 1 && (
                  <div className="flex justify-between text-[10px] text-slate-500 font-mono bg-slate-950/40 p-1.5 rounded" id="stagger-frames-grid">
                    <span>File Loop Sequence</span>
                    <span className="text-slate-300 font-semibold">{isPlaying ? 'Broadcasting Loop...' : 'Loop Paused'}</span>
                  </div>
                )}
              </div>
            )}

            {/* BUTTON BAR */}
            <div className="flex flex-wrap items-center justify-between gap-3 pt-2" id="broadcast-actions">
              <div className="flex items-center gap-2" id="shuttle-controls">
                <button
                  disabled={frames.length <= 1}
                  onClick={() => setCurrentFrameIdx(prev => (prev - 1 + frames.length) % frames.length)}
                  className="p-2.5 rounded-xl bg-slate-800 text-slate-300 hover:bg-slate-750 disabled:opacity-30 disabled:cursor-not-allowed transition-all border border-slate-700/60"
                  title="Previous Frame"
                  id="btn-prev-frame"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                
                <button
                  disabled={frames.length <= 1}
                  onClick={() => setIsPlaying(!isPlaying)}
                  className={`px-5 py-2.5 rounded-xl font-medium flex items-center gap-2 border transition-all ${
                    isPlaying 
                      ? 'bg-slate-800 hover:bg-slate-700 text-slate-100 border-slate-700' 
                      : 'bg-slate-100 text-slate-950 font-semibold border-slate-300 hover:bg-white'
                  }`}
                  id="btn-play-pause"
                >
                  {isPlaying ? (
                    <>
                      <Pause className="w-4 h-4 fill-current" /> Pause Broadcast
                    </>
                  ) : (
                    <>
                      <Play className="w-4 h-4 fill-current" /> Broadcast Loop
                    </>
                  )}
                </button>

                <button
                  disabled={frames.length <= 1}
                  onClick={() => setCurrentFrameIdx(prev => (prev + 1) % frames.length)}
                  className="p-2.5 rounded-xl bg-slate-800 text-slate-300 hover:bg-slate-750 disabled:opacity-30 disabled:cursor-not-allowed transition-all border border-slate-700/60"
                  title="Next Frame"
                  id="btn-next-frame"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>

              <div className="flex items-center gap-2" id="export-controls">
                <button
                  disabled={frames.length === 0}
                  onClick={downloadCanvasImage}
                  className="px-4 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-750 text-slate-200 text-xs font-semibold flex items-center gap-2 border border-slate-700/40 transition-all"
                  title="Down current image"
                  id="btn-download-frame"
                >
                  <Download className="w-4 h-4" /> Save Frame PNG
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* DETAILS LOG & MATRIX */}
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-lg space-y-3 flex-shrink-0" id="encoder-footer">
          <div className="flex items-center justify-between border-b border-slate-800/80 pb-2.5" id="footer-details-header">
            <span className="text-xs font-semibold text-slate-300 uppercase tracking-wide flex items-center gap-1.5">
              <Binary className="w-4 h-4 text-slate-400" /> Live Data Stream
            </span>
            <span className="font-mono text-[10px] text-slate-500">Header: 0xEB90 Sync (CCITT-CRC16)</span>
          </div>
          
          <div className="bg-slate-950 p-3 rounded-lg border border-slate-800/60 text-left font-mono text-[10px] text-slate-300 overflow-x-auto max-h-[140px] whitespace-pre-wrap leading-relaxed animate-fade-in" id="binary-matrix-display">
            {frames.length > 0 && frames[currentFrameIdx] ? (
              <div id="bit-mesh-text">
                <div className="text-slate-400 mb-1 border-b border-slate-900 pb-1">
                  [Frame Metadata info] Index: {frames[currentFrameIdx].frameIndex} | Size: {frames[currentFrameIdx].payloadLength} bytes | Salt: {frames[currentFrameIdx].fileSalt} | Name: "{frames[currentFrameIdx].fileName}"
                </div>
                {Array.from(frames[currentFrameIdx].payload.slice(0, 48)).map((b) => (b as number).toString(2).padStart(8, '0')).join(' ')}
                {frames[currentFrameIdx].payload.length > 48 ? ' ... (remaining bytes packed)' : ''}
              </div>
            ) : (
              <div className="text-slate-600 italic">No bytes loaded. Upload or select a preset to generate.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

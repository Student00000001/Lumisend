import { CodeSettings, TransitFrame } from '../types';

/**
 * CRC16 Checksum generator (CCITT-FALSE standard)
 */
export function calculateCRC16(data: Uint8Array): number {
  let crc = 0xFFFF;
  for (let i = 0; i < data.length; i++) {
    crc ^= (data[i] << 8);
    for (let j = 0; j < 8; j++) {
      if ((crc & 0x8000) !== 0) {
        crc = ((crc << 1) ^ 0x1021) & 0xFFFF;
      } else {
        crc = (crc << 1) & 0xFFFF;
      }
    }
  }
  return crc;
}

/**
 * Sync words for identifying a valid Optical Link packet
 */
const SYNC_WORD = [0xEB, 0x90];

/**
 * Calculate how many data bytes can fit inside a grid of given settings
 */
export function getDataCapacityBytes(settings: CodeSettings): number {
  const totalCells = settings.gridWidth * settings.gridHeight;
  
  // Calculate reserved cells
  const topLeftReserved = 7 * 7;
  const topRightReserved = 3 * 3;
  const bottomLeftReserved = 3 * 3;
  const bottomRightReserved = 3 * 3;
  const reservedCells = topLeftReserved + topRightReserved + bottomLeftReserved + bottomRightReserved;
  
  const dataCells = totalCells - reservedCells;
  // Each byte is 8 bits. In color mode, each cell represents 3 bits.
  if (settings.colorMode === 'color') {
    return Math.floor((dataCells * 3) / 8);
  }
  return Math.floor(dataCells / 8);
}

/**
 * Convert a string to an ASCII byte array (truncated to max length)
 */
function stringToBytes(str: string, maxLength: number): Uint8Array {
  const cleanStr = str.replace(/[^\x00-\x7F]/g, ''); // ASCII only
  const bytes = new Uint8Array(maxLength);
  for (let i = 0; i < Math.min(cleanStr.length, maxLength); i++) {
    bytes[i] = cleanStr.charCodeAt(i);
  }
  return bytes;
}

/**
 * Convert a byte array containing ASCII back to string
 */
function bytesToString(bytes: Uint8Array): string {
  let result = '';
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0) break;
    result += String.fromCharCode(bytes[i]);
  }
  return result;
}

/**
 * Compresses raw data bytes using browser-native gzip CompressionStream
 */
export async function compressBytes(data: Uint8Array): Promise<Uint8Array> {
  try {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(data);
        controller.close();
      }
    });
    const compressionStream = new CompressionStream('gzip');
    const compressedStream = stream.pipeThrough(compressionStream);
    
    const reader = compressedStream.getReader();
    const chunks: Uint8Array[] = [];
    let totalLength = 0;
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        totalLength += value.length;
      }
    }
    
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  } catch (err) {
    console.warn('Gzip stream compression failed or not supported in this run state:', err);
    return data;
  }
}

/**
 * Decompresses raw data bytes using browser-native gzip DecompressionStream
 */
export async function decompressBytes(data: Uint8Array): Promise<Uint8Array> {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(data);
      controller.close();
    }
  });
  const decompressionStream = new DecompressionStream('gzip');
  const decompressedStream = stream.pipeThrough(decompressionStream);
  
  const reader = decompressedStream.getReader();
  const chunks: Uint8Array[] = [];
  let totalLength = 0;
  
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      totalLength += value.length;
    }
  }
  
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

/**
 * Split raw file data into packets (frames) designed to fit in specified grid capacity
 */
export async function packFileIntoFrames(
  fileName: string,
  fileData: Uint8Array,
  settings: CodeSettings
): Promise<TransitFrame[]> {
  // Compress the payload first using native gzip
  const compressed = await compressBytes(fileData);
  const useCompression = compressed.length < fileData.length;
  const dataToPack = useCompression ? compressed : fileData;
  const compressionFlag = useCompression ? 1 : 0;
  const originalFileSize = fileData.length;

  const totalCapacity = getDataCapacityBytes(settings);
  
  // Header 0 limit calculations
  const maxFilenameLength = Math.min(32, Math.max(1, totalCapacity - 20));
  const cleanFileName = fileName.replace(/[^\x00-\x7F]/g, '').slice(0, maxFilenameLength);
  const fileNameLength = cleanFileName.length;
  const header0Size = 15 + fileNameLength;
  const maxPayload0 = totalCapacity - header0Size - 2;

  // Header N limit calculations
  const headerNSize = 9;
  const maxPayloadN = totalCapacity - headerNSize - 2;
  
  if (maxPayload0 <= 0 || maxPayloadN <= 0) {
    throw new Error(`Grid size ${settings.gridWidth}x${settings.gridHeight} is too small to hold the header format.`);
  }

  const fileSalt = Math.floor(Math.random() * 250) + 1; // 1 to 250
  
  const frames: TransitFrame[] = [];
  let bytesPacked = 0;
  let remainingBytes = dataToPack.length;
  
  // Calculate total frames dynamically based on layout capacities
  let totalFrames = 1;
  if (remainingBytes > maxPayload0) {
    totalFrames += Math.ceil((remainingBytes - maxPayload0) / maxPayloadN);
  }
  
  // Pack Frame 0
  const p0Length = Math.min(remainingBytes, maxPayload0);
  const p0 = dataToPack.slice(0, p0Length);
  bytesPacked += p0Length;
  remainingBytes -= p0Length;
  
  frames.push({
    frameIndex: 0,
    totalFrames,
    fileSalt,
    payloadLength: p0Length,
    fileName: cleanFileName,
    payload: p0,
    checksum: 0,
    compressionFlag,
    originalFileSize
  });
  
  // Pack subsequent frames
  for (let i = 1; i < totalFrames; i++) {
    const pNLength = Math.min(remainingBytes, maxPayloadN);
    const pN = dataToPack.slice(bytesPacked, bytesPacked + pNLength);
    bytesPacked += pNLength;
    remainingBytes -= pNLength;
    
    frames.push({
      frameIndex: i,
      totalFrames,
      fileSalt,
      payloadLength: pNLength,
      fileName: cleanFileName,
      payload: pN,
      checksum: 0,
      compressionFlag,
      originalFileSize
    });
  }
  
  // Calculate CRC16 checksums for all frames
  for (const frame of frames) {
    const serialized = serializeFrame(frame, settings);
    frame.checksum = calculateCRC16(serialized.slice(0, serialized.length - 2));
    
    // Embed the checksum into the serialized stream so it gets verified later
    serialized[serialized.length - 2] = (frame.checksum >> 8) & 0xFF;
    serialized[serialized.length - 1] = frame.checksum & 0xFF;
  }
  
  return frames;
}

/**
 * Serialize a single frame info into a flat byte array
 */
export function serializeFrame(frame: TransitFrame, settings: CodeSettings): Uint8Array {
  const totalCapacity = getDataCapacityBytes(settings);
  const dataBytes = new Uint8Array(totalCapacity);
  
  // 1. Sync words
  dataBytes[0] = SYNC_WORD[0];
  dataBytes[1] = SYNC_WORD[1];
  
  // 2. Salt
  dataBytes[2] = frame.fileSalt;
  
  // 3. Multi-byte Frame Index (Big endian, 2 bytes)
  dataBytes[3] = (frame.frameIndex >> 8) & 0xFF;
  dataBytes[4] = frame.frameIndex & 0xFF;
  
  // 4. Multi-byte Total Frames (Big endian, 2 bytes)
  dataBytes[5] = (frame.totalFrames >> 8) & 0xFF;
  dataBytes[6] = frame.totalFrames & 0xFF;
  
  if (frame.frameIndex === 0) {
    // Frame 0 Metadata Header (15 bytes base overhead + filename)
    dataBytes[7] = frame.compressionFlag || 0;
    
    const size = frame.originalFileSize || 0;
    dataBytes[8] = (size >> 24) & 0xFF;
    dataBytes[9] = (size >> 16) & 0xFF;
    dataBytes[10] = (size >> 8) & 0xFF;
    dataBytes[11] = size & 0xFF;
    
    dataBytes[12] = (frame.payloadLength >> 8) & 0xFF;
    dataBytes[13] = frame.payloadLength & 0xFF;
    
    const cleanFileName = frame.fileName.replace(/[^\x00-\x7F]/g, '');
    const fileNameLen = Math.min(cleanFileName.length, 255);
    dataBytes[14] = fileNameLen;
    
    const nameBytes = stringToBytes(cleanFileName, fileNameLen);
    for (let i = 0; i < fileNameLen; i++) {
      dataBytes[15 + i] = nameBytes[i];
    }
    
    const payloadOffset = 15 + fileNameLen;
    for (let i = 0; i < frame.payloadLength; i++) {
      if (payloadOffset + i < totalCapacity - 2) {
        dataBytes[payloadOffset + i] = frame.payload[i];
      }
    }
  } else {
    // Subsequent frame: Payload offset starts at 9
    dataBytes[7] = (frame.payloadLength >> 8) & 0xFF;
    dataBytes[8] = frame.payloadLength & 0xFF;
    
    const payloadOffset = 9;
    for (let i = 0; i < frame.payloadLength; i++) {
      if (payloadOffset + i < totalCapacity - 2) {
        dataBytes[payloadOffset + i] = frame.payload[i];
      }
    }
  }
  
  // Checksum at the absolute end of grid payload capacity
  const crcOffset = totalCapacity - 2;
  dataBytes[crcOffset] = (frame.checksum >> 8) & 0xFF;
  dataBytes[crcOffset + 1] = frame.checksum & 0xFF;
  
  return dataBytes;
}

/**
 * Decode a serialized byte array back into a Frame
 */
export function deserializeFrame(data: Uint8Array, settings: CodeSettings): TransitFrame | null {
  const totalCapacity = getDataCapacityBytes(settings);
  if (data.length < totalCapacity) {
    return null;
  }
  
  // Verify sync word
  if (data[0] !== SYNC_WORD[0] || data[1] !== SYNC_WORD[1]) {
    return null;
  }
  
  const fileSalt = data[2];
  const frameIndex = (data[3] << 8) | data[4];
  const totalFrames = (data[5] << 8) | data[6];
  
  if (totalFrames === 0 || frameIndex >= totalFrames) {
    return null;
  }
  
  const crcOffset = totalCapacity - 2;
  const receivedChecksum = (data[crcOffset] << 8) | data[crcOffset + 1];
  
  // Verify checksum on payload segment
  const bytesToVerify = data.slice(0, crcOffset);
  const computedChecksum = calculateCRC16(bytesToVerify);
  
  if (receivedChecksum !== computedChecksum) {
    return null; // CRC check failed
  }
  
  let payloadLength = 0;
  let fileName = '';
  let payload = new Uint8Array(0);
  let compressionFlag = 0;
  let originalFileSize = 0;
  
  if (frameIndex === 0) {
    // Decode Frame 0 Metapacket
    compressionFlag = data[7];
    originalFileSize = (data[8] << 24) | (data[9] << 16) | (data[10] << 8) | data[11];
    payloadLength = (data[12] << 8) | data[13];
    const fileNameLen = data[14];
    
    if (15 + fileNameLen + payloadLength > totalCapacity) {
      return null;
    }
    
    fileName = bytesToString(data.slice(15, 15 + fileNameLen));
    payload = data.slice(15 + fileNameLen, 15 + fileNameLen + payloadLength);
  } else {
    // Decode subsequent frame
    payloadLength = (data[7] << 8) | data[8];
    
    if (9 + payloadLength > totalCapacity) {
      return null;
    }
    
    payload = data.slice(9, 9 + payloadLength);
  }
  
  return {
    frameIndex,
    totalFrames,
    fileSalt,
    payloadLength,
    fileName,
    payload,
    checksum: receivedChecksum,
    compressionFlag,
    originalFileSize
  };
}

/**
 * Checks if a grid coordinate is part of reserved corner markings
 */
export function isReservedCell(
  x: number,
  y: number,
  w: number,
  h: number
): boolean {
  // Top-left corner: 7x7
  if (x < 7 && y < 7) return true;
  
  // Top-right corner: last 3 cols, first 3 rows
  if (x >= w - 3 && y < 3) return true;
  
  // Bottom-left corner: first 3 cols, last 3 rows
  if (x < 3 && y >= h - 3) return true;
  
  // Bottom-right corner: last 3 cols, last 3 rows
  if (x >= w - 3 && y >= h - 3) return true;
  
  return false;
}

/**
 * Convert a frame object into a 2D binary grid (0 or 1 integers)
 */
export function createGridFromFrame(
  frame: TransitFrame,
  settings: CodeSettings
): number[][] {
  const w = settings.gridWidth;
  const h = settings.gridHeight;
  
  // Initialize grid to 0 (white)
  const grid: number[][] = Array(h).fill(null).map(() => Array(w).fill(0));
  
  // 1. Draw custom alignment shapes
  
  // A. Top-left L-shape (Thick L pattern inside 7x7)
  // Forms a thick (2 cell) inverted L-shape on the top-left using 7 (Black) & 0 (White)
  for (let y = 0; y < 7; y++) {
    for (let x = 0; x < 7; x++) {
      if ((y < 2 && x < 7) || (x < 2 && y < 7)) {
        grid[y][x] = 7; // Black
      } else {
        grid[y][x] = 0; // White buffer space
      }
    }
  }
  
  // B. Top-right marker: 3x3 solid block of black pixels
  for (let y = 0; y < 3; y++) {
    for (let x = w - 3; x < w; x++) {
      grid[y][x] = 7;
    }
  }
  
  // C. Bottom-left marker: 3x3 solid block of black pixels
  for (let y = h - 3; y < h; y++) {
    for (let x = 0; x < 3; x++) {
      grid[y][x] = 7;
    }
  }
  
  // D. Bottom-right marker: 3x3 cross pattern to tell bottom-right apart
  for (let y = h - 3; y < h; y++) {
    for (let x = w - 3; x < w; x++) {
      const rx = x - (w - 3);
      const ry = y - (h - 3);
      if (rx === 1 || ry === 1) {
        grid[y][x] = 7;
      } else {
        grid[y][x] = 0;
      }
    }
  }
  
  // 2. Map data bytes to bits
  const serialized = serializeFrame(frame, settings);
  const bits: boolean[] = [];
  for (let i = 0; i < serialized.length; i++) {
    const byte = serialized[i];
    for (let bit = 7; bit >= 0; bit--) {
      bits.push(((byte >> bit) & 1) === 1);
    }
  }
  
  // 3. Write data cells with balanced spatial XOR masks to scatter contrast
  let bitIndex = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!isReservedCell(x, y, w, h)) {
        if (settings.colorMode === 'color') {
          // Packs 3 bits per cell mapped to Red, Green, Blue chromatic values
          let val = 0;
          for (let bitOfCell = 0; bitOfCell < 3; bitOfCell++) {
            const hasBit = bitIndex < bits.length ? bits[bitIndex] : false;
            const mask = (x + y + bitOfCell) % 2 === 0;
            const finalBit = hasBit !== mask;
            if (finalBit) {
              val |= (1 << (2 - bitOfCell));
            }
            bitIndex++;
          }
          grid[y][x] = val;
        } else {
          // Standard monochrome mode: 1 bit per cell
          if (bitIndex < bits.length) {
            const rawBit = bits[bitIndex] ? 1 : 0;
            const mask = (x + y) % 2 === 0 ? 1 : 0;
            grid[y][x] = (rawBit ^ mask) ? 7 : 0;
            bitIndex++;
          } else {
            grid[y][x] = (x + y) % 2 === 0 ? 7 : 0;
          }
        }
      }
    }
  }
  
  return grid;
}

function decodeFrameFromGridSingle(
  grid: number[][],
  settings: CodeSettings
): TransitFrame | null {
  const w = settings.gridWidth;
  const h = settings.gridHeight;
  
  if (grid.length < h || grid[0].length < w) {
    return null;
  }
  
  const bits: boolean[] = [];
  
  // Extract bits by applying inverse XOR mask
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!isReservedCell(x, y, w, h)) {
        const cellVal = grid[y][x];
        if (settings.colorMode === 'color') {
          // Chromatographic extraction (3 bits per color-coded cell)
          for (let bitOfCell = 0; bitOfCell < 3; bitOfCell++) {
            const valBit = ((cellVal >> (2 - bitOfCell)) & 1) === 1;
            const mask = (x + y + bitOfCell) % 2 === 0;
            bits.push(valBit !== mask);
          }
        } else {
          // Standard extraction (1 bit per cell): 0 to 3 are white/light, 4 to 7 are black/dark
          const isActive = cellVal >= 4;
          const mask = (x + y) % 2 === 0;
          bits.push(isActive !== mask);
        }
      }
    }
  }
  
  // Convert bits back to bytes
  const totalCapacity = getDataCapacityBytes(settings);
  const dataBytes = new Uint8Array(totalCapacity);
  
  for (let i = 0; i < totalCapacity; i++) {
    let byteVal = 0;
    for (let bit = 0; bit < 8; bit++) {
      const bitIdx = i * 8 + bit;
      if (bitIdx < bits.length && bits[bitIdx]) {
        byteVal |= (1 << (7 - bit));
      }
    }
    dataBytes[i] = byteVal;
  }
  
  // Reconstruct frame object
  return deserializeFrame(dataBytes, settings);
}

/**
 * Read the bits from an extracted 2D grid and reconstruct the flat byte stream
 */
export function decodeFrameFromGrid(
  grid: number[][],
  settings: CodeSettings
): TransitFrame | null {
  // 1. Try decoding the camera feed as-is
  const normalResult = decodeFrameFromGridSingle(grid, settings);
  if (normalResult) {
    return normalResult;
  }

  // 2. Try decoding with a horizontally reversed grid (for mirrored front-facing cameras)
  const mirroredGrid = grid.map(row => {
    const rx = [...row];
    rx.reverse();
    return rx;
  });
  
  return decodeFrameFromGridSingle(mirroredGrid, settings);
}

/**
 * Image processing helpers for decoding static image matrices
 */
export function extractGridFromImage(
  pixelData: Uint8ClampedArray,
  width: number,
  height: number,
  settings: CodeSettings,
  alignGuideX1: number, // percentage of scan area (0-1)
  alignGuideY1: number,
  alignGuideX2: number,
  alignGuideY2: number
): number[][] | null {
  const w = settings.gridWidth;
  const h = settings.gridHeight;
  
  // Step 1: Crop to the specified green overlay box
  const startX = Math.round(alignGuideX1 * width);
  const startY = Math.round(alignGuideY1 * height);
  const boxW = Math.round((alignGuideX2 - alignGuideX1) * width);
  const boxH = Math.round((alignGuideY2 - alignGuideY1) * height);
  
  if (boxW <= 10 || boxH <= 10 || startX < 0 || startY < 0 || startX + boxW > width || startY + boxH > height) {
    return null;
  }
  
  // Calculate independent R, G, B averages across target area for localized adaptive thresholding
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let sampleCount = 0;
  
  // Sub-sample grid for CPU speed
  const step = Math.max(1, Math.floor(boxW / 100));
  for (let y = startY; y < startY + boxH; y += step) {
    for (let x = startX; x < startX + boxW; x += step) {
      const idx = (y * width + x) * 4;
      sumR += pixelData[idx];
      sumG += pixelData[idx + 1];
      sumB += pixelData[idx + 2];
      sampleCount++;
    }
  }
  
  const thresholdR = sampleCount > 0 ? sumR / sampleCount : 128;
  const thresholdG = sampleCount > 0 ? sumG / sampleCount : 128;
  const thresholdB = sampleCount > 0 ? sumB / sampleCount : 128;
  
  // Sample a grid of cells using direct grid projection (w x h cells in ratio 4:3)
  const grid: number[][] = Array(h).fill(null).map(() => Array(w).fill(0));
  
  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      // Find center coordinate of this cell in the cropped box
      const cellCenterX = startX + Math.round(((col + 0.5) / w) * boxW);
      const cellCenterY = startY + Math.round(((row + 0.5) / h) * boxH);
      
      // Sample 3x3 filter of pixels to reject sensor noise
      let sumCellR = 0;
      let sumCellG = 0;
      let sumCellB = 0;
      let cellCount = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const px = cellCenterX + dx;
          const py = cellCenterY + dy;
          if (px >= 0 && px < width && py >= 0 && py < height) {
            const idx = (py * width + px) * 4;
            sumCellR += pixelData[idx];
            sumCellG += pixelData[idx + 1];
            sumCellB += pixelData[idx + 2];
            cellCount++;
          }
        }
      }
      
      const avgCellR = cellCount > 0 ? sumCellR / cellCount : 128;
      const avgCellG = cellCount > 0 ? sumCellG / cellCount : 128;
      const avgCellB = cellCount > 0 ? sumCellB / cellCount : 128;
      
      // Values below respective channel thresholds indicate color/active channel (subtractive light)
      const isRedActive = avgCellR < thresholdR;
      const isGreenActive = avgCellG < thresholdG;
      const isBlueActive = avgCellB < thresholdB;
      
      // Reconstruct cell value (0 to 7)
      grid[row][col] = (isRedActive ? 4 : 0) | (isGreenActive ? 2 : 0) | (isBlueActive ? 1 : 0);
    }
  }
  
  return grid;
}

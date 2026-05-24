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
  const topRightReserved = 7 * 7;
  const bottomLeftReserved = 7 * 7;
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
  
  // Top-right corner: 7x7
  if (x >= w - 7 && y < 7) return true;
  
  // Bottom-left corner: 7x7
  if (x < 7 && y >= h - 7) return true;
  
  // Bottom-right corner: 3x3
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
  
  // A. Top-left 7x7 concentric finder pattern
  for (let y = 0; y < 7; y++) {
    for (let x = 0; x < 7; x++) {
      if (x === 0 || x === 6 || y === 0 || y === 6) {
        grid[y][x] = 7; // Black outer border
      } else if (x === 1 || x === 5 || y === 1 || y === 5) {
        grid[y][x] = 0; // White separation gap
      } else {
        grid[y][x] = 7; // Black 3x3 core
      }
    }
  }
  
  // B. Top-right 7x7 concentric finder pattern
  for (let y = 0; y < 7; y++) {
    for (let x = w - 7; x < w; x++) {
      const rx = x - (w - 7);
      const ry = y;
      if (rx === 0 || rx === 6 || ry === 0 || ry === 6) {
        grid[y][x] = 7; // Black outer border
      } else if (rx === 1 || rx === 5 || ry === 1 || ry === 5) {
        grid[y][x] = 0; // White separation gap
      } else {
        grid[y][x] = 7; // Black 3x3 core
      }
    }
  }
  
  // C. Bottom-left 7x7 concentric finder pattern
  for (let y = h - 7; y < h; y++) {
    for (let x = 0; x < 7; x++) {
      const rx = x;
      const ry = y - (h - 7);
      if (rx === 0 || rx === 6 || ry === 0 || ry === 6) {
        grid[y][x] = 7; // Black outer border
      } else if (rx === 1 || rx === 5 || ry === 1 || ry === 5) {
        grid[y][x] = 0; // White separation gap
      } else {
        grid[y][x] = 7; // Black 3x3 core
      }
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
 * Detects the bounding box of a high-contrast card inside a given target region.
 * This is extremely useful for automatically locking onto the screen card bounds.
 */
export function detectHighContrastCard(
  pixelData: Uint8ClampedArray,
  width: number,
  height: number,
  startX: number,
  startY: number,
  boxW: number,
  boxH: number
): { x1: number; y1: number; x2: number; y2: number } | null {
  let minL = 255;
  let maxL = 0;
  
  // Sample a subset of pixels to find min and max luminance inside the target box
  const stepY = Math.max(1, Math.floor(boxH / 40));
  const stepX = Math.max(1, Math.floor(boxW / 40));
  
  for (let y = startY; y < startY + boxH; y += stepY) {
    for (let x = startX; x < startX + boxW; x += stepX) {
      if (x < 0 || x >= width || y < 0 || y >= height) continue;
      const idx = (y * width + x) * 4;
      const l = pixelData[idx] * 0.299 + pixelData[idx + 1] * 0.587 + pixelData[idx + 2] * 0.114;
      if (l < minL) minL = l;
      if (l > maxL) maxL = l;
    }
  }
  
  const contrast = maxL - minL;
  // If contrast is very low, there's no high contrast screen card aligned here
  if (contrast < 45) {
    return null;
  }
  
  // Find white/bright boundary of the codecard
  const brightThreshold = minL + contrast * 0.55;
  
  let minXInside = startX + boxW;
  let maxXInside = startX;
  let minYInside = startY + boxH;
  let maxYInside = startY;
  
  const scanStepY = Math.max(1, Math.floor(boxH / 80));
  const scanStepX = Math.max(1, Math.floor(boxW / 80));
  
  for (let y = startY; y < startY + boxH; y += scanStepY) {
    for (let x = startX; x < startX + boxW; x += scanStepX) {
      if (x < 0 || x >= width || y < 0 || y >= height) continue;
      const idx = (y * width + x) * 4;
      const l = pixelData[idx] * 0.299 + pixelData[idx + 1] * 0.587 + pixelData[idx + 2] * 0.114;
      if (l >= brightThreshold) {
        if (x < minXInside) minXInside = x;
        if (x > maxXInside) maxXInside = x;
        if (y < minYInside) minYInside = y;
        if (y > maxYInside) maxYInside = y;
      }
    }
  }
  
  const cardW = maxXInside - minXInside;
  const cardH = maxYInside - minYInside;
  
  // Ensure the detected card size is reasonable inside our guide reticle
  if (cardW > boxW * 0.25 && cardH > boxH * 0.25) {
    const padX = Math.round(cardW * 0.015);
    const padY = Math.round(cardH * 0.015);
    
    return {
      x1: Math.max(0, minXInside - padX) / width,
      y1: Math.max(0, minYInside - padY) / height,
      x2: Math.min(width - 1, maxXInside + padX) / width,
      y2: Math.min(height - 1, maxYInside + padY) / height
    };
  }
  
  return null;
}

/**
 * Quiet zone white border detection helper
 */
export function getQuietZoneBounds(
  pixelData: Uint8ClampedArray,
  width: number,
  height: number
): { x1: number; y1: number; x2: number; y2: number } | null {
  let minX = width;
  let maxX = 0;
  let minY = height;
  let maxY = 0;
  
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const r = pixelData[idx];
      const g = pixelData[idx + 1];
      const b = pixelData[idx + 2];
      
      // Match non-pure-white pixels (threshold of 235 on all RGB channels)
      if (r < 235 || g < 235 || b < 235) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  
  // If we detected a valid bordered box inside the whitespace boundaries
  if (minX <= maxX && minY <= maxY && (maxX - minX > 20) && (maxY - minY > 20)) {
    return {
      x1: Math.max(0, minX) / width,
      y1: Math.max(0, minY) / height,
      x2: Math.min(width - 1, maxX) / width,
      y2: Math.min(height - 1, maxY) / height
    };
  }
  return null;
}

/**
 * Highly optimized, spiraled scanning perturbations for active grid calibration (36 points)
 */
const JITTER_OFFSETS = [
  // 1. Tiny shifts
  { dx: -0.005, dy: 0, ds: 1.0 },
  { dx: 0.005, dy: 0, ds: 1.0 },
  { dx: 0, dy: -0.005, ds: 1.0 },
  { dx: 0, dy: 0.005, ds: 1.0 },

  // 2. Micro scales
  { dx: 0, dy: 0, ds: 0.99 },
  { dx: 0, dy: 0, ds: 1.01 },

  // 3. Small shifts
  { dx: -0.01, dy: 0, ds: 1.0 },
  { dx: 0.01, dy: 0, ds: 1.0 },
  { dx: 0, dy: -0.01, ds: 1.0 },
  { dx: 0, dy: 0.01, ds: 1.0 },

  // 4. Small scales
  { dx: 0, dy: 0, ds: 0.98 },
  { dx: 0, dy: 0, ds: 1.02 },

  // 5. Diagonals/asymmetrical micro
  { dx: -0.01, dy: -0.01, ds: 0.98 },
  { dx: 0.01, dy: 0.01, ds: 1.02 },
  { dx: -0.01, dy: 0.01, ds: 1.0 },
  { dx: 0.01, dy: -0.01, ds: 1.0 },

  // 6. Medium shifts
  { dx: -0.015, dy: 0, ds: 1.0 },
  { dx: 0.015, dy: 0, ds: 1.0 },
  { dx: 0, dy: -0.015, ds: 1.0 },
  { dx: 0, dy: 0.015, ds: 1.0 },

  // 7. Medium scales
  { dx: 0, dy: 0, ds: 0.97 },
  { dx: 0, dy: 0, ds: 1.03 },

  // 8. Diagonals medium
  { dx: -0.015, dy: -0.015, ds: 0.97 },
  { dx: 0.015, dy: 0.015, ds: 1.03 },

  // 9. Wider shifts for hands holding further back
  { dx: -0.02, dy: 0, ds: 1.0 },
  { dx: 0.02, dy: 0, ds: 1.0 },
  { dx: 0, dy: -0.02, ds: 1.0 },
  { dx: 0, dy: 0.02, ds: 1.0 },

  // 10. Wider scales
  { dx: 0, dy: 0, ds: 0.95 },
  { dx: 0, dy: 0, ds: 1.05 },
  { dx: 0, dy: 0, ds: 0.93 },
  { dx: 0, dy: 0, ds: 1.07 },

  // 11. Wider combo shifts & scales
  { dx: -0.02, dy: -0.02, ds: 0.95 },
  { dx: 0.02, dy: 0.02, ds: 1.05 },
  { dx: -0.02, dy: 0.02, ds: 0.97 },
  { dx: 0.02, dy: -0.02, ds: 0.97 }
];

/**
 * Image processing helpers for decoding static image matrices
 */
/**
 * Helper to perform bilinear interpolation of 4 quadrilateral points
 */
function lerp2D(
  TL: { x: number; y: number },
  TR: { x: number; y: number },
  BR: { x: number; y: number },
  BL: { x: number; y: number },
  u: number,
  v: number
): { x: number; y: number } {
  const x = (1 - u) * (1 - v) * TL.x + u * (1 - v) * TR.x + u * v * BR.x + (1 - u) * v * BL.x;
  const y = (1 - u) * (1 - v) * TL.y + u * (1 - v) * TR.y + u * v * BR.y + (1 - u) * v * BL.y;
  return { x, y };
}

/**
 * Evaluates a candidate point (cx, cy) to see how well it fits a concentric 7x7 finder pattern
 */
function evaluateFinderPatternScore(
  pixelData: Uint8ClampedArray,
  width: number,
  height: number,
  cx: number,
  cy: number,
  stepX: number,
  stepY: number
): number {
  let sumCore = 0, countCore = 0;
  let sumRing = 0, countRing = 0;
  let sumBorder = 0, countBorder = 0;
  
  const cX_r = Math.round(cx);
  const cY_r = Math.round(cy);
  if (cX_r >= 0 && cX_r < width && cY_r >= 0 && cY_r < height) {
    const cIdx = (cY_r * width + cX_r) * 4;
    const cl = pixelData[cIdx] * 0.299 + pixelData[cIdx + 1] * 0.587 + pixelData[cIdx + 2] * 0.114;
    sumCore += cl;
    countCore++;
  }
  
  const dirs = [
    { x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }
  ];
  
  for (const d of dirs) {
    // 1. Core region: sample at 0.5 and 1.0 step of cell distance from candidate center
    for (const dist of [0.5, 1.0]) {
      const px = Math.round(cx + d.x * dist * stepX);
      const py = Math.round(cy + d.y * dist * stepY);
      if (px >= 0 && px < width && py >= 0 && py < height) {
        const idx = (py * width + px) * 4;
        sumCore += pixelData[idx] * 0.299 + pixelData[idx+1] * 0.587 + pixelData[idx+2] * 0.114;
        countCore++;
      }
    }
    // 2. White separation ring: sample at 1.8 and 2.2 step
    for (const dist of [1.8, 2.2]) {
      const px = Math.round(cx + d.x * dist * stepX);
      const py = Math.round(cy + d.y * dist * stepY);
      if (px >= 0 && px < width && py >= 0 && py < height) {
        const idx = (py * width + px) * 4;
        sumRing += pixelData[idx] * 0.299 + pixelData[idx+1] * 0.587 + pixelData[idx+2] * 0.114;
        countRing++;
      }
    }
    // 3. Black outer border: sample at 3.0 and 3.4 step
    for (const dist of [3.0, 3.4]) {
      const px = Math.round(cx + d.x * dist * stepX);
      const py = Math.round(cy + d.y * dist * stepY);
      if (px >= 0 && px < width && py >= 0 && py < height) {
        const idx = (py * width + px) * 4;
        sumBorder += pixelData[idx] * 0.299 + pixelData[idx+1] * 0.587 + pixelData[idx+2] * 0.114;
        countBorder++;
      }
    }
  }
  
  if (countCore === 0 || countRing === 0 || countBorder === 0) return -Infinity;
  
  const avgCore = sumCore / countCore;
  const avgRing = sumRing / countRing;
  const avgBorder = sumBorder / countBorder;
  
  const ringCoreDiff = avgRing - avgCore;
  const ringBorderDiff = avgRing - avgBorder;
  
  if (ringCoreDiff < 12 || ringBorderDiff < 12) {
    return -Infinity;
  }
  
  return ringCoreDiff + ringBorderDiff;
}

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
  let startX = Math.round(alignGuideX1 * width);
  let startY = Math.round(alignGuideY1 * height);
  let boxW = Math.round((alignGuideX2 - alignGuideX1) * width);
  let boxH = Math.round((alignGuideY2 - alignGuideY1) * height);
  
  // Auto-detect and crop any outer quiet zone white border padding when scanning from full bounds (static file uploads)
  if (alignGuideX1 === 0 && alignGuideY1 === 0 && alignGuideX2 === 1 && alignGuideY2 === 1) {
    const qz = getQuietZoneBounds(pixelData, width, height);
    if (qz) {
      startX = Math.round(qz.x1 * width);
      startY = Math.round(qz.y1 * height);
      boxW = Math.round((qz.x2 - qz.x1) * width);
      boxH = Math.round((qz.y2 - qz.y1) * height);
    }
  }
  
  if (boxW <= 10 || boxH <= 10 || startX < 0 || startY < 0 || startX + boxW > width || startY + boxH > height) {
    return null;
  }
  
  // --- STAGE 2: ULTRA-PRECISION 4-CORNER BILINEAR AUTO-LOCATOR ---
  let minL = 255;
  let maxL = 0;
  const sampleStepX = Math.max(1, Math.floor(boxW / 40));
  const sampleStepY = Math.max(1, Math.floor(boxH / 40));
  for (let y = startY; y < startY + boxH; y += sampleStepY) {
    for (let x = startX; x < startX + boxW; x += sampleStepX) {
      if (x < 0 || x >= width || y < 0 || y >= height) continue;
      const idx = (y * width + x) * 4;
      const l = pixelData[idx] * 0.299 + pixelData[idx + 1] * 0.587 + pixelData[idx + 2] * 0.114;
      if (l < minL) minL = l;
      if (l > maxL) maxL = l;
    }
  }

  const contrast = maxL - minL;
  let useBilinearMapping = false;
  
  let gridTL = { x: 0, y: 0 };
  let gridTR = { x: 0, y: 0 };
  let gridBR = { x: 0, y: 0 };
  let gridBL = { x: 0, y: 0 };

  // --- STAGE 2.1: HIGH-SPEED CONCENTRIC FINDER PATTERN CORNER DETECTOR ---
  const cellW_approx = boxW / w;
  const cellH_approx = boxH / h;
  
  const estTL_x = startX + 3.5 * cellW_approx;
  const estTL_y = startY + 3.5 * cellH_approx;
  
  const estTR_x = startX + (w - 3.5) * cellW_approx;
  const estTR_y = startY + 3.5 * cellH_approx;
  
  const estBL_x = startX + 3.5 * cellW_approx;
  const estBL_y = startY + (h - 3.5) * cellH_approx;
  
  let bestTL_pf = { x: estTL_x, y: estTL_y, score: -Infinity };
  let bestTR_pf = { x: estTR_x, y: estTR_y, score: -Infinity };
  let bestBL_pf = { x: estBL_x, y: estBL_y, score: -Infinity };
  
  // Scan a local window of cells around the expected positions
  const searchRadiusX = Math.round(cellW_approx * 3.5);
  const searchRadiusY = Math.round(cellH_approx * 3.5);
  
  // Search for Top-Left Center
  for (let dy = -searchRadiusY; dy <= searchRadiusY; dy += 2) {
    for (let dx = -searchRadiusX; dx <= searchRadiusX; dx += 2) {
      const cx = estTL_x + dx;
      const cy = estTL_y + dy;
      if (cx >= startX && cx < startX + boxW && cy >= startY && cy < startY + boxH) {
        const score = evaluateFinderPatternScore(pixelData, width, height, cx, cy, cellW_approx, cellH_approx);
        if (score > bestTL_pf.score) {
          bestTL_pf = { x: cx, y: cy, score };
        }
      }
    }
  }
  
  // Search for Top-Right Center
  for (let dy = -searchRadiusY; dy <= searchRadiusY; dy += 2) {
    for (let dx = -searchRadiusX; dx <= searchRadiusX; dx += 2) {
      const cx = estTR_x + dx;
      const cy = estTR_y + dy;
      if (cx >= startX && cx < startX + boxW && cy >= startY && cy < startY + boxH) {
        const score = evaluateFinderPatternScore(pixelData, width, height, cx, cy, cellW_approx, cellH_approx);
        if (score > bestTR_pf.score) {
          bestTR_pf = { x: cx, y: cy, score };
        }
      }
    }
  }
  
  // Search for Bottom-Left Center
  for (let dy = -searchRadiusY; dy <= searchRadiusY; dy += 2) {
    for (let dx = -searchRadiusX; dx <= searchRadiusX; dx += 2) {
      const cx = estBL_x + dx;
      const cy = estBL_y + dy;
      if (cx >= startX && cx < startX + boxW && cy >= startY && cy < startY + boxH) {
        const score = evaluateFinderPatternScore(pixelData, width, height, cx, cy, cellW_approx, cellH_approx);
        if (score > bestBL_pf.score) {
          bestBL_pf = { x: cx, y: cy, score };
        }
      }
    }
  }
  
  // Threshold score for local pattern locking
  if (bestTL_pf.score >= 24 && bestTR_pf.score >= 24 && bestBL_pf.score >= 24) {
    const x_tl = bestTL_pf.x;
    const y_tl = bestTL_pf.y;
    const x_tr = bestTR_pf.x;
    const y_tr = bestTR_pf.y;
    const x_bl = bestBL_pf.x;
    const y_bl = bestBL_pf.y;
    
    // Affine scale coefficients
    const a = (x_tr - x_tl) / (w - 7);
    const b = (x_bl - x_tl) / (h - 7);
    const c = x_tl - a * 3.5 - b * 3.5;
    
    const d = (y_tr - y_tl) / (w - 7);
    const e = (y_bl - y_tl) / (h - 7);
    const f = y_tl - d * 3.5 - e * 3.5;
    
    // Extrapolate perfect outer boundary corners for bilinear sampler
    gridTL = { x: c, y: f };
    gridTR = { x: a * w + c, y: d * w + f };
    gridBR = { x: a * w + b * h + c, y: d * w + e * h + f };
    gridBL = { x: b * h + c, y: e * h + f };
    
    useBilinearMapping = true;
  } else if (contrast >= 40) {
    // --- STAGE 2.2: RECTANGULAR CARD AUTO-LOCATOR FALLBACK ---
    const brightThreshold = minL + contrast * 0.52;
    
    let bestTL = { x: startX + boxW, y: startY + boxH, score: Infinity };   // minimizes x + y
    let bestTR = { x: startX, y: startY + boxH, score: -Infinity };          // maximizes x - y
    let bestBR = { x: startX, y: startY, score: -Infinity };                 // maximizes x + y
    let bestBL = { x: startX + boxW, y: startY, score: Infinity };          // minimizes x - y

    const padBorderX = Math.max(4, Math.floor(boxW * 0.03));
    const padBorderY = Math.max(4, Math.floor(boxH * 0.03));
    const scanX1 = startX + padBorderX;
    const scanX2 = startX + boxW - padBorderX;
    const scanY1 = startY + padBorderY;
    const scanY2 = startY + boxH - padBorderY;

    let foundAny = false;
    for (let y = scanY1; y < scanY2; y += 2) {
      for (let x = scanX1; x < scanX2; x += 2) {
        if (x < 0 || x >= width || y < 0 || y >= height) continue;
        const idx = (y * width + x) * 4;
        const l = pixelData[idx] * 0.299 + pixelData[idx + 1] * 0.587 + pixelData[idx + 2] * 0.114;
        
        if (l >= brightThreshold) {
          let isSolid = true;
          const neighbors = [
            { dx: -2, dy: 0 }, { dx: 2, dy: 0 }, { dx: 0, dy: -2 }, { dx: 0, dy: 2 }
          ];
          for (const n of neighbors) {
            const nx = x + n.dx;
            const ny = y + n.dy;
            if (nx < 0 || nx >= width || ny < 0 || ny >= height) {
              isSolid = false;
              break;
            }
            const nidx = (ny * width + nx) * 4;
            const nl = pixelData[nidx] * 0.299 + pixelData[nidx + 1] * 0.587 + pixelData[nidx + 2] * 0.114;
            if (nl < brightThreshold) {
              isSolid = false;
              break;
            }
          }

          if (!isSolid) continue;
          foundAny = true;

          const scoreTL = x + y;
          const scoreTR = x - y;
          const scoreBR = x + y;
          const scoreBL = x - y;

          if (scoreTL < bestTL.score) bestTL = { x, y, score: scoreTL };
          if (scoreTR > bestTR.score) bestTR = { x, y, score: scoreTR };
          if (scoreBR > bestBR.score) bestBR = { x, y, score: scoreBR };
          if (scoreBL < bestBL.score) bestBL = { x, y, score: scoreBL };
        }
      }
    }

    const cardW = bestTR.x - bestTL.x;
    const cardH = bestBL.y - bestTL.y;

    if (foundAny && cardW > boxW * 0.18 && cardH > boxH * 0.18) {
      const padXFraction = 24 / (w * 12 + 48);
      const padYFraction = 24 / (h * 12 + 48);

      gridTL = lerp2D(bestTL, bestTR, bestBR, bestBL, padXFraction, padYFraction);
      gridTR = lerp2D(bestTL, bestTR, bestBR, bestBL, 1 - padXFraction, padYFraction);
      gridBR = lerp2D(bestTL, bestTR, bestBR, bestBL, 1 - padXFraction, 1 - padYFraction);
      gridBL = lerp2D(bestTL, bestTR, bestBR, bestBL, padXFraction, 1 - padYFraction);

      useBilinearMapping = true;
    }
  }

  // First, sample each cell's raw RGB parameters to use for cell-level local adaptive thresholding
  const cellR = Array(h).fill(null).map(() => new Float32Array(w));
  const cellG = Array(h).fill(null).map(() => new Float32Array(w));
  const cellB = Array(h).fill(null).map(() => new Float32Array(w));
  
  let globalSumR = 0;
  let globalSumG = 0;
  let globalSumB = 0;
  let cellCountTotal = 0;
  
  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      let cellCenterX = 0;
      let cellCenterY = 0;

      if (useBilinearMapping) {
        // Perspective-correct bilinear grid center projection
        const u = (col + 0.5) / w;
        const v = (row + 0.5) / h;
        const cellCenter = lerp2D(gridTL, gridTR, gridBR, gridBL, u, v);
        cellCenterX = Math.round(cellCenter.x);
        cellCenterY = Math.round(cellCenter.y);
      } else {
        // Classical linear fallback (assumes perfect camera alignment)
        cellCenterX = startX + Math.round(((col + 0.5) / w) * boxW);
        cellCenterY = startY + Math.round(((row + 0.5) / h) * boxH);
      }
      
      let sumCellR = 0;
      let sumCellG = 0;
      let sumCellB = 0;
      let pixelCount = 0;
      
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const px = cellCenterX + dx;
          const py = cellCenterY + dy;
          if (px >= 0 && px < width && py >= 0 && py < height) {
            const idx = (py * width + px) * 4;
            sumCellR += pixelData[idx];
            sumCellG += pixelData[idx + 1];
            sumCellB += pixelData[idx + 2];
            pixelCount++;
          }
        }
      }
      
      const avgCellR = pixelCount > 0 ? sumCellR / pixelCount : 128;
      const avgCellG = pixelCount > 0 ? sumCellG / pixelCount : 128;
      const avgCellB = pixelCount > 0 ? sumCellB / pixelCount : 128;
      
      cellR[row][col] = avgCellR;
      cellG[row][col] = avgCellG;
      cellB[row][col] = avgCellB;
      
      globalSumR += avgCellR;
      globalSumG += avgCellG;
      globalSumB += avgCellB;
      cellCountTotal++;
    }
  }
  
  const globalThresholdR = cellCountTotal > 0 ? globalSumR / cellCountTotal : 128;
  const globalThresholdG = cellCountTotal > 0 ? globalSumG / cellCountTotal : 128;
  const globalThresholdB = cellCountTotal > 0 ? globalSumB / cellCountTotal : 128;
  
  // Second, resolve local adaptive threshold values by comparing with adjacent cell neighborhoods
  const grid: number[][] = Array(h).fill(null).map(() => Array(w).fill(0));
  const WINDOW_SIZE = 11;
  const half = Math.floor(WINDOW_SIZE / 2);
  
  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      let localSumR = 0;
      let localSumG = 0;
      let localSumB = 0;
      let localCount = 0;
      let localMinR = 255;
      let localMaxR = 0;
      let localMinG = 255;
      let localMaxG = 0;
      let localMinB = 255;
      let localMaxB = 0;
      
      const rStart = Math.max(0, row - half);
      const rEnd = Math.min(h - 1, row + half);
      const cStart = Math.max(0, col - half);
      const cEnd = Math.min(w - 1, col + half);
      
      for (let r = rStart; r <= rEnd; r++) {
        for (let c = cStart; c <= cEnd; c++) {
          const vr = cellR[r][c];
          const vg = cellG[r][c];
          const vb = cellB[r][c];
          
          localSumR += vr;
          localSumG += vg;
          localSumB += vb;
          localCount++;
          
          if (vr < localMinR) localMinR = vr;
          if (vr > localMaxR) localMaxR = vr;
          if (vg < localMinG) localMinG = vg;
          if (vg > localMaxG) localMaxG = vg;
          if (vb < localMinB) localMinB = vb;
          if (vb > localMaxB) localMaxB = vb;
        }
      }
      
      const meanR = localSumR / localCount;
      const meanG = localSumG / localCount;
      const meanB = localSumB / localCount;
      
      const contrastR = localMaxR - localMinR;
      const contrastG = localMaxG - localMinG;
      const contrastB = localMaxB - localMinB;
      
      // Offset mean slightly downwards to cleanly handle noise threshold margins
      const thresholdR = contrastR > 18 ? (meanR - 4) : globalThresholdR;
      const thresholdG = contrastG > 18 ? (meanG - 4) : globalThresholdG;
      const thresholdB = contrastB > 18 ? (meanB - 4) : globalThresholdB;
      
      const avgCellR = cellR[row][col];
      const avgCellG = cellG[row][col];
      const avgCellB = cellB[row][col];
      
      if (settings.colorMode === 'mono') {
        const cellLuminance = (avgCellR * 0.299) + (avgCellG * 0.587) + (avgCellB * 0.114);
        const thresholdLuminance = (thresholdR * 0.299) + (thresholdG * 0.587) + (thresholdB * 0.114);
        
        const isActive = cellLuminance < thresholdLuminance;
        grid[row][col] = isActive ? 7 : 0;
      } else {
        const isRedActive = avgCellR < thresholdR;
        const isGreenActive = avgCellG < thresholdG;
        const isBlueActive = avgCellB < thresholdB;
        
        grid[row][col] = (isRedActive ? 4 : 0) | (isGreenActive ? 2 : 0) | (isBlueActive ? 1 : 0);
      }
    }
  }
  
  return grid;
}

export interface JitterResult {
  grid: number[][];
  frame: TransitFrame;
}

/**
 * Rapid auto-searching, calibration and CRC decoding interface using a 36-point search grid.
 * Accelerates locks and compensates for hand gestures, distances, and tilt.
 */
export function extractAndDecodeWithJitter(
  pixelData: Uint8ClampedArray,
  width: number,
  height: number,
  settings: CodeSettings,
  alignGuideX1: number,
  alignGuideY1: number,
  alignGuideX2: number,
  alignGuideY2: number
): JitterResult | null {
  let g_x1 = alignGuideX1;
  let g_y1 = alignGuideY1;
  let g_x2 = alignGuideX2;
  let g_y2 = alignGuideY2;

  // Utilize our real-time high-contrast white card locator inside the camera guide target!
  const targetX1 = Math.round(alignGuideX1 * width);
  const targetY1 = Math.round(alignGuideY1 * height);
  const targetBoxW = Math.round((alignGuideX2 - alignGuideX1) * width);
  const targetBoxH = Math.round((alignGuideY2 - alignGuideY1) * height);
  
  const autoPos = detectHighContrastCard(pixelData, width, height, targetX1, targetY1, targetBoxW, targetBoxH);
  if (autoPos) {
    g_x1 = autoPos.x1;
    g_y1 = autoPos.y1;
    g_x2 = autoPos.x2;
    g_y2 = autoPos.y2;
  } else if (alignGuideX1 === 0 && alignGuideY1 === 0 && alignGuideX2 === 1 && alignGuideY2 === 1) {
    const qz = getQuietZoneBounds(pixelData, width, height);
    if (qz) {
      g_x1 = qz.x1;
      g_y1 = qz.y1;
      g_x2 = qz.x2;
      g_y2 = qz.y2;
    }
  }

  // 1. Nominal attempt
  const baseGrid = extractGridFromImage(pixelData, width, height, settings, g_x1, g_y1, g_x2, g_y2);
  if (baseGrid) {
    const baseFrame = decodeFrameFromGrid(baseGrid, settings);
    if (baseFrame) {
      return { grid: baseGrid, frame: baseFrame };
    }
  }

  // 2. Active Jitter-seeking calibration loop
  const centerX = (g_x1 + g_x2) / 2;
  const centerY = (g_y1 + g_y2) / 2;
  const nominalW = g_x2 - g_x1;
  const nominalH = g_y2 - g_y1;

  for (const opt of JITTER_OFFSETS) {
    const newW = nominalW * opt.ds;
    const newH = nominalH * opt.ds;
    const newCenterX = centerX + opt.dx;
    const newCenterY = centerY + opt.dy;

    const p_x1 = Math.max(0, newCenterX - newW / 2);
    const p_y1 = Math.max(0, newCenterY - newH / 2);
    const p_x2 = Math.min(1, newCenterX + newW / 2);
    const p_y2 = Math.min(1, newCenterY + newH / 2);

    const candGrid = extractGridFromImage(pixelData, width, height, settings, p_x1, p_y1, p_x2, p_y2);
    if (candGrid) {
      const candFrame = decodeFrameFromGrid(candGrid, settings);
      if (candFrame) {
        return { grid: candGrid, frame: candFrame };
      }
    }
  }

  return null;
}

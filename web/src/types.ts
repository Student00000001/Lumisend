/**
 * Types and interfaces for the Optical File Link system
 */

export interface CodeSettings {
  gridWidth: number;   // Must be divisible by 4 (e.g., 32, 40, 48, 64)
  gridHeight: number;  // Must be divisible by 3 (e.g., 24, 30, 36, 48)
  frameRate: number;   // Frames per second to display when playing multiple frames (e.g., 5, 10, 15)
  colorMode?: 'mono' | 'color'; // Option to choose between Monochrome and Multi-color encoding
}

export interface FileMetadata {
  name: string;
  size: number;
  type: string;
  checksum: string; // CRC16 or general hash
}

export interface TransitFrame {
  frameIndex: number;
  totalFrames: number;
  fileSalt: number;
  payloadLength: number;
  fileName: string;
  payload: Uint8Array;
  checksum: number; // CRC16
  compressionFlag?: number; // 0 for raw, 1 for gzip
  originalFileSize?: number;
}

export interface ReceiverState {
  fileSalt: number;
  fileName: string;
  fileSize: number;
  fileType: string;
  totalFrames: number;
  receivedCount: number;
  completed: boolean;
  frames: { [key: number]: Uint8Array };
  compressionFlag?: number;
  originalFileSize?: number;
}

export interface LogMessage {
  id: string;
  time: string;
  type: 'info' | 'success' | 'warning' | 'error';
  text: string;
}

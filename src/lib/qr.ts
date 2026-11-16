import QRCode from "qrcode";
import { qrContent } from "./qr-format";

// Error correction H (~30% of the code can be lost) and the standard 4-module
// quiet zone: the ticket still scans from a cracked, dirty or dim screen.
// `scale` keeps every module a whole number of pixels, so edges stay sharp.
export function qrPng(token: string): Promise<Buffer> {
  return QRCode.toBuffer(qrContent(token), {
    type: "png",
    errorCorrectionLevel: "H",
    margin: 4,
    scale: 16,
  });
}

import QRCode from "qrcode";
import { qrContent } from "./qr-format";

export function qrPng(token: string): Promise<Buffer> {
  return QRCode.toBuffer(qrContent(token), {
    type: "png",
    errorCorrectionLevel: "M",
    width: 480,
    margin: 2,
  });
}
